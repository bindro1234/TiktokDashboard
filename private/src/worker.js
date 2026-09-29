// Private dashboard Worker: serves the page from ./public and a small JSON API.
// Every request (pages too) must carry a valid Cloudflare Access JWT; see access.js.
// Reads and writes the PRIVATE admin sheet (names) and reads the public data sheet,
// with the service account from the secret GOOGLE_SERVICE_ACCOUNT_B64.
// Never deletes rows: removing a student sets active=nee.

import CONFIG from "./config.json" with { type: "json" };
import { AccessError, verifyAccess } from "./access.js";
import { Sheets } from "./google.js";
import * as lib from "../public/lib.js";

const ACTIVITY_TAB = "activity_log";
const ACTIVITY_HEADER = ["timestamp", "email", "action", "details"];
const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "tiktok-beheer";
const RUNNING = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const FINALE_TAB = "finale";
const FINALE_HEADER = ["started_at", "started_by", "deadline", "status", "ended_at", "ended_by"];
const PUBLIC_FINALE_HEADER = ["started_at", "deadline", "status", "ended_at"]; // no emails: public sheet
const MIN_FINALE_MINUTES = 15;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
});

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function withHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx, fetch);
  },
  // Cloudflare Cron Trigger (wrangler.toml, every 5 min): the 2-hourly windows (backup for GitHub's
  // unreliable cron) and the 15-minute finale runs.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runSchedule(env, fetch, controller.scheduledTime).then(
      (r) => console.log(`schedule: ${r.action}${r.due?.length ? ` (${r.due.join(", ")})` : ""}`),
      (e) => console.log(`schedule failed: ${e.message}`)));
  },
};

/**
 * Start the collector workflow ("auto") when a collector window is open and still needs its run.
 * The collector itself decides again from run_log, so a double start (GitHub cron + this) costs nothing.
 * Returns what it did; only window keys and counts, never sheet contents.
 */
