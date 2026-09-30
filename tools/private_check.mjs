// Browser check for the private dashboard with SYNTHETIC data (fake names, fake handles).
// Serves private/public/ plus a fake /api that behaves like the Worker, then clicks through
// every tab at desktop and phone size. Run after private/build.sh: node tools/private_check.mjs
// (The Worker itself, including the Access check, is covered by private/test.)

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import * as lib from "../private/public/lib.js";

const ROOT = new URL("../private/public/", import.meta.url).pathname;
const CFG = JSON.parse(readFileSync(new URL("../private/src/config.json", import.meta.url)));
const NOW = Date.parse("2026-10-07T18:30:00+02:00");
const DAY = 864e5;
const executablePath = process.env.CHROMIUM_PATH || undefined;

// ---------- synthetic data ----------
const names = ["Anna", "Bram", "Chris", "Dewi", "Eva", "Finn", "Gijs", "Hana", "Ilse", "Joris", "Kim", ""];
const accountsSheet = [
  ...names.map((n, i) => ({ _row: i + 2, student_name: n, tiktok_handle: `@test_${String(i + 1).padStart(2, "0")}`, active: "ja" })),
  { _row: 14, student_name: "Lot", tiktok_handle: "https://vm.tiktok.com/abc", active: "ja" },
  { _row: 15, student_name: "Mo", tiktok_handle: "test_16", active: "nee" },
];
const tracked = lib.parseAccounts(accountsSheet).filter((a) => a.tracked).map((a) => a.handle);
const tagsPool = ["fyp", "glu", "schoolproject", "viral", "tiktoknl", "sport"];
const posts = [], history = [];
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
tracked.forEach((h, i) => {
  const start = Date.parse("2026-09-28T10:00:00Z");
  for (let d = 0; d < 10; d++) {
    if (i === 3 && d > 6) continue;           // stopped posting: "geen post" warning
    if (rnd() < 0.25) continue;               // missed days
    const n = rnd() < 0.2 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const views = Math.round(200 + rnd() * 3000 * (1 + i / 4));
      posts.push({
        video_id: String(7600000000000000000n + BigInt(i * 1000 + d * 10 + k)), handle: h,
        created_at: new Date(start + d * DAY + k * 3 * 3600e3).toISOString(), views,
        likes: Math.round(views * 0.08), comments: Math.round(views * 0.01), shares: Math.round(views * 0.005),
        post_type: rnd() < 0.15 ? "photo" : "video", pinned: false, first_seen: "", last_seen: "", source: "profile",
        hashtags: tagsPool.filter(() => rnd() < 0.4).join(" "),
        missing_since: i === 5 && d === 2 ? "2026-10-06T16:00:00Z" : "",
      });
    }
  }
  for (let d = 0; d < 10; d++) for (const hh of [5, 16]) {
    const t = Date.parse("2026-09-28T00:00:00Z") + d * DAY + hh * 3600e3;
    if (t > NOW) continue;
    const mine = posts.filter((p) => p.handle === h && Date.parse(p.created_at) <= t);
    history.push({ timestamp: new Date(t).toISOString(), handle: h, total_views: mine.reduce((s, p) => s + p.views, 0),
      followers: 50 + i * 20 + d * 3, campaign_likes: mine.reduce((s, p) => s + p.likes, 0), campaign_posts: mine.length });
  }
});
const handles = tracked.map((h, i) => ({ handle: h, is_private: i === 1, followers: 50 + i * 20, last_scraped: "",
  last_status: i === 1 ? "privé" : i === 2 ? "fout: dead_page: not found" : "ok" }));
const runLog = [
  { timestamp: "2026-10-07T16:05:00Z", run_type: "profiles", window: "2026-10-07/18u", dry_run: false, expected_records: 11, actual_records: 11, errors: 0, status: "ok", snapshot_ids: "sd_x", notes: "11 profiles ok | budget: used 400" },
  { timestamp: "2026-10-02T06:40:00Z", run_type: "posts_refresh", window: "2026-10-02/weekrefresh", dry_run: false, expected_records: 80, actual_records: 12, errors: 0, status: "ok", snapshot_ids: "sd_y", notes: "" },
];
const activity = [{ timestamp: "2026-10-07T08:00:00Z", email: "docent@school.nl", action: "geopend", details: "" }];

