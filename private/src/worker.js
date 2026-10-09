// Private dashboard Worker: serves the page from ./public and a small JSON API.
// Every request (pages too) must carry a valid Cloudflare Access JWT; see access.js.
// Reads and writes the PRIVATE admin sheet (names) and reads the public data sheet,
// with the service account from the secret GOOGLE_SERVICE_ACCOUNT_B64.
// Never deletes rows: removing a student sets active=nee.

import CONFIG from "./config.json" with { type: "json" };
import VERSION from "./version.json" with { type: "json" }; // the commit this Worker was built from (private/build.sh)
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
const TASKS_TAB = "dagopdrachten";
const TASKS_HEADER = ["date", "min_posts", "label", "active", "updated_at", "updated_by"];
const OUTLIERS_TAB = "outliers"; // public sheet: handles only
const IG_TABS = ["ig_handles", "ig_history", "ig_posts", "ig_baseline"]; // public sheet: Instagram, handles only
const OUTLIERS_HEADER = ["handle", "buiten_schaal", "updated_at"];
const SETTINGS_TAB = "settings"; // private sheet: key/value settings changed on Beheer (school hashtags, pull frequency per platform)
const SETTINGS_HEADER = ["key", "value", "updated_at", "updated_by"];
const MAX_TASK_POSTS = 20;