export async function runSchedule(env, fetchImpl = fetch, nowMs = Date.now()) {
  const sheets = new Sheets(env.GOOGLE_SERVICE_ACCOUNT_B64, fetchImpl);
  // Cheap check first: outside the 2-hourly windows only a live finale can need a run.
  const { run_log: values, [FINALE_TAB]: finaleValues } =
    await sheets.readTabs(CONFIG.sheets.adminId, ["run_log", FINALE_TAB]);
  const finale = lib.finaleState(lib.rowsToObjects(finaleValues), nowMs, CONFIG.finale.maxHours);
  if (!lib.openWindows(CONFIG, nowMs, finale).length) return { action: "no window open" };
  const due = lib.dueWindows(CONFIG, lib.rowsToObjects(values), nowMs, finale);
  if (!due.length) return { action: "windows already done", due };
  if (!env.GH_DISPATCH_TOKEN) return { action: "GH_DISPATCH_TOKEN missing", due };
  const gh = (path, init = {}) => fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28", "user-agent": "tiktok-beheer-worker",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const wf = CONFIG.workflows.collect;
  const runs = await gh(`/actions/workflows/${wf}/runs?per_page=5`);
  if (!runs.ok) throw new Error(`GitHub runs: HTTP ${runs.status}`);
  if (((await runs.json()).workflow_runs || []).some((r) => RUNNING.has(r.status))) {
    return { action: "collector already running", due };
  }
  const res = await gh(`/actions/workflows/${wf}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { command: "auto", dry_run: "false", handles: "" } }),
  });
  if (!res.ok) throw new Error(`GitHub dispatch: HTTP ${res.status}`);
  return { action: "collector started", due };
}

export async function handle(request, env, ctx, fetchImpl = fetch) {
  const url = new URL(request.url);
  let user;
  try {
    user = await verifyAccess(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }, fetchImpl);
  } catch (err) {
    if (!(err instanceof AccessError)) throw err;
    // Don't explain why to the caller; the reason is only useful when debugging the setup.
    const body = url.pathname.startsWith("/api/") ? JSON.stringify({ error: "Geen toegang" }) : "Geen toegang";
    return new Response(body, { status: 403, headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } });
  }
  if (!url.pathname.startsWith("/api/")) return withHeaders(await env.ASSETS.fetch(request));

  const api = new Api(env, user.email, fetchImpl, ctx);
  try {
    if (request.method === "POST") checkPost(request, url);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/data": return json(await api.data());
      case "GET /api/runs": return json(await api.runs());
      case "GET /api/post-history": return json(await api.postHistory());
      case "POST /api/refresh": return json(await api.refresh());
      case "POST /api/accounts": return json(await api.addAccount(await request.json()));
      case "POST /api/accounts/active": return json(await api.setActive(await request.json()));
      case "POST /api/log": return json(await api.logClient(await request.json()));
      case "POST /api/finale/start": return json(await api.finaleStart(await request.json()));
      case "POST /api/finale/deadline": return json(await api.finaleDeadline(await request.json()));
      case "POST /api/finale/stop": return json(await api.finaleStop(await request.json()));
      default: return json({ error: "Onbekende route" }, 404);
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.log(`api error on ${url.pathname}: ${err.message}`); // never includes sheet contents
    return json({ error: "Er ging iets mis op de server. Probeer het zo opnieuw." }, 500);
  }
}

// A cross-site form can't set custom headers or a JSON content type without a CORS preflight,
// which this Worker never allows: together with the Origin check this blocks CSRF.
function checkPost(request, url) {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "Verkeerde herkomst");
  if (request.headers.get(CSRF_HEADER) !== CSRF_VALUE) throw new HttpError(403, "Ontbrekende header");
  if (!String(request.headers.get("content-type") || "").startsWith("application/json")) {
    throw new HttpError(415, "Verwacht JSON");
  }
}

class Api {
  constructor(env, email, fetchImpl, ctx) {
    this.env = env;
    this.email = email;
    this.fetch = (...args) => fetchImpl(...args); // unbound call, see google.js
    this.ctx = ctx;
    this.sheets = new Sheets(env.GOOGLE_SERVICE_ACCOUNT_B64, fetchImpl);
    this.admin = CONFIG.sheets.adminId;
    this.dataId = CONFIG.sheets.dataId;
  }

  async log(action, details = "") {
    await this.sheets.ensureTab(this.admin, ACTIVITY_TAB, ACTIVITY_HEADER);
    await this.sheets.append(this.admin, ACTIVITY_TAB, [[nowIso(), this.email, action, String(details).slice(0, 500)]]);
  }

  async data() {
    const [admin, data] = await Promise.all([
      this.sheets.readTabs(this.admin, ["accounts", "run_log", ACTIVITY_TAB, FINALE_TAB]),
      this.sheets.readTabs(this.dataId, ["handles", "history", "posts_latest"]),
    ]);
    const accounts = lib.parseAccounts(lib.rowsToObjects(admin.accounts));
    const runLog = lib.rowsToObjects(admin.run_log);
    const activity = lib.rowsToObjects(admin[ACTIVITY_TAB]);
    const now = Date.now();
    const today = lib.localDay(now);

    // Log a visit once per person per day.
    const visited = activity.some((a) => a.email === this.email && a.action === "geopend"
      && lib.parseTs(a.timestamp) !== null && lib.localDay(lib.parseTs(a.timestamp)) === today);
    if (!visited) {
      const write = this.log("geopend").catch((e) => console.log(`activity log failed: ${e.message}`));
      if (this.ctx?.waitUntil) this.ctx.waitUntil(write); else await write;
    }

    const last = lib.lastProfilesRun(runLog);
    const tracked = accounts.filter((a) => a.tracked).length;
    const strip = ({ _row, ...rest }) => rest;
    const finaleRows = lib.rowsToObjects(admin[FINALE_TAB]);
    const finale = lib.finaleState(finaleRows, now, CONFIG.finale.maxHours);
    return {
      me: this.email,
      serverTime: now,
      config: {
        campaign: CONFIG.campaign, budget: CONFIG.budget, schedule: CONFIG.schedule,
        refreshNumOfPosts: CONFIG.refreshNumOfPosts, forceMinMinutes: CONFIG.forceMinMinutes,
        finale: CONFIG.finale,
      },
      finale: finale && { ...finale, row: undefined },
      // Any finale that really ran (not cancelled): hides the "start the finale" reminder.
      finaleHasRun: finaleRows.some((r) => ["active", "stopped"].includes(String(r.status))),
      accounts,
      handles: lib.rowsToObjects(data.handles).map(strip),
      history: lib.rowsToObjects(data.history).map(strip),
      posts: lib.rowsToObjects(data.posts_latest).map(strip),
      runLog: runLog.slice(-60).reverse().map(strip),
      activity: activity.slice(-80).reverse().map(strip),
      budget: lib.budget(CONFIG, runLog, tracked, now),
      lastProfilesRun: last,
    };
  }

  // Per-video history, loaded only for the Stijgers tab and student pages (it can be a few MB).
  // Compact: [video_id, epoch ms, views] per row.
  async postHistory() {
    const { post_history: values } = await this.sheets.readTabs(this.dataId, ["post_history"]);
    const rows = lib.rowsToObjects(values)
      .map((r) => [String(r.video_id), lib.parseTs(r.timestamp), lib.toNum(r.views) ?? 0])
      .filter((r) => r[1] !== null);
    return { rows };
  }

  async github(path, init = {}) {
    if (!this.env.GH_DISPATCH_TOKEN) throw new HttpError(503, "GH_DISPATCH_TOKEN ontbreekt in de Worker-secrets");
    const res = await this.fetch(`https://api.github.com/repos/${this.env.GITHUB_REPO}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.env.GH_DISPATCH_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "tiktok-beheer-worker",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (!res.ok) throw new HttpError(502, `GitHub gaf HTTP ${res.status}`);
    return res.status === 204 ? {} : res.json();
  }

  async runs() {
    const pick = (workflow) => this.github(`/actions/workflows/${workflow}/runs?per_page=6`).then((d) =>
      (d.workflow_runs || []).map((r) => ({
        workflow, status: r.status, conclusion: r.conclusion, event: r.event,
        created: r.created_at, url: r.html_url,
      })));
    const [force, collect] = await Promise.all([pick(CONFIG.workflows.force), pick(CONFIG.workflows.collect)]);
    return { runs: [...force, ...collect].sort((a, b) => (a.created < b.created ? 1 : -1)) };
  }

  async refresh() {
    const { run_log: values } = await this.sheets.readTabs(this.admin, ["run_log"]);
    const last = lib.lastProfilesRun(lib.rowsToObjects(values));
    if (last !== null) {
      const minutes = (Date.now() - last) / 60000;
      if (minutes < CONFIG.forceMinMinutes) {
        throw new HttpError(409, `De laatste profielrun was ${Math.floor(minutes)} min geleden. `
          + `Verversen kan weer over ${Math.ceil(CONFIG.forceMinMinutes - minutes)} min.`);
      }
    }
    const recent = await this.github(`/actions/workflows/${CONFIG.workflows.force}/runs?per_page=5`);
    if ((recent.workflow_runs || []).some((r) => RUNNING.has(r.status))) {
      throw new HttpError(409, "Er loopt al een verversing. Nieuwe cijfers komen over een paar minuten.");
    }
    await this.github(`/actions/workflows/${CONFIG.workflows.force}/dispatches`, {
      method: "POST", body: JSON.stringify({ ref: "main" }),
    });
    await this.log("nu verversen");
    return { ok: true, message: "Verversen gestart. Nieuwe cijfers staan er over ongeveer 5–7 minuten." };
  }

  async readAccounts() {
    const { accounts } = await this.sheets.readTabs(this.admin, ["accounts"]);
    if (!accounts.length) throw new HttpError(500, "Tabblad accounts niet gevonden");
    const header = accounts[0].map((h) => String(h).trim());
    for (const col of ["student_name", "tiktok_handle", "active"]) {
      if (!header.includes(col)) throw new HttpError(500, `Kolom ${col} ontbreekt in accounts`);
    }
    return { header, rows: lib.rowsToObjects(accounts) };
  }

  async addAccount(body) {
    const name = String(body?.name ?? "").trim().replace(/\s+/g, " ");
    const active = body?.active !== false;
    if (!name) throw new HttpError(400, "Vul een naam in.");
    if (name.length > 80) throw new HttpError(400, "Naam is te lang (max. 80 tekens).");
    const { handle, reason } = lib.normalizeHandle(body?.handle);
    if (!handle) throw new HttpError(400, `Handle: ${reason}.`);
    const { header, rows } = await this.readAccounts();
    for (const r of rows) {
      if (lib.normalizeHandle(r.tiktok_handle).handle !== handle) continue;
      const on = lib.parseActive(r.active);
      throw new HttpError(409, on === false
        ? `@${handle} staat al in rij ${r._row} (inactief). Activeer die rij in plaats van een nieuwe toe te voegen.`
        : `@${handle} staat al in rij ${r._row}.`);
    }
    const row = header.map((h) => ({ student_name: name, tiktok_handle: handle, active: active ? "ja" : "nee" })[h] ?? "");
    const res = await this.sheets.append(this.admin, "accounts", [row]);
    const range = res?.updates?.updatedRange || "";
    const rowNo = Number((range.match(/![A-Z]+(\d+)/) || [])[1]) || null;
    await this.log("leerling toegevoegd", `${name} @${handle}${active ? "" : " (inactief)"}${rowNo ? `, rij ${rowNo}` : ""}`);
    return { ok: true, handle, row: rowNo, message: `@${handle} toegevoegd. Wordt vanaf de volgende profielrun gevolgd.` };
  }

  async setActive(body) {
    const rowNo = Number(body?.row);
    const active = body?.active === true;
    const expected = lib.normalizeHandle(body?.handle).handle;
    if (!Number.isInteger(rowNo) || rowNo < 2 || !expected) throw new HttpError(400, "Ongeldig verzoek");
    const { header, rows } = await this.readAccounts();
    const target = rows.find((r) => r._row === rowNo);
    if (!target || lib.normalizeHandle(target.tiktok_handle).handle !== expected) {
      throw new HttpError(409, "De sheet is intussen veranderd. Laad de pagina opnieuw.");
    }
    if (active) {
      const other = rows.find((r) => r._row !== rowNo && lib.parseActive(r.active) === true
        && lib.normalizeHandle(r.tiktok_handle).handle === expected);
      if (other) throw new HttpError(409, `@${expected} is al actief in rij ${other._row}.`);
    }
    const col = String.fromCharCode(65 + header.indexOf("active"));
    await this.sheets.update(this.admin, "accounts", `${col}${rowNo}`, [[active ? "ja" : "nee"]]);
    await this.log(active ? "leerling geactiveerd" : "leerling gedeactiveerd",
      `${String(target.student_name ?? "").trim() || "(geen naam)"} @${expected}, rij ${rowNo}`);
    return { ok: true, message: `@${expected} is nu ${active ? "actief" : "inactief"}.` };
  }

  // ---------- finale ----------

  async finaleNow() {
    await this.sheets.ensureTab(this.admin, FINALE_TAB, FINALE_HEADER);
    const { [FINALE_TAB]: values, run_log: log, accounts } =
      await this.sheets.readTabs(this.admin, [FINALE_TAB, "run_log", "accounts"]);
    const now = Date.now();
    return {
      now,
      state: lib.finaleState(lib.rowsToObjects(values), now, CONFIG.finale.maxHours),
      runLog: lib.rowsToObjects(log),
      active: lib.parseAccounts(lib.rowsToObjects(accounts)).filter((a) => a.tracked).length,
    };
  }

  // "2026-10-26T16:00" (Amsterdam) -> epoch ms, checked against [earliest, latest].
  parseDeadline(text, earliest, latest) {
    const m = String(text || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
    if (!m) throw new HttpError(400, "Kies een datum en tijd voor de deadline.");
    const t = lib.amsMs(m[1], m[2]);
    const hhmm = (ms) => `${lib.localDay(ms)} ${lib.localTime(ms)}`;
    if (t < earliest) throw new HttpError(400, `De deadline moet na ${hhmm(earliest)} liggen.`);
    if (t > latest) throw new HttpError(400, `Een finale duurt maximaal ${CONFIG.finale.maxHours} uur: kies uiterlijk ${hhmm(latest)}.`);
    return t;
  }

  // The finale must fit in this month's budget, like every run (the collector checks each run again).
  checkBudget(runLog, active, runs, now) {
    const used = lib.monthUsage(runLog, now);
    const need = runs * active;
    if (used + need > CONFIG.budget.monthlyCap) {
      throw new HttpError(409, `Past niet in het budget: al ${used} van ${CONFIG.budget.monthlyCap} records gebruikt, `
        + `deze finale kost tot ${need} (${runs} runs × ${active} accounts). Kies een eerdere deadline of verhoog budget.monthly_cap.`);
    }
    return need;
  }

  async writePublicFinale(row) {
    await this.sheets.ensureTab(this.dataId, FINALE_TAB, PUBLIC_FINALE_HEADER);
    await this.sheets.update(this.dataId, FINALE_TAB, "A2", [row]);
  }

  async finaleStart(body) {
    const { now, state, runLog, active } = await this.finaleNow();
    if (state && state.phase === "live") throw new HttpError(409, "Er loopt al een finale.");
    const deadline = this.parseDeadline(body?.deadline, now + MIN_FINALE_MINUTES * 60e3,
      now + CONFIG.finale.maxHours * 3600e3);
    const runs = lib.finaleRuns(now, deadline, CONFIG.finale.everyMinutes);
    const need = this.checkBudget(runLog, active, runs, now);
    const start = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
    const end = new Date(deadline).toISOString().replace(/\.\d+Z$/, "Z");
    await this.sheets.append(this.admin, FINALE_TAB, [[start, this.email, end, "active", "", ""]]);
    await this.writePublicFinale([start, end, "active", ""]);
    await this.log("finale gestart", `deadline ${lib.localDay(deadline)} ${lib.localTime(deadline)}, `
      + `${runs} runs × ${active} accounts ≈ ${need} records`);
    // Start the first run right away instead of waiting for the timer (best effort).
    try {
      const wf = CONFIG.workflows.collect;
      const recent = await this.github(`/actions/workflows/${wf}/runs?per_page=5`);
      if (!(recent.workflow_runs || []).some((r) => RUNNING.has(r.status))) {
        await this.github(`/actions/workflows/${wf}/dispatches`, { method: "POST",
          body: JSON.stringify({ ref: "main", inputs: { command: "auto", dry_run: "false", handles: "" } }) });
      }
    } catch (err) {
      console.log(`finale: first run not started now (${err.message}); the timer starts it`);
    }
    return { ok: true, message: `Finale gestart tot ${lib.localTime(deadline)}. Elke ${CONFIG.finale.everyMinutes} minuten nieuwe cijfers.` };
  }

  async finaleDeadline(body) {
    const { now, state, runLog, active } = await this.finaleNow();
    if (!state || state.phase !== "live") throw new HttpError(409, "Er loopt geen finale.");
    const deadline = this.parseDeadline(body?.deadline, now + 5 * 60e3, state.start + CONFIG.finale.maxHours * 3600e3);
    if (deadline > state.end) this.checkBudget(runLog, active, lib.finaleRuns(now, deadline, CONFIG.finale.everyMinutes), now);
    const end = new Date(deadline).toISOString().replace(/\.\d+Z$/, "Z");
    await this.sheets.update(this.admin, FINALE_TAB, `C${state.row}`, [[end]]);
    await this.writePublicFinale([new Date(state.start).toISOString().replace(/\.\d+Z$/, "Z"), end, "active", ""]);
    await this.log("finale deadline gewijzigd",
      `van ${lib.localTime(state.end)} naar ${lib.localDay(deadline)} ${lib.localTime(deadline)}`);
    return { ok: true, message: `Nieuwe deadline: ${lib.localTime(deadline)}.` };
  }

  async finaleStop(body) {
    const cancel = body?.mode === "cancel";
    const { now, state } = await this.finaleNow();
    // Stop: only while it runs. Cancel: also afterwards, e.g. to take away an Eindstand started by mistake.
    if (!state || (!cancel && state.phase !== "live")) throw new HttpError(409, "Er loopt geen finale.");
    const at = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
    const status = cancel ? "cancelled" : "stopped";
    await this.sheets.update(this.admin, FINALE_TAB, `D${state.row}:F${state.row}`, [[status, at, this.email]]);
    await this.writePublicFinale([new Date(state.start).toISOString().replace(/\.\d+Z$/, "Z"),
      new Date(state.end).toISOString().replace(/\.\d+Z$/, "Z"), status, at]);
    await this.log(cancel ? "finale geannuleerd" : "finale gestopt", cancel ? "geen Eindstand" : `Eindstand vanaf ${lib.localTime(now)}`);
    return { ok: true, message: cancel ? "Finale geannuleerd: geen Eindstand, alles loopt weer gewoon door."
      : "Finale gestopt. De Eindstand staat vast op de laatste meting." };
  }

  async logClient(body) {
    const allowed = { export: "export gedownload" };
    const action = allowed[body?.action];
    if (!action) throw new HttpError(400, "Onbekende actie");
    await this.log(action, String(body?.details ?? "").slice(0, 200));
    return { ok: true };
  }
}
