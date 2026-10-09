// Worker tests with mocked Access, Google and GitHub (synthetic data only). Run: node --test private/test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { handle, runSchedule } from "../src/worker.js";
import { resetCertCache } from "../src/access.js";
import { resetTokenCache } from "../src/google.js";
import CONFIG from "../src/config.json" with { type: "json" };
import VERSION from "../src/version.json" with { type: "json" };
import * as lib from "../public/lib.js";

const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "test-aud-123";
const ORIGIN = "https://beheer.example.workers.dev";

// Access signing key (what Cloudflare would hold) and a fake Google service account.
const access = generateKeyPairSync("rsa", { modulusLength: 2048 });
const accessJwk = { ...access.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
const sa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_B64 = Buffer.from(JSON.stringify({
  client_email: "robot@example.iam.gserviceaccount.com",
  private_key: sa.privateKey.export({ format: "pem", type: "pkcs8" }),
})).toString("base64");

const b64url = (buf) => Buffer.from(buf).toString("base64url");
function token(claims = {}, { key = access.privateKey, kid = "k1" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64url(JSON.stringify({ aud: [AUD], iss: TEAM, email: "docent@school.nl", exp: now + 600, iat: now, ...claims }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key);
  return `${head}.${body}.${b64url(sig)}`;
}

// ---------- fake sheets + github ----------

let sheets, pub, calls;
// Both spreadsheets share `sheets`, except the public copy of the finale tab (`pub`).
const book = (id, tab) => (id === CONFIG.sheets.dataId && tab === "finale" ? pub : sheets);
function values(id, tab) {
  return book(id, tab)[tab] || null;
}
beforeEach(() => {
  resetCertCache();
  resetTokenCache();
  calls = [];
  const recent = new Date(Date.now() - 10 * 60000).toISOString();
  sheets = {
    accounts: [["student_name", "tiktok_handle", "active"], ["Anna", "@anna_1", "ja"], ["Bram", "bram.b", "nee"], ["", "chris", ""]],
    run_log: [["timestamp", "run_type", "window", "dry_run", "expected_records", "actual_records", "errors", "status", "snapshot_ids", "notes"],
      ["2026-09-29T05:00:00Z", "profiles", "x", false, 3, 3, 0, "ok", "sd_1", ""]],
    handles: [["handle", "is_private", "followers", "last_scraped", "last_status"], ["anna_1", false, 10, "", "ok"]],
    history: [["timestamp", "handle", "total_views", "followers", "campaign_likes", "campaign_posts"]],
    posts_latest: [["video_id", "handle", "created_at", "views"]],
  };
  sheets._recent = recent;
  pub = {};
});

async function fakeFetch(input, init = {}) {
  const url = new URL(String(input));
  const method = init.method || "GET";
  calls.push({ method, url: url.href, body: init.body });
  const ok = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });
  if (url.href === `${TEAM}/cdn-cgi/access/certs`) return ok({ keys: [accessJwk] });
  if (url.hostname === "oauth2.googleapis.com") return ok({ access_token: "g-token", expires_in: 3600 });
  if (url.hostname === "sheets.googleapis.com") {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer g-token");
    const path = decodeURIComponent(url.pathname);
    const id = path.match(/\/spreadsheets\/([^/:]+)/)[1];
    if (method === "GET" && /\/spreadsheets\/[^/]+$/.test(path)) {
      const titles = Object.keys(sheets).filter((t) => !t.startsWith("_") && (t !== "finale" || id !== CONFIG.sheets.dataId));
      if (id === CONFIG.sheets.dataId && pub.finale) titles.push("finale");
      return ok({ sheets: titles.map((title) => ({ properties: { title } })) });
    }
    if (path.endsWith("/values:batchGet")) {
      return ok({ valueRanges: url.searchParams.getAll("ranges").map((r) => ({ values: values(id, r.replace(/'/g, "")) || [] })) });
    }
    const m = path.match(/\/values\/'([^']+)'!([A-Z]+)(\d+)(?::[A-Z]+\d+)?(:append)?$/);
    if (m && m[4]) {
      const rows = JSON.parse(init.body).values;
      const tab = book(id, m[1])[m[1]];
      tab.push(...rows);
      return ok({ updates: { updatedRange: `'${m[1]}'!A${tab.length}:C${tab.length}` } });
    }
    if (m && method === "PUT") {
      const rows = JSON.parse(init.body).values;
      const col = m[2].charCodeAt(0) - 65;
      const tab = book(id, m[1])[m[1]];
      rows.forEach((row, i) => {
        const target = (tab[Number(m[3]) - 1 + i] ||= []);
        row.forEach((v, j) => { target[col + j] = v; });
      });
      return ok({});
    }
    if (path.endsWith(":batchUpdate")) {
      for (const r of JSON.parse(init.body).requests) {
        if (r.addSheet) book(id, r.addSheet.properties.title)[r.addSheet.properties.title] = [];
      }
      return ok({});
    }
    throw new Error(`unexpected sheets call ${method} ${path}`);
  }
  if (url.hostname === "api.github.com") {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer gh-test");
    if (url.pathname.endsWith("/dispatches")) return ok({}, 204);
    if (url.pathname.endsWith("/runs")) return ok({ workflow_runs: sheets._runs || [] });
  }
  throw new Error(`unexpected fetch ${method} ${url.href}`);
}

const ENV = {
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, GOOGLE_SERVICE_ACCOUNT_B64: SA_B64, GH_DISPATCH_TOKEN: "gh-test",
  GITHUB_REPO: "owner/repo",
  ASSETS: { fetch: async () => new Response("<html>page</html>", { headers: { "content-type": "text/html" } }) },
};

function req(path, { jwt = token(), method = "GET", body, headers = {} } = {}) {
  const h = new Headers(headers);
  if (jwt) h.set("Cf-Access-Jwt-Assertion", jwt);
  if (body !== undefined) {
    if (!h.has("content-type")) h.set("content-type", "application/json");
    if (!h.has("x-requested-with")) h.set("x-requested-with", "tiktok-beheer");
    if (!h.has("origin")) h.set("origin", ORIGIN);
  }
  return handle(new Request(ORIGIN + path, { method: body !== undefined ? "POST" : method, headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined }), ENV, null, fakeFetch);
}

// ---------- Access ----------

test("no token, bad tokens and a foreign key are all refused (pages and API)", async () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const bad = [
    null,
    "not.a.jwt",
    token({ aud: ["other-app"] }),
    token({ iss: "https://evil.cloudflareaccess.com" }),
    token({ exp: now - 3600 }),
    token({}, { key: other.privateKey }),
    token({}, { kid: "unknown" }),
    token({ email: "" }),
  ];
  for (const jwt of bad) {
    for (const path of ["/", "/api/data"]) {
      const res = await req(path, { jwt });
      assert.equal(res.status, 403, `${path} with ${jwt && jwt.slice(0, 20)}`);
      assert.doesNotMatch(await res.text(), /Anna/);
    }
  }
});

test("a valid token gets the page with security headers", async () => {
  const res = await req("/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /page/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

// ---------- commit stamp (deploy check) ----------

test("/version answers without a login with only the commit; every other response also carries it", async () => {
  assert.match(VERSION.commit, /^([0-9a-f]{40}|dev)$/);
  for (const method of ["GET", "HEAD"]) {
    const res = await req("/version", { jwt: null, method });
    assert.equal(res.status, 200, method);
    assert.equal(res.headers.get("x-deploy-commit"), VERSION.commit);
    assert.equal(res.headers.get("cache-control"), "no-store");
    if (method === "GET") assert.deepEqual(await res.json(), { commit: VERSION.commit });
  }
  // Nothing else opens up: other paths, other methods and sub-paths still need a login.
  for (const [path, method] of [["/", "GET"], ["/api/data", "GET"], ["/version/", "GET"], ["/version/x", "GET"], ["/version", "POST"]]) {
    const res = await req(path, { jwt: null, method });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.headers.get("x-deploy-commit"), VERSION.commit, `${method} ${path} carries the commit`);
  }
  // Logged in: pages and API carry it too.
  assert.equal((await req("/")).headers.get("x-deploy-commit"), VERSION.commit);
  assert.equal((await req("/api/runs")).headers.get("x-deploy-commit"), VERSION.commit);
});

// Workers' global fetch throws "Illegal invocation" when called with any `this` other than
// undefined/globalThis (e.g. stored as this.fetch and called as a method). Mimic that.
function strictThisFetch(input, init) {
  if (this !== undefined && this !== globalThis) {
    throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
  }
  return fakeFetch(input, init);
}

test("fetch is never called as a method (Illegal invocation on Workers)", async () => {
  const run = (path, opts = {}) => {
    const h = new Headers({ "Cf-Access-Jwt-Assertion": token(), ...(opts.body ? {
      "content-type": "application/json", "x-requested-with": "tiktok-beheer", origin: ORIGIN } : {}) });
    return handle(new Request(ORIGIN + path, { method: opts.body ? "POST" : "GET", headers: h,
      body: opts.body ? JSON.stringify(opts.body) : undefined }), ENV, null, strictThisFetch);
  };
  // Sheets (Google login + reads + activity log write), GitHub (runs, dispatch) and a sheet write.
  for (const [path, opts] of [["/api/data"], ["/api/runs"], ["/api/refresh", { body: {} }],
    ["/api/accounts", { body: { name: "Eva", handle: "eva.e" } }], ["/api/outliers", { body: { handle: "anna_1", on: true } }],
    ["/api/tasks", { body: { action: "add", date: CONFIG.campaign.start, min: 2 } }], ["/api/today/check", { body: {} }]]) {
    const res = await run(path, opts);
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
  }
});

// ---------- data ----------

test("/api/data returns names, flags problems and logs the first visit of the day", async () => {
  const res = await req("/api/data");
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.me, "docent@school.nl");
  assert.deepEqual(d.accounts.filter((a) => a.tracked).map((a) => [a.name, a.handle]), [["Anna", "anna_1"], ["", "chris"]]);
  assert.equal(d.budget.cap, CONFIG.budget.monthlyCap);
  assert.deepEqual(d.config.offDays, CONFIG.offDays); // the page needs it for streaks and "vrij" days
  assert.equal(sheets.activity_log.length, 2); // header + "geopend"
  assert.deepEqual(sheets.activity_log[1].slice(1, 3), ["docent@school.nl", "geopend"]);
  await req("/api/data");
  assert.equal(sheets.activity_log.length, 2, "only once per day");
});

// ---------- writes ----------

test("POST without the CSRF header or from another origin is refused", async () => {
  let res = await req("/api/refresh", { body: {}, headers: { "x-requested-with": "nope" } });
  assert.equal(res.status, 403);
  res = await req("/api/refresh", { body: {}, headers: { origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  assert.ok(!calls.some((c) => c.url.includes("dispatches")));
});

test("adding a student normalizes the handle and refuses duplicates", async () => {
  let res = await req("/api/accounts", { body: { name: " Dana  de Vries ", handle: "https://www.tiktok.com/@Dana.DV?lang=nl", active: true } });
  assert.equal(res.status, 200);
  assert.deepEqual(sheets.accounts.at(-1), ["Dana de Vries", "dana.dv", "ja"]);
  res = await req("/api/accounts", { body: { name: "X", handle: "@ANNA_1" } });
  assert.equal(res.status, 409);
  res = await req("/api/accounts", { body: { name: "X", handle: "bram.b" } });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /inactief/);
  res = await req("/api/accounts", { body: { name: "X", handle: "https://vm.tiktok.com/abc" } });
  assert.equal(res.status, 400);
  assert.equal(sheets.accounts.length, 5, "only Dana was added");
  assert.ok(sheets.activity_log.some((r) => r[2] === "leerling toegevoegd" && r[3].includes("@dana.dv")));
});

test("(de)activating sets active=ja/nee on the right row and never deletes", async () => {
  let res = await req("/api/accounts/active", { body: { row: 2, handle: "anna_1", active: false } });
  assert.equal(res.status, 200);
  assert.equal(sheets.accounts[1][2], "nee");
  res = await req("/api/accounts/active", { body: { row: 3, handle: "anna_1", active: true } }); // row 3 is bram
  assert.equal(res.status, 409);
  res = await req("/api/accounts/active", { body: { row: 3, handle: "bram.b", active: true } });
  assert.equal(res.status, 200);
  assert.equal(sheets.accounts[2][2], "ja");
  assert.equal(sheets.accounts.length, 4);
});

test("Nu verversen respects the cooldown and a running refresh, then dispatches", async () => {
  sheets.run_log.push([sheets._recent, "force_refresh", "y", false, 3, 3, 0, "ok", "sd_2", ""]);
  let res = await req("/api/refresh", { body: {} });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /10 min geleden/);

  sheets.run_log.pop();
  sheets._runs = [{ status: "in_progress" }];
  res = await req("/api/refresh", { body: {} });
  assert.equal(res.status, 409);

  sheets._runs = [{ status: "completed", conclusion: "success" }];
  res = await req("/api/refresh", { body: {} });
  assert.equal(res.status, 200);
  const dispatch = calls.find((c) => c.url.endsWith(`/actions/workflows/${CONFIG.workflows.force}/dispatches`));
  assert.ok(dispatch);
  assert.deepEqual(JSON.parse(dispatch.body), { ref: "main" });
  assert.ok(sheets.activity_log.some((r) => r[2] === "nu verversen"));
});

// ---------- backup timer (Cloudflare Cron Trigger) ----------

test("backup timer starts the collector only when a window is open and not done", async () => {
  const at = (iso) => Date.parse(iso);
  const dispatches = () => calls.filter((c) => c.url.endsWith(`/actions/workflows/${CONFIG.workflows.collect}/dispatches`));

  // Outside every window (odd hour, no finale): only the sheet is checked, GitHub is not called.
  let r = await runSchedule(ENV, strictThisFetch, at("2026-10-01T13:05:00+02:00"));
  assert.equal(r.action, "no window open");
  assert.equal(calls.filter((c) => c.url.includes("api.github.com")).length, 0);

  // A pool window that is in nobody's step (18u): nothing to do either.
  assert.equal((await runSchedule(ENV, strictThisFetch, at("2026-10-01T18:25:00+02:00"))).action, "no window open");

  // 20u windows open (TikTok 20u and Instagram ig-20u), not done: dispatch "auto" (not a dry run) on main.
  sheets._runs = [{ status: "completed" }];
  r = await runSchedule(ENV, strictThisFetch, at("2026-10-01T20:25:00+02:00"));
  assert.equal(r.action, "collector started");
  assert.deepEqual(r.due, ["2026-10-01/20u", "2026-10-01/ig-20u"]);
  assert.equal(dispatches().length, 1);
  assert.deepEqual(JSON.parse(dispatches()[0].body), { ref: "main", inputs: { command: "auto", dry_run: "false", handles: "" } });

  // A collector run is already queued or running: don't pile up.
  sheets._runs = [{ status: "queued" }];
  r = await runSchedule(ENV, strictThisFetch, at("2026-10-01T20:45:00+02:00"));
  assert.equal(r.action, "collector already running");
  assert.equal(dispatches().length, 1);

  // TikTok's window done (also "skipped" right after Nu verversen), Instagram's not: the collector is still due.
  sheets._runs = [{ status: "completed" }];
  sheets.run_log.push(["2026-10-01T16:30:00Z", "profiles", "2026-10-01/20u", false, 3, 0, 0, "skipped", "", ""]);
  r = await runSchedule(ENV, strictThisFetch, at("2026-10-01T20:50:00+02:00"));
  assert.equal(r.action, "collector started");
  assert.deepEqual(r.due, ["2026-10-01/ig-20u"]);
  assert.equal(dispatches().length, 2);

  // Both done: nothing to do.
  sheets.run_log.push(["2026-10-01T16:40:00Z", "ig_profiles", "2026-10-01/ig-20u", false, 3, 3, 0, "ok", "sd", ""]);
  r = await runSchedule(ENV, strictThisFetch, at("2026-10-01T20:55:00+02:00"));
  assert.equal(r.action, "windows already done");
  assert.equal(dispatches().length, 2);

  // 12:25 is an Instagram-only window (TikTok runs 08u and 20u).
  r = await runSchedule(ENV, strictThisFetch, at("2026-10-02T12:25:00+02:00"));
  assert.equal(r.action, "collector started");
  assert.deepEqual(r.due, ["2026-10-02/ig-12u"]);
});

// ---------- finale (manual, from Beheer) ----------

const inHours = (h) => {
  const t = new Date(Date.now() + h * 3600e3);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

test("finale: start checks deadline limits, writes private + public state and logs who", async () => {
  let res = await req("/api/finale/start", { body: { deadline: inHours(CONFIG.finale.maxHours + 1) } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /maximaal/);
  res = await req("/api/finale/start", { body: { deadline: inHours(0.1) } });
  assert.equal(res.status, 400);
  sheets._runs = [{ status: "completed" }];
  res = await req("/api/finale/start", { body: { deadline: inHours(2) } });
  assert.equal(res.status, 200, await res.clone().text());
  const row = sheets.finale.at(-1);
  assert.deepEqual([row[1], row[3]], ["docent@school.nl", "active"]);
  assert.deepEqual(pub.finale[0], ["started_at", "deadline", "status", "ended_at"]);
  assert.equal(pub.finale[1][2], "active");
  assert.ok(!JSON.stringify(pub).includes("@school.nl"), "no emails in the public sheet");
  assert.ok(sheets.activity_log.some((r) => r[2] === "finale gestart" && r[1] === "docent@school.nl"));
  assert.ok(calls.some((c) => c.url.includes("/actions/workflows/collect.yml/dispatches")), "first run started right away");
  // A second start while it runs is refused.
  res = await req("/api/finale/start", { body: { deadline: inHours(3) } });
  assert.equal(res.status, 409);
  // /api/data reports it as live.
  const d = await (await req("/api/data")).json();
  assert.equal(d.finale.phase, "live");
  assert.equal(d.finaleHasRun, true);
});

test("finale: budget cap refuses a finale that doesn't fit", async () => {
  sheets.run_log.push([new Date().toISOString(), "profiles", "big", false, 1, CONFIG.budget.monthlyCap - 5, 0, "ok", "sd_x", ""]);
  const res = await req("/api/finale/start", { body: { deadline: inHours(2) } });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /budget/);
});

test("finale: change deadline, stop (Eindstand) and cancel are logged", async () => {
  sheets._runs = [{ status: "completed" }];
  await req("/api/finale/start", { body: { deadline: inHours(2) } });
  let res = await req("/api/finale/deadline", { body: { deadline: inHours(3) } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(sheets.activity_log.some((r) => r[2] === "finale deadline gewijzigd"));
  res = await req("/api/finale/stop", { body: { mode: "stop" } });
  assert.equal(res.status, 200);
  assert.deepEqual(sheets.finale.at(-1).slice(3, 6).map((v, i) => (i === 1 ? typeof v : v)), ["stopped", "string", "docent@school.nl"]);
  assert.equal(pub.finale[1][2], "stopped");
  // Stopped: no longer live, so a second stop is refused; cancelling takes the Eindstand away.
  assert.equal((await req("/api/finale/stop", { body: { mode: "stop" } })).status, 409);
  assert.equal((await req("/api/finale/stop", { body: { mode: "cancel" } })).status, 200);
  assert.equal(pub.finale[1][2], "cancelled");
  assert.ok(sheets.activity_log.some((r) => r[2] === "finale geannuleerd"));
});

test("timer: during a finale it starts a run every 15 minutes, also outside the 2-hourly windows", async () => {
  const start = Date.parse("2026-10-26T13:00:00Z");
  sheets.finale = [["started_at", "started_by", "deadline", "status", "ended_at", "ended_by"],
    ["2026-10-26T13:00:00Z", "x@y.nl", "2026-10-26T15:00:00Z", "active", "", ""]];
  sheets._runs = [{ status: "completed" }];
  const r = await runSchedule(ENV, strictThisFetch, start + 65 * 60e3); // 15:05 Amsterdam: odd hour
  assert.equal(r.action, "collector started");
  assert.deepEqual(r.due, ["2026-10-26/finale-1500", "2026-10-26/ig-finale-1500"]); // both platforms
  sheets.run_log.push(["2026-10-26T14:06:00Z", "profiles", "2026-10-26/finale-1500", false, 3, 3, 0, "ok", "sd", ""]);
  sheets.run_log.push(["2026-10-26T14:07:00Z", "ig_profiles", "2026-10-26/ig-finale-1500", false, 3, 3, 0, "ok", "sd", ""]);
  assert.equal((await runSchedule(ENV, strictThisFetch, start + 70 * 60e3)).action, "windows already done");
  // After the deadline (17:05 Amsterdam, an odd hour): back to the normal windows, none open now.
  assert.equal((await runSchedule(ENV, strictThisFetch, start + 185 * 60e3)).action, "no window open");
});

// ---------- buiten schaal, dagopdrachten, Vandaag ----------

test("buiten schaal: one row per handle in the public outliers tab (fixed tab id), logged", async () => {
  let res = await req("/api/outliers", { body: { handle: "@Anna_1", on: true } });
  assert.equal(res.status, 200, await res.clone().text());
  const add = calls.find((c) => c.url.includes(":batchUpdate") && c.body.includes('"outliers"'));
  assert.equal(JSON.parse(add.body).requests[0].addSheet.properties.sheetId, CONFIG.fixedGids.outliers);
  assert.deepEqual(sheets.outliers[0], ["handle", "buiten_schaal", "updated_at"]);
  assert.deepEqual(sheets.outliers[1].slice(0, 2), ["anna_1", "ja"]);
  assert.deepEqual((await (await req("/api/data")).json()).outliers, ["anna_1"]);
  res = await req("/api/outliers", { body: { handle: "anna_1", on: false } });
  assert.equal(res.status, 200);
  assert.equal(sheets.outliers.length, 2, "updated in place, never a second row");
  assert.equal(sheets.outliers[1][1], "nee");
  assert.deepEqual((await (await req("/api/data")).json()).outliers, []);
  assert.equal((await req("/api/outliers", { body: { handle: "bram.b", on: true } })).status, 409); // inactive
  assert.ok(sheets.activity_log.some((r) => r[2] === "buiten schaal aan" && r[3] === "@anna_1"));
  assert.ok(!JSON.stringify(sheets.outliers).includes("Anna"), "handles only in the public sheet");
});

test("dagopdrachten: add, refuse bad input and doubles, edit, remove (never deleted), logged", async () => {
  const day = CONFIG.campaign.start;
  let res = await req("/api/tasks", { body: { action: "add", date: day, min: 3, label: "Kerstspecial" } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(sheets.dagopdrachten[1].slice(0, 4), [day, 3, "Kerstspecial", "ja"]);
  assert.equal((await req("/api/tasks", { body: { action: "add", date: day, min: 4 } })).status, 409);
  assert.equal((await req("/api/tasks", { body: { action: "add", date: "2026-12-01", min: 4 } })).status, 400);
  assert.equal((await req("/api/tasks", { body: { action: "add", date: lib.addDays(day, 1), min: 1 } })).status, 400);
  let d = await (await req("/api/data")).json();
  assert.deepEqual(d.tasks.map((t) => [t.date, t.min, t.label]), [[day, 3, "Kerstspecial"]]);
  res = await req("/api/tasks", { body: { action: "edit", row: 2, was: day, date: day, min: 5, label: "" } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(sheets.dagopdrachten[1][1], 5);
  assert.equal((await req("/api/tasks", { body: { action: "remove", row: 2, was: "2026-10-01" } })).status, 409); // stale
  res = await req("/api/tasks", { body: { action: "remove", row: 2, was: day } });
  assert.equal(res.status, 200);
  assert.equal(sheets.dagopdrachten.length, 2, "row kept");
  assert.equal(sheets.dagopdrachten[1][3], "nee");
  d = await (await req("/api/data")).json();
  assert.deepEqual(d.tasks, []);
  for (const a of ["dagopdracht toegevoegd", "dagopdracht gewijzigd", "dagopdracht verwijderd"]) {
    assert.ok(sheets.activity_log.some((r) => r[2] === a), a);
  }
});

test("Controleer nu: only accounts not done today, cooldown, busy collector and budget", async () => {
  const now = new Date().toISOString();
  sheets.accounts.push(["Dewi", "dewi", "ja"], ["Eva", "eva", "ja"]);
  sheets.handles.push(["chris", false, 1, "", "ok"], ["dewi", true, 1, "", "privé"], ["eva", false, 1, "", "ok"]);
  sheets.posts_latest = [["video_id", "handle", "created_at", "views"], ["1", "anna_1", now, 5], ["2", "eva", "2026-09-29T10:00:00Z", 5]];
  // Busy: a collection is running.
  sheets._runs = [{ status: "in_progress" }];
  let res = await req("/api/today/check", { body: {} });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /loopt al/);
  sheets._runs = [{ status: "completed" }];
  res = await req("/api/today/check", { body: {} });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).count, 2);
  const dispatch = calls.find((c) => c.url.endsWith(`/actions/workflows/${CONFIG.workflows.collect}/dispatches`));
  // anna_1 posted today, dewi is private: chris and eva are checked. Handles only, never names.
  assert.deepEqual(JSON.parse(dispatch.body), { ref: "main", inputs: { command: "today", dry_run: "false", handles: "chris,eva" } });
  assert.ok(sheets.activity_log.some((r) => r[2] === "vandaag gecontroleerd" && r[3].startsWith("2 accounts")));
  // Cooldown from the activity log entry.
  res = await req("/api/today/check", { body: {} });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /weer over 10 min/);
  // /api/data reports the last check for the page.
  assert.ok((await (await req("/api/data")).json()).lastTodayCheck > Date.now() - 60e3);
});

test("Controleer nu: refused when it would not fit in the monthly budget", async () => {
  sheets.run_log.push([new Date().toISOString(), "profiles", "big", false, 1, CONFIG.budget.monthlyCap, 0, "ok", "sd_x", ""]);
  sheets._runs = [{ status: "completed" }];
  const res = await req("/api/today/check", { body: {} });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /budget/);
  assert.ok(!calls.some((c) => c.url.includes("dispatches")));
});

test("+ account: a second account gets the student's name and main_account; refused for extra or inactive accounts", async () => {
  // This sheet has no main_account column yet: it is added to the header.
  let res = await req("/api/accounts", { body: { handle: "@Anna.Ads", main: "anna_1" } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(sheets.accounts[0], ["student_name", "tiktok_handle", "active", "main_account"]);
  assert.deepEqual(sheets.accounts.at(-1), ["Anna", "anna.ads", "ja", "anna_1"]);
  assert.ok(sheets.activity_log.some((r) => r[2] === "account toegevoegd aan leerling" && r[3].includes("@anna.ads (bij @anna_1)")));
  const d = await (await req("/api/data")).json();
  assert.equal(d.accounts.find((a) => a.handle === "anna.ads").group, "anna_1");
  assert.equal((await req("/api/accounts", { body: { handle: "x3", main: "anna.ads" } })).status, 409); // an extra account
  assert.equal((await req("/api/accounts", { body: { handle: "x4", main: "bram.b" } })).status, 409);   // inactive
  assert.equal((await req("/api/accounts", { body: { handle: "anna_1", main: "chris" } })).status, 409); // already there
});

test("Instagram: adding a student with a handle (new column or the old 'Insta ' one); Instagram only; refusals", async () => {
  // This sheet has no Instagram column yet: it is added to the header.
  let res = await req("/api/accounts", { body: { name: "Eva", handle: "eva_t", instagram: "https://www.instagram.com/Eva.IG/?igsh=x" } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(sheets.accounts[0], ["student_name", "tiktok_handle", "active", "instagram_handle"]);
  assert.deepEqual(sheets.accounts.at(-1), ["Eva", "eva_t", "ja", "eva.ig"]);
  assert.ok(sheets.activity_log.some((r) => r[2] === "leerling toegevoegd" && r[3].includes("TikTok @eva_t + Instagram @eva.ig")));
  // The same Instagram account for a second student is refused, also when the first row is inactive.
  res = await req("/api/accounts", { body: { name: "X", handle: "x1", instagram: "@EVA.ig" } });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Instagram @eva\.ig staat al in rij 5/);
  sheets.accounts.at(-1)[2] = "nee";
  assert.match((await (await req("/api/accounts", { body: { name: "X", handle: "x1", instagram: "eva.ig" } })).json()).error, /\(inactief\)/);
  // A student with only Instagram: the TikTok cell stays empty and the row is no TikTok problem.
  res = await req("/api/accounts", { body: { name: "Finn", instagram: "@finn.ig" } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(sheets.accounts.at(-1), ["Finn", "", "ja", "finn.ig"]);
  const d = await (await req("/api/data")).json();
  const finn = d.accounts.find((a) => a.name === "Finn");
  assert.deepEqual([finn.issue, finn.tracked, finn.instagramTracked, finn.instagram], [null, false, true, "finn.ig"]);
  // Refused: nothing at all, a link to a post, and an Instagram account on a second TikTok account.
  assert.equal((await req("/api/accounts", { body: { name: "Y" } })).status, 400);
  res = await req("/api/accounts", { body: { name: "Y", instagram: "https://www.instagram.com/p/DeRh47eptOn" } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /post/);
  assert.equal((await req("/api/accounts", { body: { handle: "anna.ads", main: "anna_1", instagram: "anna.ig" } })).status, 400);
  assert.equal(sheets.accounts.length, 6, "only Eva and Finn were added");
  // A sheet with the hand-typed header "Insta ": the value goes into that column, no second column.
  sheets.accounts[0] = ["student_name", "tiktok_handle", "active", "Insta "];
  res = await req("/api/accounts", { body: { name: "Gus", handle: "gus", instagram: "gus.ig" } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(sheets.accounts.at(-1), ["Gus", "gus", "ja", "gus.ig"]);
  assert.deepEqual(sheets.accounts[0], ["student_name", "tiktok_handle", "active", "Insta "]);
});

test("Instagram: set, change and clear a student's handle; logged; refuses stale, second-account and doubles", async () => {
  sheets.accounts = [
    ["student_name", "tiktok_handle", "active", "main_account", "Insta "],
    ["Anna", "@anna_1", "ja", "", "anna.gram"],
    ["Bram", "bram.b", "nee", "", ""],
    ["", "chris", "", "", ""],
    ["Anna", "anna.ads", "ja", "anna_1", ""],
  ];
  const set = (row, was, handle) => req("/api/accounts/instagram", { body: { row, was, handle } });
  let res = await set(4, "", "@Chris.IG");
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(sheets.accounts[3][4], "chris.ig");
  res = await set(2, "anna.gram", "https://www.instagram.com/Anna.New/");
  assert.equal(res.status, 200);
  assert.equal(sheets.accounts[1][4], "anna.new");
  assert.deepEqual(sheets.activity_log.filter((r) => r[2].startsWith("instagram-handle")).map((r) => [r[2], r[3]]), [
    ["instagram-handle toegevoegd", "(geen naam): geen → @chris.ig, rij 4"],
    ["instagram-handle gewijzigd", "Anna: @anna.gram → @anna.new, rij 2"]]);
  // Refused: the sheet changed meanwhile, another student's handle, a second TikTok account, a post link.
  assert.equal((await set(2, "anna.gram", "x")).status, 409);
  res = await set(3, "", "anna.new");
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /rij 2/);
  assert.match((await (await set(5, "", "anna.ig")).json()).error, /eerste rij/);
  assert.equal((await set(3, "", "https://www.instagram.com/reel/abc/")).status, 400);
  assert.equal((await set(9, "", "nobody")).status, 409);
  assert.equal(sheets.accounts[2][4], "", "nothing written by the refused calls");
  // Same value: nothing written. Clear: the cell is emptied and it is logged (the row is never deleted).
  assert.match((await (await set(2, "anna.new", "Anna.New")).json()).message, /Ongewijzigd/);
  res = await set(2, "anna.new", "");
  assert.equal(res.status, 200);
  assert.equal(sheets.accounts[1][4], "");
  assert.equal(sheets.accounts.length, 5);
  assert.deepEqual(sheets.activity_log.at(-1).slice(2), ["instagram-handle verwijderd", "Anna: @anna.new → geen, rij 2"]);
  // Setting it again: the data endpoint shows it per student, from the first row only.
  await set(2, "", "anna.back");
  const d = await (await req("/api/data")).json();
  assert.deepEqual(d.accounts.filter((a) => a.instagramTracked).map((a) => [a.row, a.instagram]), [[2, "anna.back"], [4, "chris.ig"]]);
  // An older sheet without the column: it is added to the header on the first handle.
  sheets.accounts = [["student_name", "tiktok_handle", "active"], ["Dana", "dana", "ja"]];
  res = await set(2, "", "dana.ig");
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(sheets.accounts, [["student_name", "tiktok_handle", "active", "instagram_handle"], ["Dana", "dana", "ja", "dana.ig"]]);
});

test("(de)activating a student that only has Instagram goes by the Instagram handle", async () => {
  sheets.accounts.push(["Finn", "", "ja", "finn.ig"]);
  sheets.accounts[0] = ["student_name", "tiktok_handle", "active", "instagram_handle"];
  let res = await req("/api/accounts/active", { body: { row: 5, instagram: "finn.ig", active: false } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(sheets.accounts[4][2], "nee");
  assert.equal((await req("/api/accounts/active", { body: { row: 5, instagram: "other.ig", active: true } })).status, 409);
  assert.equal((await req("/api/accounts/active", { body: { row: 5, active: true } })).status, 400);
  res = await req("/api/accounts/active", { body: { row: 5, instagram: "@FINN.IG", active: true } });
  assert.equal(res.status, 200);
  assert.equal(sheets.accounts[4][2], "ja");
  assert.match(sheets.activity_log.at(-1)[3], /Finn Instagram @finn\.ig, rij 5/);
});

test("Nu verversen: TikTok and Instagram each have their own cooldown; refused only when every platform is recent", async () => {
  sheets.accounts[0] = [...sheets.accounts[0], "instagram_handle"];
  sheets.accounts[1].push("anna.ig");   // Anna has an Instagram account
  sheets._runs = [{ status: "completed" }];
  const dispatches = () => calls.filter((c) => c.url.endsWith(`/actions/workflows/${CONFIG.workflows.force}/dispatches`)).length;
  // TikTok was refreshed 10 minutes ago, Instagram never: the refresh goes ahead (the collector skips what is recent).
  sheets.run_log.push([sheets._recent, "force_refresh", "y", false, 3, 3, 0, "ok", "sd_2", ""]);
  let res = await req("/api/refresh", { body: {} });
  assert.equal(res.status, 200, await res.clone().text());
  assert.match((await res.json()).message, /TikTok en Instagram/);
  assert.equal(dispatches(), 1);
  // A partial Instagram check does not count as a refresh; a real Instagram run does.
  sheets.run_log.push([sheets._recent, "ig_today_check", "y", false, 1, 1, 0, "ok", "sd_3", ""]);
  assert.equal((await req("/api/refresh", { body: {} })).status, 200);
  sheets.run_log.push([sheets._recent, "ig_force_refresh", "y", false, 1, 1, 0, "ok", "sd_4", ""]);
  res = await req("/api/refresh", { body: {} });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /De laatste profielrun was 10 min geleden\. Verversen kan weer over 20 min\./);
  assert.equal(dispatches(), 2);
});

test("/api/data: the budget counts both platforms, with their runs and last runs", async () => {
  sheets.accounts[0] = [...sheets.accounts[0], "instagram_handle"];
  sheets.accounts[1].push("anna.ig");
  sheets.accounts[3].push("chris.ig");
  sheets.run_log.push([sheets._recent, "ig_profiles", "2026-10-01/ig-20u", false, 2, 2, 0, "ok", "sd_5", ""]);
  sheets.run_log.push([sheets._recent, "profiles", "2026-10-01/20u", false, 3, 3, 0, "ok", "sd_6", ""]);
  const d = await (await req("/api/data")).json();
  assert.equal(d.budget.byPlatform.tiktok.accounts, 2);      // anna_1 and chris
  assert.equal(d.budget.byPlatform.instagram.accounts, 2);
  assert.equal(d.budget.reserved, d.budget.byPlatform.tiktok.reserved + d.budget.byPlatform.instagram.reserved);
  assert.equal(d.budget.used, 3 + 2);                         // this month: a TikTok and an Instagram run, one cap
  assert.equal(d.lastInstagramRun, Date.parse(sheets._recent));
  assert.deepEqual(d.config.frequency, CONFIG.frequency);
  assert.deepEqual(d.config.schedule.windows.instagram.map((x) => x.name).slice(0, 2), ["ig-00u", "ig-04u"]);
});

test("Controleer nu: a student with two accounts is done when either posted; otherwise both are checked", async () => {
  const now = new Date().toISOString();
  sheets.accounts[0].push("main_account");
  sheets.accounts.push(["Anna", "anna.ads", "ja", "anna_1"], ["", "chris.ads", "ja", "chris"]);
  sheets.handles.push(["chris", false, 1, "", "ok"], ["anna.ads", false, 1, "", "ok"], ["chris.ads", false, 1, "", "ok"]);
  sheets.posts_latest = [["video_id", "handle", "created_at", "views"], ["1", "anna.ads", now, 5]];
  sheets._runs = [{ status: "completed" }];
  const res = await req("/api/today/check", { body: {} });
  assert.equal(res.status, 200, await res.clone().text());
  const dispatch = calls.find((c) => c.url.endsWith(`/actions/workflows/${CONFIG.workflows.collect}/dispatches`));
  assert.equal(JSON.parse(dispatch.body).inputs.handles, "chris,chris.ads"); // Anna posted on her second account
});

test("/api/data: the Instagram tabs come along (stripped of row numbers), and are empty before the first Instagram run", async () => {
  let d = await (await req("/api/data")).json();
  assert.deepEqual([d.igHandles, d.igHistory, d.igPosts, d.igBaseline], [[], [], [], []]); // tabs don't exist yet
  sheets.ig_handles = [["handle", "is_private", "followers", "last_scraped", "last_status", "status_since"], ["anna.ig", false, 120, "2026-10-07T08:00:00Z", "ok", "2026-10-07T08:00:00Z"]];
  sheets.ig_history = [["timestamp", "handle", "followers", "following", "posts_count", "is_private", "campaign_posts"], ["2026-10-07T08:00:00Z", "anna.ig", 120, 30, 55, false, 1]];
  sheets.ig_posts = [["post_id", "handle", "created_at", "post_type", "hashtags", "url", "first_seen", "last_seen"],
    ["17900000000000001", "anna.ig", "2026-10-07T07:30:00Z", "reel", "glu", "https://www.instagram.com/reel/X/", "2026-10-07T08:00:00Z", "2026-10-07T08:00:00Z"]];
  sheets.ig_baseline = [["handle", "baseline_at", "baseline_followers"], ["anna.ig", "2026-10-07T08:00:00Z", 118]];
  d = await (await req("/api/data")).json();
  assert.deepEqual(d.igHandles.map((h) => [h.handle, h.followers, h.last_status]), [["anna.ig", 120, "ok"]]);
  assert.equal(d.igHistory[0].campaign_posts, 1);
  assert.deepEqual(d.igPosts.map((p) => [p.post_id, p.post_type, p.url]), [["17900000000000001", "reel", "https://www.instagram.com/reel/X/"]]);
  assert.equal(d.igBaseline[0].baseline_followers, 118);
  for (const row of [...d.igHandles, ...d.igHistory, ...d.igPosts, ...d.igBaseline]) assert.equal("_row" in row, false);
});

test("Controleer nu: both platforms in one dispatch (cost shown per platform); an Instagram post counts as posted; Instagram-only students are checked", async () => {
  const now = new Date().toISOString();
  sheets.accounts[0] = [...sheets.accounts[0], "instagram_handle"];
  sheets.accounts[1].push("anna.ig");                  // Anna: TikTok anna_1 + Instagram anna.ig, posted on Instagram today
  sheets.accounts.push(["Dewi", "dewi", "ja", "dewi.ig"], ["Pim", "", "ja", "pim.only"], ["Quin", "quin", "ja", "quin.ig"]);
  sheets.handles.push(["chris", false, 1, "", "ok"], ["dewi", false, 1, "", "ok"], ["quin", false, 1, "", "ok"]);
  sheets.posts_latest = [["video_id", "handle", "created_at", "views"], ["9", "quin", now, 5]];   // Quin posted on TikTok today
  sheets.ig_handles = [["handle", "is_private", "followers", "last_scraped", "last_status", "status_since"],
    ["anna.ig", false, 1, "", "ok", ""], ["dewi.ig", true, 1, "", "privé", ""], ["pim.only", false, 1, "", "ok", ""], ["quin.ig", false, 1, "", "ok", ""]];
  sheets.ig_posts = [["post_id", "handle", "created_at"], ["1", "anna.ig", now]];
  sheets._runs = [{ status: "completed" }];
  const res = await req("/api/today/check", { body: {} });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  const dispatch = calls.find((c) => c.url.endsWith(`/actions/workflows/${CONFIG.workflows.collect}/dispatches`));
  // Anna (Instagram post) and Quin (TikTok post) are done on both platforms. Chris: TikTok only. Dewi: public TikTok, private Instagram.
  // Pim: only Instagram. The Instagram handles carry the platform in front; no names anywhere.
  assert.equal(JSON.parse(dispatch.body).inputs.handles, "chris,dewi,instagram:pim.only");
  assert.deepEqual([body.count, body.tiktok, body.instagram], [3, 2, 1]);
  assert.match(body.message, /3 accounts \(2 TikTok, 1 Instagram\) \(3 records\)/);
  assert.match(body.message, /5–10 minuten/);
  assert.ok(sheets.activity_log.some((r) => r[2] === "vandaag gecontroleerd" && r[3] === "3 accounts, 3 records (2 TikTok, 1 Instagram)"));
});

test("Controleer nu: only Instagram accounts left, or only TikTok: the message says so and the time stays 5–7 minutes", async () => {
  const now = new Date().toISOString();
  sheets.accounts[0] = [...sheets.accounts[0], "instagram_handle"];
  sheets.accounts.push(["Pim", "", "ja", "pim.only"]);
  sheets.handles.push(["chris", false, 1, "", "ok"]);
  sheets.posts_latest = [["video_id", "handle", "created_at", "views"], ["1", "anna_1", now, 5], ["2", "chris", now, 5]];   // both TikTok students posted
  sheets.ig_handles = [["handle", "is_private", "followers", "last_scraped", "last_status", "status_since"], ["pim.only", false, 1, "", "ok", ""]];
  sheets._runs = [{ status: "completed" }];
  let res = await req("/api/today/check", { body: {} });
  assert.equal(res.status, 200, await res.clone().text());
  let body = await res.json();
  assert.deepEqual([body.count, body.tiktok, body.instagram], [1, 0, 1]);
  assert.match(body.message, /1 account \(Instagram\) \(1 records\)/);
  assert.match(body.message, /5–7 minuten/);
  const dispatch = calls.find((c) => c.url.endsWith(`/actions/workflows/${CONFIG.workflows.collect}/dispatches`));
  assert.equal(JSON.parse(dispatch.body).inputs.handles, "instagram:pim.only");
});

test("Controleer nu: the Instagram accounts count in the budget check", async () => {
  sheets.accounts[0] = [...sheets.accounts[0], "instagram_handle"];
  sheets.accounts.push(["Pim", "", "ja", "pim.only"], ["Quin", "", "ja", "quin.only"]);   // two students with only Instagram
  sheets._runs = [{ status: "completed" }];
  // Fill the month so that exactly 2 records are left after the reserve for the remaining scheduled runs:
  // the two TikTok accounts (chris, anna_1) would fit, the two Instagram-only students on top of them don't.
  const projected = (await (await req("/api/data")).json()).budget.projected;
  sheets.run_log.push([sheets._recent, "profiles", "2026-10-01/20u", false, 0, CONFIG.budget.monthlyCap - 2 - projected, 0, "ok", "sd_big", ""]);
  const res = await req("/api/today/check", { body: {} });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Past niet in het budget.*\+ 4 voor deze controle/);
  assert.equal(calls.some((c) => c.url.endsWith("/dispatches")), false);
});

test("school hashtags: the start value from config.yaml until a list is saved; saving creates the settings tab and one row, logged", async () => {
  let d = await (await req("/api/data")).json();
  assert.deepEqual(d.settings.schoolHashtags, ["glu", "grafischlyceumutrecht", "av"]);
  assert.deepEqual(d.settings.schoolHashtagsDefault, ["glu", "grafischlyceumutrecht", "av"]);
  const post = (body) => req("/api/settings/hashtags", { body });
  let res = await post({ tags: "#GLU, av  schoolproject", was: "glu grafischlyceumutrecht av" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).tags, ["glu", "av", "schoolproject"]);
  assert.deepEqual(sheets.settings[0], ["key", "value", "updated_at", "updated_by"]);
  assert.deepEqual([sheets.settings[1][0], sheets.settings[1][1], sheets.settings[1][3]], ["school_hashtags", "glu av schoolproject", "docent@school.nl"]);
  assert.ok(sheets.activity_log.some((r) => r[2] === "schoolhashtags gewijzigd" && r[3] === "#glu #grafischlyceumutrecht #av → #glu #av #schoolproject"));
  d = await (await req("/api/data")).json();
  assert.deepEqual(d.settings.schoolHashtags, ["glu", "av", "schoolproject"]);
  assert.deepEqual(d.settings.schoolHashtagsDefault, ["glu", "grafischlyceumutrecht", "av"]);   // the start value stays available
  // A second save updates the same row (no doubles), and saving the same list again writes nothing.
  const logged = sheets.activity_log.length;
  res = await post({ tags: "glu", was: "glu av schoolproject" });
  assert.equal(res.status, 200);
  assert.equal(sheets.settings.length, 2);
  assert.equal(sheets.settings[1][1], "glu");
  assert.equal(sheets.activity_log.length, logged + 1);
  res = await post({ tags: "#glu", was: "glu" });
  assert.match((await res.json()).message, /ongewijzigd/);
  assert.equal(sheets.activity_log.length, logged + 1);
  // The list can be emptied on purpose: then there are no presets (the start value is not used again).
  res = await post({ tags: "  ", was: "glu" });
  assert.equal(res.status, 200);
  assert.deepEqual((await (await req("/api/data")).json()).settings.schoolHashtags, []);
});

test("school hashtags: refuses invalid entries, too many, a stale list and a missing CSRF header", async () => {
  const post = (body, opts = {}) => req("/api/settings/hashtags", { body, ...opts });
  let res = await post({ tags: "glu nieuw-tag #ok twee!" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Geen geldige hashtag: "nieuw-tag", "twee!"/);
  res = await post({ tags: Array.from({ length: 13 }, (_, i) => `tag${i}`).join(" ") });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Maximaal 12/);
  res = await post({ tags: "glu", was: "iets anders" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /intussen veranderd/);
  res = await post({ tags: "glu" }, { headers: { "x-requested-with": "" } });
  assert.equal(res.status, 403);
  assert.equal(sheets.settings, undefined);                        // nothing was written, not even the tab
  assert.equal((sheets.activity_log || []).some((r) => r[2] === "schoolhashtags gewijzigd"), false);
});
