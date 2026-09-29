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
};

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
      case "POST /api/refresh": return json(await api.refresh());
      case "POST /api/accounts": return json(await api.addAccount(await request.json()));
      case "POST /api/accounts/active": return json(await api.setActive(await request.json()));
      case "POST /api/log": return json(await api.logClient(await request.json()));
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
      this.sheets.readTabs(this.admin, ["accounts", "run_log", ACTIVITY_TAB]),
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
    return {
      me: this.email,
      serverTime: now,
      config: {
        campaign: CONFIG.campaign, budget: CONFIG.budget, schedule: CONFIG.schedule,
        refreshNumOfPosts: CONFIG.refreshNumOfPosts, forceMinMinutes: CONFIG.forceMinMinutes,
      },
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

  async logClient(body) {
    const allowed = { export: "export gedownload" };
    const action = allowed[body?.action];
    if (!action) throw new HttpError(400, "Onbekende actie");
    await this.log(action, String(body?.details ?? "").slice(0, 200));
    return { ok: true };
  }
}