const SECURITY_HEADERS = {
  // The commit this Worker was built from, on every response (also "Geen toegang"). The deploy job reads it back
  // from /version to check that the live Worker is the one it just deployed.
  "x-deploy-commit": VERSION.commit,
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

// 0 -> A, 26 -> AA (sheet column letters).
const colName = (i) => (i >= 26 ? colName(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));

// The accounts column with the student's Instagram handle: instagram_handle, or the old hand-typed "Insta ".
const IG_COLUMN = "instagram_handle";
const igColumn = (header) => header.findIndex((h) => [IG_COLUMN, "insta"].includes(String(h).trim().toLowerCase()));

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/**
 * The config with the pull frequency chosen on Beheer (private settings tab, one row per platform) over the config.yaml
 * start value: the windows, the budget reservation and every "off" rule read the same setting as the collector does.
 * `values` = the raw rows of the settings tab (null when the tab doesn't exist yet).
 */
function effectiveConfig(values) {
  return lib.withFrequency(CONFIG, lib.frequencySettings(lib.parseSettings(lib.rowsToObjects(values)), CONFIG));
}

function withHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx, fetch);
  },
  // Cloudflare Cron Trigger (wrangler.toml, every 5 min): the profile windows of both platforms (backup for GitHub's
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
  // Cheap check first: outside the platforms' windows only a live finale can need a run.
  const { run_log: values, [FINALE_TAB]: finaleValues, [SETTINGS_TAB]: settingsValues } =
    await sheets.readTabs(CONFIG.sheets.adminId, ["run_log", FINALE_TAB, SETTINGS_TAB]);
  const cfg = effectiveConfig(settingsValues);   // the frequency chosen on Beheer, like the collector
  const finale = lib.finaleState(lib.rowsToObjects(finaleValues), nowMs, CONFIG.finale.maxHours);
  if (!lib.openWindows(cfg, nowMs, finale).length) return { action: "no window open" };
  const due = lib.dueWindows(cfg, lib.rowsToObjects(values), nowMs, finale);
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
  // The one path that answers without a login (Access has a Bypass rule for exactly this path, see README):
  // only the commit, nothing from the sheets.
  if (url.pathname === "/version" && (request.method === "GET" || request.method === "HEAD")) {
    return json({ commit: VERSION.commit });
  }
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
      case "POST /api/accounts/instagram": return json(await api.setInstagram(await request.json()));
      case "POST /api/log": return json(await api.logClient(await request.json()));
      case "POST /api/finale/start": return json(await api.finaleStart(await request.json()));
      case "POST /api/finale/deadline": return json(await api.finaleDeadline(await request.json()));
      case "POST /api/finale/stop": return json(await api.finaleStop(await request.json()));
      case "POST /api/outliers": return json(await api.setOutlier(await request.json()));
      case "POST /api/tasks": return json(await api.saveTask(await request.json()));
      case "POST /api/settings/hashtags": return json(await api.saveSchoolHashtags(await request.json()));
      case "POST /api/settings/frequency": return json(await api.saveFrequency(await request.json()));
      case "POST /api/today/check": return json(await api.todayCheck());
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
      this.sheets.readTabs(this.admin, ["accounts", "run_log", ACTIVITY_TAB, FINALE_TAB, TASKS_TAB, SETTINGS_TAB]),
      this.sheets.readTabs(this.dataId, ["handles", "history", "posts_latest", OUTLIERS_TAB, ...IG_TABS]),
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
    const igTracked = accounts.filter((a) => a.instagramTracked).length;
    const strip = ({ _row, ...rest }) => rest;
    const finaleRows = lib.rowsToObjects(admin[FINALE_TAB]);
    const finale = lib.finaleState(finaleRows, now, CONFIG.finale.maxHours);
    const cfg = effectiveConfig(admin[SETTINGS_TAB]);
    return {
      me: this.email,
      serverTime: now,
      config: {
        campaign: CONFIG.campaign, budget: CONFIG.budget, schedule: cfg.schedule,
        refreshNumOfPosts: CONFIG.refreshNumOfPosts, forceMinMinutes: CONFIG.forceMinMinutes,
        finale: CONFIG.finale, offDays: CONFIG.offDays, todayCheck: CONFIG.todayCheck, signals: CONFIG.signals,
        // What applies now (the choice saved on Beheer, else the start value), the start value, and the steps (to
        // work out the cost of a choice on the page before it is saved).
        frequency: cfg.frequency, frequencyDefault: CONFIG.frequency, frequencySteps: CONFIG.frequencySteps,
        instagram: CONFIG.instagram,
      },
      finale: finale && { ...finale, row: undefined },
      // Any finale that really ran (not cancelled): hides the "start the finale" reminder.
      finaleHasRun: finaleRows.some((r) => ["active", "stopped"].includes(String(r.status))),
      accounts,
      handles: lib.rowsToObjects(data.handles).map(strip),
      history: lib.rowsToObjects(data.history).map(strip),
      posts: lib.rowsToObjects(data.posts_latest).map(strip),
      // Instagram (empty until the first Instagram run has created the tabs).
      igHandles: lib.rowsToObjects(data.ig_handles).map(strip),
      igHistory: lib.rowsToObjects(data.ig_history).map(strip),
      igPosts: lib.rowsToObjects(data.ig_posts).map(strip),
      igBaseline: lib.rowsToObjects(data.ig_baseline).map(strip),
      runLog: runLog.slice(-60).reverse().map(strip),
      activity: activity.slice(-80).reverse().map(strip),
      budget: lib.budget(cfg, runLog, { tiktok: tracked, instagram: igTracked }, now),
      // What the Schema preview on Beheer starts from (this page only gets the last rows of run_log): records used this
      // month and the windows of this month that are done.
      budgetBase: { used: lib.monthUsage(runLog, now), done: [...lib.doneWindows(runLog)].filter((k) => k.startsWith(today.slice(0, 7))) },
      lastProfilesRun: last,
      lastInstagramRun: lib.lastProfilesRun(runLog, lib.IG_PROFILE_RUN_TYPES),
      lastTodayCheck: lib.lastTodayCheck(runLog, activity),
      tasks: lib.parseAssignments(lib.rowsToObjects(admin[TASKS_TAB])),
      settings: { schoolHashtags: lib.schoolHashtags(lib.parseSettings(lib.rowsToObjects(admin[SETTINGS_TAB])), CONFIG.hashtags?.school),
        schoolHashtagsDefault: [...(CONFIG.hashtags?.school || [])] },
      outliers: [...lib.parseOutliers(lib.rowsToObjects(data[OUTLIERS_TAB]))],
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
    // "Nu verversen" refreshes TikTok and Instagram, each with its own cooldown (the collector checks again).
    // Refused here only when every platform that has accounts was refreshed less than forceMinMinutes ago.
    // A platform set to "off" on Beheer is skipped (the collector skips it too), and the page says so.
    const { run_log: values, accounts, [SETTINGS_TAB]: settingsValues } =
      await this.sheets.readTabs(this.admin, ["run_log", "accounts", SETTINGS_TAB]);
    const cfg = effectiveConfig(settingsValues);
    const runLog = lib.rowsToObjects(values);
    const igCount = lib.parseAccounts(lib.rowsToObjects(accounts)).filter((a) => a.instagramTracked).length;
    const tiktokOn = lib.platformOn(cfg, "tiktok"), igOn = lib.platformOn(cfg, "instagram");
    if (!tiktokOn && !(igOn && igCount)) {
      throw new HttpError(409, !igOn ? "TikTok en Instagram staan uit (Schema hieronder): er is niets om te verversen."
        : "TikTok staat uit (Schema hieronder) en er zijn geen Instagram-accounts: er is niets om te verversen.");
    }
    const lasts = [...(tiktokOn ? [lib.lastProfilesRun(runLog)] : []), ...(igOn && igCount ? [lib.lastProfilesRun(runLog, lib.IG_PROFILE_RUN_TYPES)] : [])];
    const minutes = lasts.map((t) => (t === null ? Infinity : (Date.now() - t) / 60000));
    if (minutes.every((m) => m < CONFIG.forceMinMinutes)) {
      const wait = Math.min(...minutes); // the platform that can be refreshed first
      throw new HttpError(409, `De laatste profielrun was ${Math.floor(wait)} min geleden. `
        + `Verversen kan weer over ${Math.ceil(CONFIG.forceMinMinutes - wait)} min.`);
    }
    const recent = await this.github(`/actions/workflows/${CONFIG.workflows.force}/runs?per_page=5`);
    if ((recent.workflow_runs || []).some((r) => RUNNING.has(r.status))) {
      throw new HttpError(409, "Er loopt al een verversing. Nieuwe cijfers komen over een paar minuten.");
    }
    await this.github(`/actions/workflows/${CONFIG.workflows.force}/dispatches`, {
      method: "POST", body: JSON.stringify({ ref: "main" }),
    });
    const skipped = [...(!tiktokOn ? ["TikTok"] : []), ...(!igOn && igCount ? ["Instagram"] : [])];
    const which = skipped.length ? ` (alleen ${tiktokOn ? "TikTok" : "Instagram"})` : igCount ? " (TikTok en Instagram)" : "";
    await this.log("nu verversen", skipped.length ? `${skipped.join(" en ")} stond uit: overgeslagen` : "");
    return { ok: true, message: `Verversen gestart${which}.${skipped.length ? ` ${skipped.join(" en ")} staat uit en wordt overgeslagen.` : ""} Nieuwe cijfers staan er over ongeveer 5–7 minuten.` };
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

  // A new student, or (body.main = their first account's handle) a second account of a student:
  // that row gets the student's name and main_account, and the sites add both accounts up.
  async addAccount(body) {
    let name = String(body?.name ?? "").trim().replace(/\s+/g, " ");
    const active = body?.active !== false;
    // TikTok and Instagram are both optional, but a student needs at least one (a second TikTok account needs TikTok).
    const tiktokGiven = String(body?.handle ?? "").trim() !== "";
    const igGiven = String(body?.instagram ?? "").trim() !== "";
    if (!tiktokGiven && !(igGiven && !body?.main)) {
      throw new HttpError(400, body?.main ? "Handle: lege handle." : "Vul een TikTok-handle of een Instagram-handle in.");
    }
    const { handle, reason } = tiktokGiven ? lib.normalizeHandle(body?.handle) : { handle: null, reason: null };
    if (tiktokGiven && !handle) throw new HttpError(400, `Handle: ${reason}.`);
    let instagram = null;
    if (igGiven) {
      const ig = lib.normalizeInstagramHandle(body.instagram);
      if (!ig.handle) throw new HttpError(400, `Instagram-handle: ${ig.reason}.`);
      if (body?.main) throw new HttpError(400, "Instagram hoort bij de leerling, niet bij een tweede TikTok-account.");
      instagram = ig.handle;
    }
    let { header, rows } = await this.readAccounts();
    let main = null;
    if (body?.main) {
      main = lib.normalizeHandle(body.main).handle;
      const owner = lib.parseAccounts(rows).find((a) => a.tracked && a.handle === main);
      if (!owner) throw new HttpError(409, `@${main} is geen actief account. Laad de pagina opnieuw.`);
      if (owner.main) throw new HttpError(409, `@${main} is zelf al een extra account; voeg het toe aan @${owner.main}.`);
      name = owner.name; // may be empty ("onbekend"), like the student's first row
    }
    if (!name && !main) throw new HttpError(400, "Vul een naam in.");
    if (name.length > 80) throw new HttpError(400, "Naam is te lang (max. 80 tekens).");
    for (const r of rows) {
      if (!handle || lib.normalizeHandle(r.tiktok_handle).handle !== handle) continue;
      const on = lib.parseActive(r.active);
      throw new HttpError(409, on === false
        ? `@${handle} staat al in rij ${r._row} (inactief). Activeer die rij in plaats van een nieuwe toe te voegen.`
        : `@${handle} staat al in rij ${r._row}.`);
    }
    if (instagram) this.checkInstagramFree(rows, instagram, null);
    if (main && !header.includes("main_account")) {
      // Older sheets: add the column at the end of the header row.
      await this.sheets.update(this.admin, "accounts", `${colName(header.length)}1`, [["main_account"]]);
      header = [...header, "main_account"];
    }
    if (instagram && igColumn(header) < 0) {
      await this.sheets.update(this.admin, "accounts", `${colName(header.length)}1`, [[IG_COLUMN]]);
      header = [...header, IG_COLUMN];
    }
    const cells = { student_name: name, tiktok_handle: handle || "", active: active ? "ja" : "nee", main_account: main || "" };
    const row = header.map((h, i) => (i === igColumn(header) ? instagram || "" : cells[h] ?? ""));
    const res = await this.sheets.append(this.admin, "accounts", [row]);
    const range = res?.updates?.updatedRange || "";
    const rowNo = Number((range.match(/![A-Z]+(\d+)/) || [])[1]) || null;
    if (main) {
      await this.log("account toegevoegd aan leerling", `${name}: @${handle} (bij @${main})${rowNo ? `, rij ${rowNo}` : ""}`);
      return { ok: true, handle, row: rowNo, message: `@${handle} toegevoegd als tweede account van ${name}. Wordt vanaf de volgende profielrun gevolgd; de weergaven tellen samen.` };
    }
    const accounts = [handle && `TikTok @${handle}`, instagram && `Instagram @${instagram}`].filter(Boolean).join(" + ");
    await this.log("leerling toegevoegd", `${name} ${accounts}${active ? "" : " (inactief)"}${rowNo ? `, rij ${rowNo}` : ""}`);
    return { ok: true, handle, instagram, row: rowNo,
      message: `${accounts} toegevoegd. Wordt vanaf de volgende profielrun gevolgd.` };
  }

  // One Instagram account per student: refuse a handle that another row already has (also an inactive one).
  checkInstagramFree(rows, instagram, exceptRow) {
    for (const r of rows) {
      if (r._row === exceptRow || lib.normalizeInstagramHandle(lib.instagramCell(r)).handle !== instagram) continue;
      const on = lib.parseActive(r.active);
      throw new HttpError(409, `Instagram @${instagram} staat al in rij ${r._row}${on === false ? " (inactief)" : ""}.`);
    }
  }

  // Set, change or clear (empty handle) the Instagram handle of a student, on the student's first row.
  async setInstagram(body) {
    const rowNo = Number(body?.row);
    if (!Number.isInteger(rowNo) || rowNo < 2) throw new HttpError(400, "Ongeldig verzoek");
    const raw = String(body?.handle ?? "").trim();
    let instagram = null;
    if (raw) {
      const ig = lib.normalizeInstagramHandle(raw);
      if (!ig.handle) throw new HttpError(400, `Instagram-handle: ${ig.reason}.`);
      instagram = ig.handle;
    }
    let { header, rows } = await this.readAccounts();
    const target = rows.find((r) => r._row === rowNo);
    const before = target ? lib.normalizeInstagramHandle(lib.instagramCell(target)).handle : null;
    if (!target || (before ?? "") !== String(body?.was ?? "")) {
      throw new HttpError(409, "De sheet is intussen veranderd. Laad de pagina opnieuw.");
    }
    if (String(target.main_account ?? "").trim()) {
      throw new HttpError(409, "Dit is een tweede TikTok-account. Zet de Instagram-handle bij de eerste rij van de leerling.");
    }
    if (instagram === before) return { ok: true, handle: instagram, message: "Ongewijzigd: de Instagram-handle stond er al zo." };
    if (instagram) this.checkInstagramFree(rows, instagram, rowNo);
    let col = igColumn(header);
    if (col < 0) {
      if (!instagram) return { ok: true, handle: null, message: "Er stond geen Instagram-handle." };
      col = header.length; // older sheet without the column: add it at the end of the header row
      await this.sheets.update(this.admin, "accounts", `${colName(col)}1`, [[IG_COLUMN]]);
    }
    await this.sheets.update(this.admin, "accounts", `${colName(col)}${rowNo}`, [[instagram ?? ""]]);
    const who = String(target.student_name ?? "").trim() || "(geen naam)";
    const action = !before ? "instagram-handle toegevoegd" : instagram ? "instagram-handle gewijzigd" : "instagram-handle verwijderd";
    await this.log(action, `${who}: ${before ? "@" + before : "geen"} → ${instagram ? "@" + instagram : "geen"}, rij ${rowNo}`);
    return { ok: true, handle: instagram, message: instagram
      ? `Instagram van ${who}: @${instagram} opgeslagen.` : `Instagram-handle van ${who} verwijderd.` };
  }

  async setActive(body) {
    const rowNo = Number(body?.row);
    const active = body?.active === true;
    // The row is identified by its TikTok handle, or (a student with only Instagram) by its Instagram handle.
    const expected = lib.normalizeHandle(body?.handle).handle;
    const expectedIg = expected ? null : lib.normalizeInstagramHandle(body?.instagram).handle;
    if (!Number.isInteger(rowNo) || rowNo < 2 || !(expected || expectedIg)) throw new HttpError(400, "Ongeldig verzoek");
    const { header, rows } = await this.readAccounts();
    const target = rows.find((r) => r._row === rowNo);
    const igOnly = (r) => !lib.normalizeHandle(r?.tiktok_handle).handle && lib.normalizeInstagramHandle(lib.instagramCell(r ?? {})).handle === expectedIg;
    if (!target || !(expected ? lib.normalizeHandle(target.tiktok_handle).handle === expected : igOnly(target))) {
      throw new HttpError(409, "De sheet is intussen veranderd. Laad de pagina opnieuw.");
    }
    const label = expected ? `@${expected}` : `Instagram @${expectedIg}`;
    if (active) {
      const other = rows.find((r) => r._row !== rowNo && lib.parseActive(r.active) === true
        && (expected ? lib.normalizeHandle(r.tiktok_handle).handle === expected : igOnly(r)));
      if (other) throw new HttpError(409, `${label} is al actief in rij ${other._row}.`);
    }
    const col = String.fromCharCode(65 + header.indexOf("active"));
    await this.sheets.update(this.admin, "accounts", `${col}${rowNo}`, [[active ? "ja" : "nee"]]);
    await this.log(active ? "leerling geactiveerd" : "leerling gedeactiveerd",
      `${String(target.student_name ?? "").trim() || "(geen naam)"} ${label}, rij ${rowNo}`);
    return { ok: true, message: `${label} is nu ${active ? "actief" : "inactief"}.` };
  }

  // ---------- finale ----------

  async finaleNow() {
    await this.sheets.ensureTab(this.admin, FINALE_TAB, FINALE_HEADER);
    const { [FINALE_TAB]: values, run_log: log, accounts, [SETTINGS_TAB]: settingsValues } =
      await this.sheets.readTabs(this.admin, [FINALE_TAB, "run_log", "accounts", SETTINGS_TAB]);
    const now = Date.now();
    const parsed = lib.parseAccounts(lib.rowsToObjects(accounts));
    return {
      now,
      state: lib.finaleState(lib.rowsToObjects(values), now, CONFIG.finale.maxHours),
      runLog: lib.rowsToObjects(log),
      // The finale runs each platform that is not set to "off", one record per account.
      cfg: effectiveConfig(settingsValues),
      counts: { tiktok: parsed.filter((a) => a.tracked).length, instagram: parsed.filter((a) => a.instagramTracked).length },
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
  checkBudget(runLog, counts, cfg, startMs, endMs) {
    const used = lib.monthUsage(runLog, startMs);   // the finale starts now
    const cost = lib.finaleCost(cfg, counts, startMs, endMs);
    if (!cost.total) throw new HttpError(409, "TikTok en Instagram staan uit (Schema hieronder): een finale heeft dan geen runs.");
    if (used + cost.total > CONFIG.budget.monthlyCap) {
      throw new HttpError(409, `Past niet in het budget: al ${used} van ${CONFIG.budget.monthlyCap} records gebruikt, `
        + `deze finale kost tot ${cost.total} (${this.finaleParts(cost, counts)}). Kies een eerdere deadline of verhoog budget.monthly_cap.`);
    }
    return cost;
  }

  // "96 Instagram-runs × 23 accounts + 2 TikTok-runs × 60 accounts" for the messages and the log.
  finaleParts(cost, counts) {
    return [cost.instagramRuns && `${cost.instagramRuns} runs × ${counts.instagram} Instagram-accounts`,
      cost.tiktokRuns && `${cost.tiktokRuns} runs × ${counts.tiktok} TikTok-accounts`].filter(Boolean).join(" + ");
  }

  async writePublicFinale(row) {
    await this.sheets.ensureTab(this.dataId, FINALE_TAB, PUBLIC_FINALE_HEADER);
    await this.sheets.update(this.dataId, FINALE_TAB, "A2", [row]);
  }

  async finaleStart(body) {
    const { now, state, runLog, cfg, counts } = await this.finaleNow();
    if (state && state.phase === "live") throw new HttpError(409, "Er loopt al een finale.");
    const deadline = this.parseDeadline(body?.deadline, now + MIN_FINALE_MINUTES * 60e3,
      now + CONFIG.finale.maxHours * 3600e3);
    const cost = this.checkBudget(runLog, counts, cfg, now, deadline);
    const start = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
    const end = new Date(deadline).toISOString().replace(/\.\d+Z$/, "Z");
    await this.sheets.append(this.admin, FINALE_TAB, [[start, this.email, end, "active", "", ""]]);
    await this.writePublicFinale([start, end, "active", ""]);
    await this.log("finale gestart", `deadline ${lib.localDay(deadline)} ${lib.localTime(deadline)}, `
      + `${this.finaleParts(cost, counts)} ≈ ${cost.total} records`);
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
    const { now, state, runLog, cfg, counts } = await this.finaleNow();
    if (!state || state.phase !== "live") throw new HttpError(409, "Er loopt geen finale.");
    const deadline = this.parseDeadline(body?.deadline, now + 5 * 60e3, state.start + CONFIG.finale.maxHours * 3600e3);
    if (deadline > state.end) this.checkBudget(runLog, counts, cfg, now, deadline);
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

  // ---------- buiten schaal (public sheet, handles only) ----------

  async setOutlier(body) {
    const { handle } = lib.normalizeHandle(body?.handle);
    const on = body?.on === true;
    if (!handle) throw new HttpError(400, "Ongeldige handle");
    const { accounts } = await this.sheets.readTabs(this.admin, ["accounts"]);
    if (!lib.parseAccounts(lib.rowsToObjects(accounts)).some((a) => a.tracked && a.handle === handle)) {
      throw new HttpError(409, `@${handle} wordt niet gevolgd.`);
    }
    await this.sheets.ensureTab(this.dataId, OUTLIERS_TAB, OUTLIERS_HEADER, CONFIG.fixedGids?.[OUTLIERS_TAB] ?? null);
    const { [OUTLIERS_TAB]: values } = await this.sheets.readTabs(this.dataId, [OUTLIERS_TAB]);
    const row = lib.rowsToObjects(values).find((r) => lib.normalizeHandle(r.handle).handle === handle);
    const cells = [handle, on ? "ja" : "nee", nowIso()];
    // One row per handle, updated in place (never deleted).
    if (row) await this.sheets.update(this.dataId, OUTLIERS_TAB, `A${row._row}:C${row._row}`, [cells]);
    else await this.sheets.append(this.dataId, OUTLIERS_TAB, [cells]);
    await this.log(on ? "buiten schaal aan" : "buiten schaal uit", `@${handle}`);
    return { ok: true, message: on ? `@${handle} staat nu buiten de schaal van de grafieken (plaats en cijfers blijven gelijk).`
      : `@${handle} telt weer mee in de schaal van de grafieken.` };
  }

  // ---------- dagopdrachten (private sheet) ----------

  async saveTask(body) {
    const action = body?.action;
    if (!["add", "edit", "remove"].includes(action)) throw new HttpError(400, "Onbekende actie");
    await this.sheets.ensureTab(this.admin, TASKS_TAB, TASKS_HEADER);
    const { [TASKS_TAB]: values } = await this.sheets.readTabs(this.admin, [TASKS_TAB]);
    const rows = lib.rowsToObjects(values);
    const active = lib.parseAssignments(rows);
    const at = nowIso();
    const short = (d) => `${Number(d.slice(8, 10))}-${Number(d.slice(5, 7))}`;
    let target = null;
    if (action !== "add") {
      const rowNo = Number(body?.row);
      target = active.find((a) => a.row === rowNo);
      if (!target || target.date !== body?.was) throw new HttpError(409, "De dagopdrachten zijn intussen veranderd. Laad de pagina opnieuw.");
    }
    if (action === "remove") {
      await this.sheets.update(this.admin, TASKS_TAB, `D${target.row}:F${target.row}`, [["nee", at, this.email]]);
      await this.log("dagopdracht verwijderd", `${target.date}: ${target.min} posts${target.label ? ` (${target.label})` : ""}`);
      return { ok: true, message: `Dagopdracht van ${short(target.date)} verwijderd.` };
    }
    const date = lib.sheetDate(body?.date);
    const min = Number(body?.min);
    const label = String(body?.label ?? "").trim().replace(/\s+/g, " ");
    if (!date || date < CONFIG.campaign.start || date > CONFIG.campaign.end) {
      throw new HttpError(400, `Kies een dag in de campagne (${CONFIG.campaign.start} t/m ${CONFIG.campaign.end}).`);
    }
    if (!Number.isInteger(min) || min < 2 || min > MAX_TASK_POSTS) throw new HttpError(400, `Minimum: een heel getal van 2 t/m ${MAX_TASK_POSTS}.`);
    if (label.length > 60) throw new HttpError(400, "Omschrijving is te lang (max. 60 tekens).");
    const clash = active.find((a) => a.date === date && (!target || a.row !== target.row));
    if (clash) throw new HttpError(409, `Er staat al een dagopdracht op ${short(date)}. Pas die aan.`);
    const cells = [date, min, label, "ja", at, this.email];
    if (action === "add") {
      await this.sheets.append(this.admin, TASKS_TAB, [cells]);
      await this.log("dagopdracht toegevoegd", `${date}: ${min} posts${label ? ` (${label})` : ""}`);
      return { ok: true, message: `Dagopdracht toegevoegd: ${short(date)}, minimaal ${min} posts.` };
    }
    await this.sheets.update(this.admin, TASKS_TAB, `A${target.row}:F${target.row}`, [cells]);
    await this.log("dagopdracht gewijzigd", `${target.date}: ${target.min} → ${date}: ${min} posts${label ? ` (${label})` : ""}`);
    return { ok: true, message: `Dagopdracht aangepast: ${short(date)}, minimaal ${min} posts.` };
  }

  // ---------- settings (private sheet, key/value) ----------

  // The school hashtags on the Hashtags tab. `tags` is the text as typed; `was` the list the page showed
  // (refused when someone else changed it meanwhile). One row (key school_hashtags) that is updated in place.
  async saveSchoolHashtags(body) {
    const { tags, invalid } = lib.parseTagList(body?.tags);
    if (invalid.length) {
      throw new HttpError(400, `Geen geldige hashtag: ${invalid.slice(0, 3).map((x) => `"${x.slice(0, 30)}"`).join(", ")}. Gebruik letters, cijfers en _ , zonder spaties of andere tekens.`);
    }
    if (tags.length > lib.MAX_SCHOOL_HASHTAGS) throw new HttpError(400, `Maximaal ${lib.MAX_SCHOOL_HASHTAGS} schoolhashtags.`);
    const { [SETTINGS_TAB]: values } = await this.sheets.readTabs(this.admin, [SETTINGS_TAB]);   // a missing tab reads as empty
    const settings = lib.parseSettings(lib.rowsToObjects(values));
    const current = lib.schoolHashtags(settings, CONFIG.hashtags?.school);
    if (body?.was !== undefined && lib.parseTagList(body.was).tags.join(" ") !== current.join(" ")) {
      throw new HttpError(409, "De lijst is intussen veranderd. Laad de pagina opnieuw.");
    }
    const text = (list) => (list.length ? list.map((t) => "#" + t).join(" ") : "(leeg)");
    if (tags.join(" ") === current.join(" ") && settings.has(lib.SCHOOL_HASHTAGS_KEY)) {
      return { ok: true, tags, message: `Schoolhashtags ongewijzigd: ${text(tags)}.` };
    }
    await this.sheets.ensureTab(this.admin, SETTINGS_TAB, SETTINGS_HEADER);   // only when something is really written
    const cells = [lib.SCHOOL_HASHTAGS_KEY, tags.join(" "), nowIso(), this.email];
    const saved = settings.get(lib.SCHOOL_HASHTAGS_KEY);
    if (saved?.row) await this.sheets.update(this.admin, SETTINGS_TAB, `A${saved.row}:D${saved.row}`, [cells]);
    else await this.sheets.append(this.admin, SETTINGS_TAB, [cells]);
    await this.log("schoolhashtags gewijzigd", `${text(current)} → ${text(tags)}`);
    return { ok: true, tags, message: `Schoolhashtags opgeslagen: ${text(tags)}.` };
  }

  // The pull frequency per platform (Beheer, Schema): one of Uit, 1× per dag, 12, 6, 4 or 2 uur, stored per platform in
  // the settings tab (frequency_tiktok, frequency_instagram) so it changes without a deploy. `was` = what the page
  // showed (refused when someone else changed it meanwhile). A choice whose month total doesn't fit under the cap is
  // refused, unless it doesn't raise the planned total (so a setting can always be lowered); the collector and the
  // backup timer read the same rows at each run. Every change goes in the activity log.
  async saveFrequency(body) {
    const choice = {};
    for (const p of lib.PLATFORMS) {
      choice[p] = lib.frequencyChoice(body?.[p], CONFIG);
      if (!choice[p]) throw new HttpError(400, `Kies voor ${lib.PLATFORM_NL[p]} Uit, 1× per dag of elke 12, 6, 4 of 2 uur.`);
    }
    const { [SETTINGS_TAB]: values, run_log: log, accounts, [FINALE_TAB]: finaleValues } =
      await this.sheets.readTabs(this.admin, [SETTINGS_TAB, "run_log", "accounts", FINALE_TAB]);   // a missing tab reads as empty
    const settings = lib.parseSettings(lib.rowsToObjects(values));
    const current = lib.withFrequency(CONFIG, lib.frequencySettings(settings, CONFIG)).frequency;
    if (body?.was && lib.PLATFORMS.some((p) => lib.frequencyChoice(body.was[p], CONFIG) !== current[p])) {
      throw new HttpError(409, "De instelling is intussen veranderd. Laad de pagina opnieuw.");
    }
    const changed = lib.PLATFORMS.filter((p) => choice[p] !== current[p]);
    const nl = (n) => Math.round(n).toLocaleString("nl-NL");
    if (!changed.length) return { ok: true, frequency: current, message: "Ongewijzigd: het schema was al zo." };
    const parsed = lib.parseAccounts(lib.rowsToObjects(accounts));
    const counts = { tiktok: parsed.filter((a) => a.tracked).length, instagram: parsed.filter((a) => a.instagramTracked).length };
    const now = Date.now();
    const finaleDone = lib.rowsToObjects(finaleValues).some((r) => ["active", "stopped"].includes(String(r.status)));
    const preview = lib.frequencyPreview(CONFIG, lib.budgetBase(lib.rowsToObjects(log), now), counts, now, choice, current, { finaleDone });
    if (!preview.allowed) {
      throw new HttpError(409, `Past niet in het budget: ${nl(preview.projected)} verwacht deze maand`
        + `${preview.refresh ? ` + ${nl(preview.refresh)} weekrefresh` : ""}${preview.finale ? ` + ${nl(preview.finale)} finale` : ""}`
        + ` = ${nl(preview.total)}, meer dan de limiet van ${nl(preview.cap)}. Kies een lagere frequentie.`);
    }
    await this.sheets.ensureTab(this.admin, SETTINGS_TAB, SETTINGS_HEADER);   // only when something is really written
    for (const p of changed) {
      const key = lib.FREQUENCY_KEYS[p];
      const cells = [key, choice[p], nowIso(), this.email];
      const saved = settings.get(key);
      if (saved?.row) await this.sheets.update(this.admin, SETTINGS_TAB, `A${saved.row}:D${saved.row}`, [cells]);
      else await this.sheets.append(this.admin, SETTINGS_TAB, [cells]);
    }
    const nlName = (step) => lib.FREQUENCY_NL[step];
    await this.log("frequentie gewijzigd", lib.PLATFORMS.map((p) => (changed.includes(p)
      ? `${lib.PLATFORM_NL[p]}: ${nlName(current[p])} → ${nlName(choice[p])}` : `${lib.PLATFORM_NL[p]}: ongewijzigd (${nlName(current[p])})`)).join("; ")
      + ` · verwacht ${nl(preview.projected)} van ${nl(preview.cap)} records deze maand`);
    return { ok: true, frequency: choice, projected: preview.projected,
      message: `Schema opgeslagen: ${lib.PLATFORMS.map((p) => `${lib.PLATFORM_NL[p]} ${nlName(choice[p])}`).join(", ")}. Verwacht ${nl(preview.projected)} van ${nl(preview.cap)} records deze maand.` };
  }

  // ---------- Vandaag: "Controleer nu" ----------

  async todayCheck() {
    const [admin, data] = await Promise.all([
      this.sheets.readTabs(this.admin, ["accounts", "run_log", ACTIVITY_TAB, TASKS_TAB, SETTINGS_TAB]),
      this.sheets.readTabs(this.dataId, ["handles", "posts_latest", "ig_handles", "ig_posts"]),
    ]);
    const now = Date.now();
    const cfg = effectiveConfig(admin[SETTINGS_TAB]);   // a platform set to "off" is skipped, like in the collector
    const runLog = lib.rowsToObjects(admin.run_log);
    const last = lib.lastTodayCheck(runLog, lib.rowsToObjects(admin[ACTIVITY_TAB]));
    const cool = CONFIG.todayCheck.cooldownMinutes;
    if (last !== null && now - last < cool * 60e3) {
      const left = Math.ceil(cool - (now - last) / 60e3);
      throw new HttpError(409, `De vorige controle was om ${lib.localTime(last)}. Controleren kan weer over ${left} min.`);
    }
    // The target list is made here, not taken from the page: active, not private, not done today.
    const accounts = lib.parseAccounts(lib.rowsToObjects(admin.accounts));
    const tracked = accounts.filter((a) => a.tracked);
    const info = new Map(lib.rowsToObjects(data.handles).map((h) => [String(h.handle), h]));
    const posts = new Map();
    for (const p of lib.rowsToObjects(data.posts_latest)) {
      const h = String(p.handle);
      if (!posts.has(h)) posts.set(h, []);
      posts.get(h).push(p);
    }
    // Per student (all their accounts together, TikTok and Instagram): one post on any account counts. The
    // check itself only fetches TikTok accounts for now; Instagram posts only decide who is done.
    const igInfo = new Map(lib.rowsToObjects(data.ig_handles).map((h) => [String(h.handle), h]));
    const igPosts = new Map();
    for (const p of lib.instagramPosts(lib.rowsToObjects(data.ig_posts))) {
      const h = String(p.handle);
      if (!igPosts.has(h)) igPosts.set(h, []);
      igPosts.get(h).push(p);
    }
    const students = [...lib.groupAccounts(accounts).values()].map((g) => ({
      handle: g.key, posts: [...g.accounts.flatMap((a) => posts.get(a.handle) || []), ...(g.instagram ? igPosts.get(g.instagram) || [] : [])],
      accounts: [...g.accounts.map((a) => ({ handle: a.handle, isPrivate: lib.truthy(info.get(a.handle)?.is_private) })),
        ...(g.instagram ? [{ handle: g.instagram, platform: "instagram", isPrivate: lib.truthy(igInfo.get(g.instagram)?.is_private) }] : [])],
    }));
    const status = lib.todayStatus(CONFIG, students, lib.parseAssignments(lib.rowsToObjects(admin[TASKS_TAB])), now);
    const targets = lib.todayTargets(status, cfg.frequency);
    const skipped = lib.todaySkipped(status, cfg.frequency).map((p) => lib.PLATFORM_NL[p]);
    const skipNote = skipped.length ? ` ${skipped.join(" en ")} staat uit en wordt overgeslagen.` : "";
    if (!targets.length) {
      throw new HttpError(409, skipped.length ? `Wat nog te controleren valt staat op ${skipped.join(" en ")}, en dat staat uit (Schema).`
        : "Iedereen die gecontroleerd kan worden heeft vandaag al gepost.");
    }
    const b = lib.budget(cfg, runLog, { tiktok: tracked.length, instagram: accounts.filter((a) => a.instagramTracked).length }, now);
    if (b.projected + targets.length > CONFIG.budget.monthlyCap) {
      throw new HttpError(409, `Past niet in het budget: ${b.used} gebruikt + ${b.reserved} nodig voor de resterende profielruns `
        + `+ ${targets.length} voor deze controle is meer dan ${CONFIG.budget.monthlyCap}.`);
    }
    const busy = await Promise.all([CONFIG.workflows.collect, CONFIG.workflows.force].map((wf) =>
      this.github(`/actions/workflows/${wf}/runs?per_page=5`).then((d) => (d.workflow_runs || []).some((r) => RUNNING.has(r.status)))));
    if (busy.some(Boolean)) throw new HttpError(409, "Er loopt al een ophaalrun. Probeer het over een paar minuten opnieuw.");
    await this.github(`/actions/workflows/${CONFIG.workflows.collect}/dispatches`, { method: "POST",
      body: JSON.stringify({ ref: "main", inputs: { command: "today", dry_run: "false", handles: targets.join(",") } }) });
    // One record per account on either platform. The collector fetches TikTok first, then Instagram.
    const split = lib.targetSplit(targets);
    const both = split.tiktok > 0 && split.instagram > 0;
    const parts = both ? ` (${split.tiktok} TikTok, ${split.instagram} Instagram)` : split.instagram ? " (Instagram)" : "";
    const accountsText = `${targets.length} account${targets.length === 1 ? "" : "s"}`;
    await this.log(lib.TODAY_CHECK_ACTION, `${accountsText}, ${targets.length} records${parts}${skipped.length ? `; ${skipped.join(" en ")} stond uit` : ""}`);
    return { ok: true, count: targets.length, startedAt: now, tiktok: split.tiktok, instagram: split.instagram,
      message: `Controle gestart voor ${accountsText}${parts} (${targets.length} records).${skipNote} `
        + `Nieuwe cijfers staan er over ongeveer ${both ? "5–10" : "5–7"} minuten; deze pagina ververst vanzelf zodra de run klaar is.` };
  }

  async logClient(body) {
    const allowed = { export: "export gedownload" };
    const action = allowed[body?.action];
    if (!action) throw new HttpError(400, "Onbekende actie");
    await this.log(action, String(body?.details ?? "").slice(0, 200));
    return { ok: true };
  }
}
