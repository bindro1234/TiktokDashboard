// Worker tests with mocked Access, Google and GitHub (synthetic data only). Run: node --test private/test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { handle, runSchedule } from "../src/worker.js";
import { resetCertCache } from "../src/access.js";
import { resetTokenCache } from "../src/google.js";
import CONFIG from "../src/config.json" with { type: "json" };

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

let sheets, calls;
function values(tab) {
  return sheets[tab] || null;
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
    if (method === "GET" && /\/spreadsheets\/[^/]+$/.test(path)) {
      return ok({ sheets: Object.keys(sheets).filter((t) => !t.startsWith("_")).map((title) => ({ properties: { title } })) });
    }
    if (path.endsWith("/values:batchGet")) {
      return ok({ valueRanges: url.searchParams.getAll("ranges").map((r) => ({ values: values(r.replace(/'/g, "")) || [] })) });
    }
    const m = path.match(/\/values\/'([^']+)'!([A-Z]+)(\d+)(:append)?$/);
    if (m && m[4]) {
      const rows = JSON.parse(init.body).values;
      sheets[m[1]].push(...rows);
      return ok({ updates: { updatedRange: `'${m[1]}'!A${sheets[m[1]].length}:C${sheets[m[1]].length}` } });
    }
    if (m && method === "PUT") {
      const rows = JSON.parse(init.body).values;
      const col = m[2].charCodeAt(0) - 65;
      rows.forEach((row, i) => {
        const target = (sheets[m[1]][Number(m[3]) - 1 + i] ||= []);
        row.forEach((v, j) => { target[col + j] = v; });
      });
      return ok({});
    }
    if (path.endsWith(":batchUpdate")) {
      for (const r of JSON.parse(init.body).requests) if (r.addSheet) sheets[r.addSheet.properties.title] = [];
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
    ["/api/accounts", { body: { name: "Eva", handle: "eva.e" } }]]) {
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

  // Outside every window: no Google or GitHub calls at all.
  let r = await runSchedule(ENV, strictThisFetch, at("2026-10-01T12:05:00+02:00"));
  assert.equal(r.action, "no window open");
  assert.equal(calls.length, 0);

  // Evening window open, not done: dispatch "auto" (not a dry run) on main.
  sheets._runs = [{ status: "completed" }];
  r = await runSchedule(ENV, strictThisFetch, at("2026-10-01T18:25:00+02:00"));
  assert.equal(r.action, "collector started");
  assert.deepEqual(r.due, ["2026-10-01/avond"]);
  assert.equal(dispatches().length, 1);
  assert.deepEqual(JSON.parse(dispatches()[0].body), { ref: "main", inputs: { command: "auto", dry_run: "false", handles: "" } });

  // A collector run is already queued or running: don't pile up.
  sheets._runs = [{ status: "queued" }];
  r = await runSchedule(ENV, strictThisFetch, at("2026-10-01T18:45:00+02:00"));
  assert.equal(r.action, "collector already running");
  assert.equal(dispatches().length, 1);

  // Window done (also "skipped" right after Nu verversen): nothing to do.
  sheets.run_log.push(["2026-10-01T16:30:00Z", "profiles", "2026-10-01/avond", false, 3, 0, 0, "skipped", "", ""]);
  r = await runSchedule(ENV, strictThisFetch, at("2026-10-01T19:05:00+02:00"));
  assert.equal(r.action, "windows already done");
  assert.equal(dispatches().length, 1);
});