const posted = [];
let finale = null;       // { start, end, phase } like the Worker returns
let finaleHasRun = false;
// post_history rows for the fake posts: a row every 2 hours for 3 days, growing views.
const postHistory = posts.flatMap((p) => {
  const c = Date.parse(p.created_at);
  return Array.from({ length: 36 }, (_, k) => [p.video_id, c + (k + 1) * 2 * 3600e3, Math.round(p.views * (1 - Math.exp(-(k + 1) / 8)))])
    .filter((r) => r[1] <= NOW);
});
function api(req, body) {
  const accounts = lib.parseAccounts(accountsSheet);
  if (req.method === "GET" && req.url === "/api/data") {
    return [200, { me: "docent@school.nl", serverTime: NOW,
      config: { campaign: CFG.campaign, budget: CFG.budget, schedule: CFG.schedule, refreshNumOfPosts: CFG.refreshNumOfPosts,
        forceMinMinutes: CFG.forceMinMinutes, finale: CFG.finale, offDays: CFG.offDays },
      finale, finaleHasRun,
      accounts, handles, history, posts, runLog, activity,
      budget: lib.budget(CFG, runLog, tracked.length, NOW), lastProfilesRun: lib.lastProfilesRun(runLog) }];
  }
  if (req.method === "GET" && req.url === "/api/post-history") return [200, { rows: postHistory }];
  if (req.method === "GET" && req.url === "/api/runs") {
    return [200, { runs: [{ workflow: "force-refresh.yml", status: "completed", conclusion: "success", event: "workflow_dispatch", created: "2026-10-07T15:00:00Z", url: "https://github.com/" }] }];
  }
  if (req.method === "POST") {
    if (req.headers["x-requested-with"] !== "tiktok-beheer") return [403, { error: "Ontbrekende header" }];
    posted.push({ url: req.url, body });
    if (req.url === "/api/refresh") return [409, { error: "De laatste profielrun was 5 min geleden. Verversen kan weer over 25 min." }];
    if (req.url === "/api/accounts") {
      const { handle } = lib.normalizeHandle(body.handle);
      accountsSheet.push({ _row: accountsSheet.length + 2, student_name: body.name, tiktok_handle: handle, active: body.active ? "ja" : "nee" });
      return [200, { ok: true, message: `@${handle} toegevoegd.` }];
    }
    if (req.url === "/api/accounts/active") {
      const row = accountsSheet.find((r) => r._row === body.row);
      row.active = body.active ? "ja" : "nee";
      return [200, { ok: true, message: "ok" }];
    }
    if (req.url === "/api/log") return [200, { ok: true }];
    if (req.url === "/api/finale/start") {
      const [d, t] = String(body.deadline).split("T");
      finale = { start: Date.now(), end: lib.amsMs(d, t), phase: "live", startedBy: "docent@school.nl" };
      finaleHasRun = true;
      return [200, { ok: true, message: "Finale gestart." }];
    }
    if (req.url === "/api/finale/stop") {
      finale = body.mode === "cancel" ? null : { ...finale, end: Date.now() - 1000, phase: "ended" };
      return [200, { ok: true, message: "Finale gestopt." }];
    }
  }
  return [404, { error: "Onbekende route" }];
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.url.startsWith("/api/")) {
      const [status, data] = api(req, body ? JSON.parse(body) : undefined);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }
    let path = normalize(join(ROOT, decodeURIComponent(req.url.split("?")[0])));
    if (!path.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(readFileSync(path));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

// ---------- checks ----------
let failed = false;
const fail = (msg) => { failed = true; console.log(`FAIL ${msg}`); };
const browser = await chromium.launch({ executablePath });

async function open(viewport, path = "") {
  const page = await browser.newPage({ viewport, acceptDownloads: true });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  // A 409 from the fake API is an expected answer (refresh cooldown), not a page error.
  page.on("console", (m) => m.type() === "error" && !/status of 409/.test(m.text()) && page.errors.push(m.text()));
  if (process.env.CDN_SHIM) await (await import(process.env.CDN_SHIM)).default(page);
  await page.goto(base + path);
  return page;
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  const tag = `${viewport.width}px`;
  const page = await open(viewport, "#overzicht");
  await page.waitForSelector("#ov-body tr[data-handle]");
  for (const view of ["overzicht", "leerlingen", "hashtags", "presentatie", "beheer", "export"]) {
    await page.evaluate((v) => { location.hash = v; }, view);
    await page.waitForTimeout(250);
    if (!(await page.isVisible(`#view-${view}`))) fail(`${tag}: tab ${view} not shown`);
    if (!(await noHScroll(page))) fail(`${tag}: tab ${view} scrolls sideways`);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/private-${view}-${tag}.png`, fullPage: true });
  }
  if (page.errors.length) fail(`${tag}: browser errors: ${page.errors.join(" | ")}`);
  console.log(`${tag}: all tabs open, no sideways scroll`);
  await page.close();
}

const page = await open({ width: 1280, height: 900 }, "#overzicht");
await page.waitForSelector("#ov-body tr[data-handle]");
const rows = await page.$$eval("#ov-body tr[data-handle]", (r) => r.length);
const text = await page.textContent("#ov-body");
console.log(`overzicht: ${rows} rows`);
if (rows !== tracked.length) fail(`overzicht shows ${rows} rows, expected ${tracked.length}`);
for (const w of ["privé", "niet gevonden", "verdwenen", "geen post"]) if (!text.includes(w)) fail(`overzicht: no "${w}" warning`);
if (!(await page.$("#ov-body mark.unknown"))) fail("overzicht: empty name not highlighted as onbekend");
await page.click('#ov-table th[data-sort="name"] button');
const namesAsc = await page.$$eval("#ov-body tr td:nth-child(2)", (t) => t.map((x) => x.firstChild.textContent.trim()));
await page.click('#ov-table th[data-sort="name"] button');
const namesDesc = await page.$$eval("#ov-body tr td:nth-child(2)", (t) => t.map((x) => x.firstChild.textContent.trim()));
if (namesAsc[0] !== "Anna" || namesDesc[0] !== "Kim") fail(`overzicht: sort by name wrong (${namesAsc[0]} / ${namesDesc[0]})`);
await page.check("#ov-warn");
const warnRows = await page.$$eval("#ov-body tr[data-handle]", (r) => r.length);
console.log(`overzicht: sort by name ok=${namesAsc[0] === "Anna"}, with warning=${warnRows}`);

await page.evaluate(() => { location.hash = "leerlingen"; });
await page.waitForSelector(".heat tbody tr");
const heatRows = await page.$$eval(".heat tbody tr", (r) => r.length);
const missCells = await page.$$eval(".heat td.miss", (c) => c.length);
const days = await page.$$eval(".heat thead th", (c) => c.length - 4);
// Free days (weekends, Herfstvakantie) are "vrij", never "gemist"; the first column is Monday 28 Sep.
const offMissed = await page.$$eval(".heat tbody tr", (rows) => rows.flatMap((r) =>
  [...r.querySelectorAll("td.day")].filter((c, i) => [5, 6].includes(i % 7) && c.classList.contains("miss"))).length);
const offCells = await page.$$eval(".heat td.off", (c) => c.length);
console.log(`leerlingen: ${heatRows} rows x ${days} days, ${missCells} missed cells, ${offCells} free-day cells`);
if (heatRows !== tracked.length || days !== lib.campaignDays(CFG).length) fail("leerlingen: heatmap has the wrong size");
if (!missCells) fail("leerlingen: no missed days marked");
if (!offCells || offMissed) fail(`leerlingen: free days wrong (${offCells} vrij, ${offMissed} weekend cells marked gemist)`);
await page.click(".heat tbody tr:first-child");
await page.waitForSelector(".cal");
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/private-student.png`, fullPage: true });
const tiles = await page.$$eval("#ll-content .tile .label", (t) => t.map((x) => x.textContent));
for (const t of ["Gemiste dagen", "Reeks", "Gem. weergaven/post", "Engagement", "Beste video"]) if (!tiles.includes(t)) fail(`student detail: no ${t}`);
console.log(`student detail: ${tiles.length} tiles, posts=${await page.$$eval("#ll-content tbody tr", (r) => r.length)}`);

await page.evaluate(() => { location.hash = "hashtags"; });
await page.waitForSelector("#tags-body tr[data-tag]");
await page.click("#tags-body tr[data-tag]");
const tagUsers = await page.$$eval("#tags-body .chip", (c) => c.length);
console.log(`hashtags: ${await page.$$eval("#tags-body tr[data-tag]", (r) => r.length)} tags, first used by ${tagUsers}`);
if (!tagUsers) fail("hashtags: clicking a tag shows no students");

await page.evaluate(() => { location.hash = "beheer"; });
await page.waitForSelector("#acc-body tr");
const budgetText = await page.textContent("#bh-budget");
if (!budgetText.includes(String(CFG.budget.monthlyCap).replace(/\B(?=(\d{3})+(?!\d))/g, "."))) fail("beheer: budget does not show the cap");
const issuesText = await page.textContent("#acc-issues");
if (!issuesText.includes("Rij 14") || !issuesText.includes("onbekend")) fail(`beheer: problems list incomplete: ${issuesText}`);
await page.fill('#add-form [name="handle"]', "https://www.tiktok.com/@Nieuw.Account");
const preview = await page.textContent("#add-preview");
if (!preview.includes("@nieuw.account")) fail(`beheer: handle preview wrong: ${preview}`);
await page.fill('#add-form [name="name"]', "Nora");
await page.click('#add-form button[type="submit"]');
await page.waitForFunction(() => document.getElementById("add-preview").textContent.includes("toegevoegd"));
const added = posted.find((p) => p.url === "/api/accounts");
if (!added || added.body.name !== "Nora") fail("beheer: add student did not post");
page.once("dialog", (d) => d.accept());
await page.click('#acc-body button[data-active="false"]');
await page.waitForTimeout(500);
if (!posted.some((p) => p.url === "/api/accounts/active" && p.body.active === false)) fail("beheer: deactivate did not post");
await page.click("#bh-refresh");
await page.waitForFunction(() => document.getElementById("bh-refresh-msg").textContent.includes("min"));
console.log(`beheer: refresh message "${await page.textContent("#bh-refresh-msg")}"`);

await page.evaluate(() => { location.hash = "export"; });
await page.waitForSelector("#exp-preview th");
const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exp-download")]);
const csv = readFileSync(await download.path(), "utf8");
const lines = csv.trim().split(/\r\n/);
console.log(`export: ${download.suggestedFilename()}, ${lines.length - 1} rows, header starts "${lines[0].slice(0, 30)}"`);
if (!csv.startsWith("﻿naam;handle;")) fail("export: no BOM or wrong separator");
if (lines.length - 1 < tracked.length) fail("export: missing rows");
await page.waitForTimeout(300);
if (!posted.some((p) => p.url === "/api/log" && p.body.action === "export")) fail("export: not logged");
if (page.errors.length) fail(`browser errors: ${page.errors.join(" | ")}`);
await page.close();

// Finale from Beheer: explanation with cost per hour, start with a deadline, LIVE banner, stop.
{
  const fp = await open({ width: 1280, height: 900 }, "#beheer");
  await fp.waitForSelector("#finale-start");
  if (await fp.isVisible("#reminder")) fail("reminder banner visible outside the reminder period");
  const card = await fp.textContent("#bh-finale");
  if (!/records per uur/.test(card) || !/elke 15 minuten/.test(card) || !/Eindstand/.test(card)) fail("finale card: explanation or cost per hour missing");
  const est = await fp.textContent("#finale-start-estimate");
  if (!/runs × \d+ accounts/.test(est)) fail(`finale card: no estimate (${est})`);
  fp.once("dialog", (d) => d.accept());
  await fp.click('#finale-start button[type="submit"]');
  await fp.waitForSelector("#finale-stop", { timeout: 10000 });
  const started = posted.find((x) => x.url === "/api/finale/start");
  if (!started || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(started.body.deadline)) fail("finale: start did not post a deadline");
  await fp.waitForTimeout(1200);
  const banner = await fp.textContent("#finale-banner");
  if (!/LIVE/.test(banner) || !/\d+:\d{2}:\d{2}/.test(banner)) fail(`finale: no LIVE countdown banner (${banner})`);
  if (process.env.SHOTS) await fp.screenshot({ path: `${process.env.SHOTS}/private-finale-live.png`, fullPage: true });
  fp.once("dialog", (d) => d.accept());
  await fp.click("#finale-stop");
  await fp.waitForFunction(() => /Eindstand/.test(document.getElementById("finale-banner").textContent), null, { timeout: 10000 });
  await fp.evaluate(() => { location.hash = "overzicht"; });
  await fp.waitForTimeout(300);
  const finalTitle = await fp.$eval("#ov-final", (e) => (e.hidden ? "" : e.textContent));
  console.log(`finale: start → "${banner.trim().slice(0, 40)}…", stop → Overzicht "${finalTitle}"`);
  if (!/Eindstand/.test(finalTitle)) fail("finale: no Eindstand on Overzicht after stopping");
  if (fp.errors.length) fail(`finale: browser errors: ${fp.errors.join(" | ")}`);
  await fp.close();
}
// Reminder: from 3 days before campaign.end, until a finale has run.
{
  finale = null;
  finaleHasRun = false;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.clock.install({ time: new Date(`${lib.addDays(CFG.campaign.end, -2)}T10:00:00+02:00`) });
  const rp = await ctx.newPage();
  if (process.env.CDN_SHIM) await (await import(process.env.CDN_SHIM)).default(rp);
  await rp.goto(base + "#overzicht");
  await rp.waitForSelector("#ov-body tr");
  await rp.waitForTimeout(300);
  const text = await rp.$eval("#reminder", (e) => (e.hidden ? "" : e.textContent));
  console.log(`reminder 2 days before the end: "${text.slice(0, 70)}…"`);
  if (!/Vergeet niet de finale te starten/.test(text)) fail("reminder banner missing before the campaign end");
  finaleHasRun = true;
  await rp.reload();
  await rp.waitForSelector("#ov-body tr");
  if (!(await rp.$eval("#reminder", (e) => e.hidden))) fail("reminder still shown after a finale has run");
  await ctx.close();
  finaleHasRun = false;
}
// Stijgers (per video) and the per-video chart on a student page.
{
  const sp = await open({ width: 1280, height: 900 }, "#stijgers");
  await sp.waitForSelector("#vid-body tr[data-handle]", { timeout: 10000 });
  const n = await sp.$$eval("#vid-body tr[data-handle]", (r) => r.length);
  await sp.click('#vid-range button[data-v="2"]');
  await sp.click("#vid-body tr[data-handle]");
  await sp.waitForSelector("#st-videos:not([hidden])", { timeout: 10000 });
  const note = await sp.textContent("#st-videos-note");
  console.log(`stijgers: ${n} videos; student page: "${note.slice(0, 50)}…"`);
  if (!n) fail("stijgers: no videos");
  if (sp.errors.length) fail(`stijgers: browser errors: ${sp.errors.join(" | ")}`);
  await sp.close();
}

// Presentation with first names (copied from the public site by build.sh).
const pres = await open({ width: 1280, height: 720 }, "present/index.html?present&sec=60");
await pres.waitForSelector("#p-stage[data-kind='podium'] .p-pod-handle", { timeout: 20000 });
if (process.env.SHOTS) await pres.screenshot({ path: `${process.env.SHOTS}/private-present.png` });
const podium = await pres.$$eval(".p-pod-handle", (p) => p.map((x) => x.textContent.trim()));
console.log(`presentatie: podium ${JSON.stringify(podium)}`);
if (!podium.some((t) => /^[A-Z][a-z]+ ?@test_/.test(t))) fail("presentatie: no first names on the podium");
if (pres.errors.length) fail(`presentatie: browser errors: ${pres.errors.join(" | ")}`);
await pres.close();
// With names the slides must still fit both projector resolutions.
for (const [w, h] of [[1920, 1080], [1280, 720]]) {
  const pp = await open({ width: w, height: h }, "present/index.html?present&sec=60");
  await pp.waitForSelector("#p-dots button.on", { timeout: 20000 });
  const total = await pp.$$eval("#p-dots button", (b) => b.length);
  for (let i = 0; i < total; i++) {
    await pp.waitForTimeout(600);
    const m = await pp.evaluate(() => {
      const st = document.getElementById("p-stage");
      return { kind: st.dataset.kind, over: st.scrollHeight > st.clientHeight + 1 || st.scrollWidth > st.clientWidth + 1 };
    });
    if (m.over) fail(`presentatie ${w}x${h}: slide ${i + 1} (${m.kind}) does not fit`);
    await pp.keyboard.press("ArrowRight");
  }
  console.log(`presentatie ${w}x${h}: ${total} slides checked`);
  await pp.close();
}

await browser.close();
server.close();
console.log(failed ? "Private check FAILED" : "Private check passed");
process.exit(failed ? 1 : 0);
