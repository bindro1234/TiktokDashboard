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
  // Anna has a second account (brand + ads): counted together everywhere.
  { _row: 16, student_name: "Anna", tiktok_handle: "test_13", active: "ja", main_account: "test_01" },
];
// Instagram: one account per student, typed on the first row in different ways; most students have none yet.
Object.assign(accountsSheet[0], { instagram_handle: "@Anna.Gram" });
Object.assign(accountsSheet[1], { instagram_handle: "https://www.instagram.com/bram.ig/?igsh=x" });
Object.assign(accountsSheet[2], { instagram_handle: "chris.ig" });
Object.assign(accountsSheet[3], { instagram_handle: "https://www.instagram.com/p/DeRh47eptOn" }); // a post link: invalid
// Pim has only Instagram (no TikTok handle at all).
accountsSheet.push({ _row: 17, student_name: "Pim", tiktok_handle: "", instagram_handle: "@Pim.Only", active: "ja" });
// Instagram counts from this day (the real config says 2026-10-07; earlier here so the calendar can show posts on both platforms).
const IG_START = "2026-09-30";
const igConfig = { ...CFG.instagram, startDate: IG_START };
const tracked = lib.parseAccounts(accountsSheet).filter((a) => a.tracked).map((a) => a.handle);
const igTracked = lib.parseAccounts(accountsSheet).filter((a) => a.instagramTracked).map((a) => a.instagram);
const students = lib.groupAccounts(lib.parseAccounts(accountsSheet)).size; // rows per student
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
      // test_11 is the outlier ("buiten schaal"): ~200x the views of the rest, so it gains
      // 7-digit numbers a day (like the real 2.3M account: "+1.863.580").
      const views = Math.round((200 + rnd() * 3000 * (1 + i / 4)) * (i === 10 ? 200 : 1));
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
// Instagram posts (ig_posts): Anna posts on Instagram on 30 Sep, 1 and 2 Oct (next to TikTok), Chris posts on Instagram on two of
// the days he missed on TikTok, Bram has none, Pim (only Instagram) posts on 30 Sep and 2 Oct plus two posts on 5 Oct.
const igPosts = [], igHistory = [];
const igPost = (handle, iso, type = "reel", tags = "glu fotografie") => igPosts.push({ post_id: String(3000000000000000000n + BigInt(igPosts.length)), handle,
  created_at: iso, post_type: type, hashtags: tags, url: `https://www.instagram.com/${type === "reel" ? "reel" : "p"}/X${igPosts.length}/`, first_seen: iso, last_seen: iso });
for (const day of ["2026-09-30", "2026-10-01", "2026-10-02"]) igPost("anna.gram", `${day}T09:15:00Z`);
const chrisMissed = lib.studentStats(posts.filter((p) => p.handle === "test_03"), CFG, NOW, []).missedList;
const chrisRescued = chrisMissed.slice(0, 2);
for (const day of chrisRescued) igPost("chris.ig", `${day}T12:00:00Z`, "photo");
for (const day of ["2026-09-30", "2026-10-02"]) igPost("pim.only", `${day}T14:00:00Z`, "carousel");
igPost("pim.only", "2026-10-05T08:00:00Z"); igPost("pim.only", "2026-10-05T18:00:00Z");
igPost("pim.only", "2026-10-07T10:00:00Z"); igPost("pim.only", "2026-10-07T13:00:00Z", "photo"); // today: reaches the dagopdracht (2)
igTracked.forEach((h, i) => {
  for (const day of ["2026-09-30", "2026-10-07"]) {
    igHistory.push({ timestamp: `${day}T05:00:00Z`, handle: h, followers: 100 + i * 10 + (day === "2026-10-07" ? 7 : 0), following: 50, posts_count: 20,
      is_private: false, campaign_posts: igPosts.filter((p) => p.handle === h).length });
  }
});
const igBaseline = igTracked.map((h, i) => ({ handle: h, baseline_at: "2026-09-30T05:00:00Z", baseline_followers: 100 + i * 10 }));
// Opvallend: test_05's biggest video gets almost no likes, test_11's first video no comments or shares.
Object.assign(posts.filter((p) => p.handle === "test_05").sort((a, b) => b.views - a.views)[0], { likes: 1 });
Object.assign(posts.find((p) => p.handle === "test_11"), { comments: 0, shares: 0 });
const igHandles = igTracked.map((h, i) => ({ handle: h, is_private: h === "bram.ig", followers: 100 + i * 10 + 7, last_scraped: "",
  last_status: h === "bram.ig" ? "privé" : h === "chris.ig" ? "fout: dead_page: not found" : "ok",
  status_since: h === "bram.ig" ? "2026-10-04T08:00:00Z" : h === "chris.ig" ? "2026-10-05T14:00:00Z" : "2026-09-30T06:00:00Z" }));
const handles = tracked.map((h, i) => ({ handle: h, is_private: i === 1, followers: 50 + i * 20, last_scraped: "",
  last_status: i === 1 ? "privé" : i === 2 ? "fout: dead_page: not found" : "ok",
  status_since: i === 1 ? "2026-10-03T08:00:00Z" : i === 2 ? "2026-10-05T14:00:00Z" : "2026-09-28T06:00:00Z" }));
// Dagopdrachten: Thu 1 Oct (minimum 2, over) and today (Wed 7 Oct, minimum 2, still pending).
let tasks = [{ row: 2, date: "2026-10-01", min: 2, label: "Dubbeldag" }, { row: 3, date: "2026-10-07", min: 2, label: "" }];
const outliers = new Set(["test_11"]);
const runLog = [
  { timestamp: "2026-10-07T16:05:00Z", run_type: "profiles", window: "2026-10-07/18u", dry_run: false, expected_records: 11, actual_records: 11, errors: 0, status: "ok", snapshot_ids: "sd_x", notes: "11 profiles ok | budget: used 400" },
  { timestamp: "2026-10-02T06:40:00Z", run_type: "posts_refresh", window: "2026-10-02/weekrefresh", dry_run: false, expected_records: 80, actual_records: 12, errors: 0, status: "ok", snapshot_ids: "sd_y", notes: "" },
];
const activity = [{ timestamp: "2026-10-07T08:00:00Z", email: "docent@school.nl", action: "geopend", details: "" }];

const posted = [];
let todayStarted = null;
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
        forceMinMinutes: CFG.forceMinMinutes, finale: CFG.finale, offDays: CFG.offDays, todayCheck: CFG.todayCheck, signals: CFG.signals,
        frequency: CFG.frequency, instagram: igConfig },
      finale, finaleHasRun,
      accounts, handles, history, posts, igHandles, igHistory, igPosts, igBaseline, runLog, activity,
      budget: lib.budget(CFG, runLog, { tiktok: tracked.length, instagram: accounts.filter((a) => a.instagramTracked).length }, NOW),
      lastProfilesRun: lib.lastProfilesRun(runLog), lastInstagramRun: null,
      lastTodayCheck: null, tasks, outliers: [...outliers] }];
  }
  if (req.method === "GET" && req.url === "/api/post-history") return [200, { rows: postHistory }];
  if (req.method === "GET" && req.url === "/api/runs") {
    return [200, { runs: [{ workflow: "force-refresh.yml", status: "completed", conclusion: "success", event: "workflow_dispatch", created: "2026-10-07T15:00:00Z", url: "https://github.com/" },
      ...(todayStarted ? [{ workflow: "collect.yml", status: "completed", conclusion: "success", event: "workflow_dispatch", created: new Date(todayStarted + 5000).toISOString(), url: "https://github.com/" }] : [])] }];
  }
  if (req.method === "POST") {
    if (req.headers["x-requested-with"] !== "tiktok-beheer") return [403, { error: "Ontbrekende header" }];
    posted.push({ url: req.url, body });
    if (req.url === "/api/refresh") return [409, { error: "De laatste profielrun was 5 min geleden. Verversen kan weer over 25 min." }];
    if (req.url === "/api/accounts") {
      const { handle } = lib.normalizeHandle(body.handle);
      // A second account (main) is recorded but not added, so the rest of the check keeps the same class.
      if (!body.main) accountsSheet.push({ _row: accountsSheet.length + 2, student_name: body.name, tiktok_handle: handle,
        instagram_handle: body.instagram || "", active: body.active ? "ja" : "nee" });
      return [200, { ok: true, message: `@${handle} toegevoegd.` }];
    }
    if (req.url === "/api/accounts/instagram") {
      const row = accountsSheet.find((r) => r._row === body.row);
      const { handle } = lib.normalizeInstagramHandle(body.handle);
      if (body.handle && !handle) return [400, { error: "Instagram-handle: geen geldige Instagram-handle." }];
      row.instagram_handle = handle || "";
      return [200, { ok: true, message: handle ? `Instagram van ${row.student_name}: @${handle} opgeslagen.` : "Instagram-handle verwijderd." }];
    }
    if (req.url === "/api/accounts/active") {
      const row = accountsSheet.find((r) => r._row === body.row);
      row.active = body.active ? "ja" : "nee";
      return [200, { ok: true, message: "ok" }];
    }
    if (req.url === "/api/log") return [200, { ok: true }];
    if (req.url === "/api/outliers") {
      if (body.on) outliers.add(body.handle); else outliers.delete(body.handle);
      return [200, { ok: true, message: `@${body.handle} ${body.on ? "buiten" : "in"} schaal.` }];
    }
    if (req.url === "/api/tasks") {
      if (body.action === "add") tasks = [...tasks, { row: 10 + tasks.length, date: body.date, min: body.min, label: body.label }];
      if (body.action === "remove") tasks = tasks.filter((t) => t.row !== body.row);
      return [200, { ok: true, message: "Dagopdracht opgeslagen." }];
    }
    if (req.url === "/api/today/check") {
      todayStarted = Date.now();
      return [200, { ok: true, count: 3, startedAt: todayStarted, message: "Controle gestart voor 3 accounts (3 records)." }];
    }
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
  for (const view of ["overzicht", "vandaag", "leerlingen", "hashtags", "stijgers", "opvallend", "presentatie", "beheer", "export"]) {
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

// Student pages at phone size (the Instagram table and tiles must not push the page sideways), also the sub-rows of Overzicht.
{
  const sp = await open({ width: 390, height: 844 }, "#leerlingen/test_01");
  await sp.waitForSelector("#st-ig-posts");
  if (!(await noHScroll(sp))) fail("390px: student page with Instagram scrolls sideways");
  await sp.evaluate(() => { location.hash = "leerlingen/instagram:pim.only"; });
  await sp.waitForSelector("#st-ig-posts");
  if (!(await noHScroll(sp))) fail("390px: Instagram-only student page scrolls sideways");
  await sp.evaluate(() => { location.hash = "overzicht"; });
  await sp.waitForSelector('#ov-body button[data-open="test_01"]');
  await sp.click('#ov-body button[data-open="test_01"]');
  if (!(await noHScroll(sp))) fail("390px: Overzicht with the Instagram sub-row scrolls sideways");
  if (process.env.SHOTS) await sp.screenshot({ path: `${process.env.SHOTS}/private-overzicht-sub-390px.png`, fullPage: true });
  if (sp.errors.length) fail(`390px student pages: browser errors: ${sp.errors.join(" | ")}`);
  console.log("390px: student pages and Overzicht sub-rows fit");
  await sp.close();
}

const page = await open({ width: 1280, height: 900 }, "#overzicht");
await page.waitForSelector("#ov-body tr[data-handle]");
const rows = await page.$$eval("#ov-body tr[data-handle]", (r) => r.length);
const text = await page.textContent("#ov-body");
console.log(`overzicht: ${rows} rows`);
if (rows !== students) fail(`overzicht shows ${rows} rows, expected ${students} (one per student)`);
// Anna's two accounts: one row with both handles, and a row per account behind "▸ 2 accounts".
const annaRow = await page.textContent('#ov-body tr[data-handle="test_01"]');
if (!annaRow.includes("@test_01 + @test_13")) fail(`overzicht: two accounts not shown together (${annaRow.slice(0, 80)})`);
await page.click('#ov-body td.wide-only button[data-open="test_01"]');
const subRows = await page.$$eval("#ov-body tr.sub-row", (r) => r.map((x) => x.dataset.handle));
console.log(`overzicht: Anna = @test_01 + @test_13, per account: ${subRows.join(", ")}`);
if (!annaRow.includes("IG @anna.gram")) fail(`overzicht: Anna's Instagram handle not shown (${annaRow.slice(0, 120)})`);
if (subRows.join() !== "test_01,test_13,instagram:anna.gram") fail(`overzicht: per-account rows wrong (${subRows})`);
const igSub = await page.textContent('#ov-body tr.sub-row[data-handle="instagram:anna.gram"]');
if (!/Instagram/.test(igSub) || !igSub.includes("@anna.gram")) fail(`overzicht: Instagram sub-row wrong (${igSub.slice(0, 100)})`);
const sumOk = await page.evaluate(() => {
  const num = (tr) => Number(tr.children[3].textContent.replace(/\D/g, ""));
  const subs = [...document.querySelectorAll("#ov-body tr.sub-row")];
  return num(document.querySelector('#ov-body tr[data-handle="test_01"]:not(.sub-row)')) === subs.reduce((n, tr) => n + num(tr), 0);
});
if (!sumOk) fail("overzicht: Anna's views are not the sum of her two accounts");
await page.click('#ov-body td.wide-only button[data-open="test_01"]');
for (const w of ["privé", "niet gevonden", "verdwenen", "geen post", "privé (Instagram)", "niet gevonden (Instagram)", "privé (TikTok)"]) if (!text.includes(w)) fail(`overzicht: no "${w}" warning`);
// Pim has only Instagram: a row with the Instagram handle, no TikTok handle.
const pimRow = await page.textContent('#ov-body tr[data-handle="instagram:pim.only"]');
if (!pimRow.includes("IG @pim.only") || pimRow.includes("@test")) fail(`overzicht: Instagram-only student wrong (${pimRow.slice(0, 120)})`);
if (!(await page.textContent("#ov-tiles")).includes("TikTok") || !/Instagram \d+/.test(await page.textContent("#ov-tiles"))) fail("overzicht: posts tile does not split TikTok and Instagram");
if (!(await page.$eval("#ov-ig-note", (e) => e.hidden))) fail("overzicht: 'Instagram nog niet opgehaald' shown although Instagram data exists");
if (!(await page.$("#ov-body mark.unknown"))) fail("overzicht: empty name not highlighted as onbekend");
await page.click('#ov-table th[data-sort="name"] button');
const namesAsc = await page.$$eval("#ov-body tr td:nth-child(2)", (t) => t.map((x) => x.firstChild.textContent.trim()));
await page.click('#ov-table th[data-sort="name"] button');
const namesDesc = await page.$$eval("#ov-body tr td:nth-child(2)", (t) => t.map((x) => x.firstChild.textContent.trim()));
if (namesAsc[0] !== "Anna" || namesDesc[0] !== "Pim") fail(`overzicht: sort by name wrong (${namesAsc[0]} / ${namesDesc[0]})`);
// Actie nodig chips: name and @handle on one line, vertically centred on each other.
const chipOff = await page.$$eval("#ov-actions a.chip", (chips) => chips.map((a) => {
  const range = document.createRange();
  range.setStart(a.firstChild, 0);
  range.setEnd(a.firstChild, a.firstChild.textContent.trim().length);
  const name = range.getBoundingClientRect(), handle = a.querySelector(".chip-handle, .meta").getBoundingClientRect();
  return Math.round((handle.top + handle.height / 2) - (name.top + name.height / 2));
}));
const worstChip = chipOff.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
console.log(`overzicht: Actie nodig chips, @handle vs name centre: worst ${worstChip}px (${chipOff.length} chips)`);
if (Math.abs(worstChip) > 2) fail(`overzicht: handles in Actie nodig are ${worstChip}px off centre`);

// Actie nodig, median, clickable warnings (which video, since when).
const actions = await page.textContent("#ov-actions");
for (const w of ["Actie nodig", "Privé", "Niet gevonden", "Dagopdracht niet gehaald", "Dagopdracht vandaag"]) if (!actions.includes(w)) fail(`overzicht: Actie nodig has no "${w}"`);
if (!/mediaan per leerling/.test(await page.textContent("#ov-tiles"))) fail("overzicht: no median next to the total");
await page.click('#ov-body td.wide-only button[data-warn]:text("verdwenen")');
const detail = await page.textContent("#ov-body tr.warn-detail");
if (!/verdwenen sinds/.test(detail) || !/open ↗/.test(detail)) fail(`overzicht: warning details missing (${detail.slice(0, 80)})`);
await page.click('#ov-body td.wide-only button[data-warn]:text("privé")');
if (!/privé sinds/.test(await page.textContent("#ov-body tr.warn-detail"))) fail("overzicht: privé has no 'since'");
if (!(await page.textContent("#ov-body")).includes("opdracht 1 okt")) fail("overzicht: no dagopdracht badge");
console.log(`overzicht: actie nodig "${actions.replace(/\s+/g, " ").slice(0, 90)}…"`);
await page.check("#ov-warn");
const warnRows = await page.$$eval("#ov-body tr[data-handle]", (r) => r.length);
console.log(`overzicht: sort by name ok=${namesAsc[0] === "Anna"}, with warning=${warnRows}`);

await page.evaluate(() => { location.hash = "leerlingen"; });
await page.waitForSelector(".heat tbody tr");
const heatRows = await page.$$eval(".heat tbody tr", (r) => r.length);
const missCells = await page.$$eval(".heat td.miss", (c) => c.length);
const days = await page.$$eval(".heat tbody tr:first-child td.day", (c) => c.length);
// Free days (weekends, Herfstvakantie) are "vrij", never "gemist"; the first column is Monday 28 Sep.
const offMissed = await page.$$eval(".heat tbody tr", (rows) => rows.flatMap((r) =>
  [...r.querySelectorAll("td.day")].filter((c, i) => [5, 6].includes(i % 7) && c.classList.contains("miss"))).length);
const offCells = await page.$$eval(".heat td.off", (c) => c.length);
console.log(`leerlingen: ${heatRows} rows x ${days} days, ${missCells} missed cells, ${offCells} free-day cells`);
if (heatRows !== students || days !== lib.campaignDays(CFG).length) fail("leerlingen: heatmap has the wrong size");
// Two accounts: open the rows per account; a day is "gemist" for Anna only if neither account posted.
await page.click('#ll-content button[data-open="test_01"]');
const merge = await page.evaluate(() => {
  const cells = (tr) => [...tr.querySelectorAll("td.day")].map((c) => c.classList.contains("miss"));
  const main = cells(document.querySelector('#ll-content tr[data-handle="test_01"]:not(.sub-row)'));
  const subs = [...document.querySelectorAll("#ll-content tr.sub-row")].map(cells);
  const bad = main.filter((miss, i) => miss !== subs.every((s) => s[i])).length;
  return { subs: subs.length, bad, rescued: main.filter((miss, i) => !miss && subs.some((s) => s[i])).length };
});
console.log(`leerlingen: Anna per account ${merge.subs} rows; ${merge.rescued} days only one account posted (still counted); ${merge.bad} wrong`);
if (merge.subs !== 3 || merge.bad) fail(`leerlingen: accounts not combined right (${JSON.stringify(merge)})`);
// A student's row counts a post on either platform: Chris's missed days are his TikTok-missed days minus the two days he
// posted on Instagram, and Anna's three accounts add up (also: a tooltip names the platform).
{
  const days = lib.campaignDays(CFG);
  const chrisBoth = lib.studentStats([...posts.filter((p) => p.handle === "test_03"), ...lib.instagramPosts(igPosts.filter((p) => p.handle === "chris.ig"))], CFG, NOW, tasks);
  if (chrisMissed.length < 2 || chrisBoth.missedList.length !== chrisMissed.length - 2) fail("fixture: Chris's Instagram posts do not rescue two days");
  const missedCells = await page.$$eval('#ll-content tr[data-handle="test_03"]:not(.sub-row) td.day', (c) => c.map((x) => x.classList.contains("miss")));
  if (JSON.stringify(missedCells) !== JSON.stringify(days.map((d) => chrisBoth.missedList.includes(d)))) fail("leerlingen: Chris's missed days are not the combined TikTok + Instagram ones");
  console.log(`leerlingen: Chris missed ${chrisMissed.length} days on TikTok alone, ${chrisBoth.missedList.length} with Instagram`);
  const title = await page.$eval(`#ll-content tr[data-handle="test_01"]:not(.sub-row) td.day:nth-child(${days.indexOf("2026-10-01") + 2})`, (c) => c.title);
  if (!/op Instagram/.test(title)) fail(`leerlingen: tooltip has no platform (${title})`);
  // Pim has only Instagram, which was not followed before 30 Sep: 28 and 29 Sep are "vrij", not "gemist".
  const pim = await page.$$eval('#ll-content tr[data-handle="instagram:pim.only"] td.day', (c) => c.slice(0, 3).map((x) => x.className));
  if (!/\boff\b/.test(pim[0]) || !/\boff\b/.test(pim[1]) || /miss/.test(pim[0] + pim[1])) fail(`leerlingen: Pim's days before the Instagram start (${pim.join(" | ")})`);
  const pimTitle = await page.$eval('#ll-content tr[data-handle="instagram:pim.only"] td.day', (c) => c.title);
  if (!/nog niet gevolgd/.test(pimTitle)) fail(`leerlingen: Pim's first day has no explanation (${pimTitle})`);
  if (!(await page.textContent("#ll-content .legend-row")).includes("Stories worden niet meegeteld.")) fail("leerlingen: no note about stories");
}
if (!missCells) fail("leerlingen: no missed days marked");
if (!offCells || offMissed) fail(`leerlingen: free days wrong (${offCells} vrij, ${offMissed} weekend cells marked gemist)`);
const taskCells = await page.$$eval(".heat td.task-miss", (c) => c.map((x) => x.textContent));
console.log(`leerlingen: dagopdracht not reached in ${taskCells.length} cells, e.g. "${taskCells[0]}"`);
if (!taskCells.length || !taskCells.every((t) => /^[01]\/2$/.test(t))) fail(`leerlingen: dagopdracht cells wrong (${taskCells.join(",")})`);
if (!(await page.textContent(".heat thead")).includes("Opdr. niet gehaald")) fail("leerlingen: no 'opdrachten niet gehaald' column");
await page.click('#ll-content tr[data-handle="test_01"]:not(.sub-row) td.day');
await page.waitForSelector(".cal");
// Anna's page: both accounts together, or one of them.
const ttRows = "#ll-content table:not(#st-ig-posts) tbody tr";
const allPosts = await page.$$eval(ttRows, (r) => r.length);
const igRows = await page.$$eval("#st-ig-posts tbody tr", (r) => r.length);
if (igRows !== igPosts.filter((p) => p.handle === "anna.gram").length) fail(`student detail: ${igRows} Instagram posts, expected 3`);
const igHref = await page.$eval("#st-ig-posts tbody tr a", (a) => a.href);
if (!igHref.startsWith("https://www.instagram.com/")) fail(`student detail: Instagram post link wrong (${igHref})`);
await page.selectOption("#st-account", "test_13");
await page.waitForTimeout(200);
const onePosts = await page.$$eval(ttRows, (r) => r.length);
if (await page.$("#st-ig-posts")) fail("student detail: Instagram posts shown on a TikTok account alone");
const expected13 = posts.filter((p) => p.handle === "test_13").length;
console.log(`student detail: Anna ${allPosts} posts together, ${onePosts} on @test_13`);
if (onePosts !== expected13 || allPosts !== expected13 + posts.filter((p) => p.handle === "test_01").length) fail("student detail: account dropdown wrong");
await page.selectOption("#st-account", "");
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/private-student.png`, fullPage: true });
const igLink = await page.$eval("#ll-content .detail-head", (h) => [...h.querySelectorAll("a")].map((a) => a.textContent.trim()).filter((t) => /Instagram/.test(t)));
if (igLink.join() !== "@anna.gram op Instagram ↗") fail(`student detail: Instagram link wrong (${igLink.join()})`);
const tiles = await page.$$eval("#ll-content .tile .label", (t) => t.map((x) => x.textContent));
for (const t of ["Gemiste dagen", "Reeks", "Gem. weergaven/post", "Mediaan per video", "Engagement", "Beste video", "Weergaven (TikTok)", "Volgers (TikTok)", "Volgers (Instagram)"]) if (!tiles.includes(t)) fail(`student detail: no ${t}`);
const igTile = await page.$eval("#ll-content .tile:has(.label:text('Volgers (Instagram)'))", (t) => t.textContent);
if (!igTile.replace(/\s+/g, " ").includes("+7 sinds")) fail(`student detail: Instagram followers gained missing (${igTile})`);
console.log(`student detail: ${tiles.length} tiles, posts=${await page.$$eval(ttRows, (r) => r.length)}, Instagram ${igRows}`);
if (!(await page.textContent("#ll-content")).includes("Stories worden niet meegeteld.")) fail("student detail: no note about stories");
// The Instagram account alone: its own calendar and table, no TikTok numbers.
await page.selectOption("#st-account", "instagram:anna.gram");
await page.waitForTimeout(200);
const igOnlyTiles = await page.$$eval("#ll-content .tile .label", (t) => t.map((x) => x.textContent));
if (igOnlyTiles.some((t) => /Weergaven|Engagement|Mediaan/.test(t)) || !igOnlyTiles.includes("Volgers (Instagram)")) fail(`student detail: Instagram alone shows ${igOnlyTiles.join(", ")}`);
if (await page.$(ttRows)) fail("student detail: TikTok table on the Instagram account alone");
await page.selectOption("#st-account", "");
// A student with only Instagram: no TikTok links or tiles, the Instagram table, and a working row link.
await page.evaluate(() => { location.hash = "leerlingen/instagram:pim.only"; });
await page.waitForSelector("#st-ig-posts");
const pimTiles = await page.$$eval("#ll-content .tile .label", (t) => t.map((x) => x.textContent));
const pimLinks = await page.$$eval("#ll-content .detail-head a", (a) => a.map((x) => x.textContent.trim()));
if (pimTiles.some((t) => /Weergaven|Positie|Engagement/.test(t)) || pimLinks.join() !== "@pim.only op Instagram ↗") fail(`student detail: Instagram-only student wrong (${pimTiles.join(", ")} / ${pimLinks.join()})`);
if ((await page.$$eval("#st-ig-posts tbody tr", (r) => r.length)) !== igPosts.filter((p) => p.handle === "pim.only").length) fail("student detail: Pim's Instagram posts not all listed");
await page.evaluate(() => { location.hash = "leerlingen/test_01"; });
await page.waitForSelector(".cal");

// Vandaag: lists and "Controleer nu" with its cost.
await page.evaluate(() => { location.hash = "vandaag"; });
await page.waitForSelector("#td-todo li");
const cost = await page.textContent("#td-cost");
const todayCounts = await page.evaluate(() => ["td-todo-n", "td-done-n", "td-priv-n"].map((id) => document.getElementById(id).textContent));
console.log(`vandaag: nog niet/gepost/privé = ${todayCounts.join("/")}, knop: "${cost}"`);
if (!/\d+ accounts?, \d+ records?/.test(cost)) fail(`vandaag: no cost shown (${cost})`);
// "Controleer nu" fetches both platforms: the cost names them (Chris is the only one not done with a public Instagram account).
if (!/^(\d+) accounts, \1 records \((\d+) TikTok, 1 Instagram\)$/.test(cost)) fail(`vandaag: cost does not split TikTok and Instagram (${cost})`);
if (!(await page.textContent("#view-vandaag")).includes("TikTok- én Instagram-accounts")) fail("vandaag: the hint does not say that Instagram is fetched too");
if (todayCounts[2] !== "1") fail("vandaag: private account not listed separately");
// Pim (only Instagram) posted twice today on Instagram: done (dagopdracht 2), with the platform and a link to the post.
const pimToday = await page.$eval('#td-done li:has(a[href="#leerlingen/instagram%3Apim.only"])', (li) => ({ text: li.textContent.replace(/\s+/g, " "), href: li.querySelector('a[target]')?.href }));
if (!/2\/2/.test(pimToday.text) || !/op Instagram/.test(pimToday.text) || !pimToday.href?.startsWith("https://www.instagram.com/")) fail(`vandaag: Instagram-only student wrong (${JSON.stringify(pimToday)})`);
if (!/Instagram/.test(await page.textContent("#td-checked"))) fail("vandaag: last checked has no Instagram time");
if (!(await page.textContent("#view-vandaag")).includes("Stories worden niet meegeteld.")) fail("vandaag: no note about stories");
page.once("dialog", (d) => d.accept());
await page.click("#td-check");
await page.waitForFunction(() => /5–7 minuten|gestart/.test(document.getElementById("td-msg").textContent));
if (!posted.some((p) => p.url === "/api/today/check")) fail("vandaag: Controleer nu did not post");

// Opvallend: flags with their numbers.
await page.evaluate(() => { location.hash = "opvallend"; });
await page.waitForFunction(() => document.querySelectorAll("#sig-body tr").length && !/laden/.test(document.getElementById("sig-body").textContent));
const sig = await page.textContent("#sig-body");
console.log(`opvallend: ${await page.textContent("#sig-meta")}`);
for (const w of ["Likes per weergave", "Geen reacties of shares"]) if (!sig.includes(w)) fail(`opvallend: no "${w}" flag`);
if (/bot/i.test(sig)) fail("opvallend: says 'bot'");

await page.evaluate(() => { location.hash = "hashtags"; });
await page.waitForSelector("#tags-body tr[data-tag]");
if (!(await page.isChecked("#tag-out"))) fail("hashtags: 'zonder buiten schaal' not on by default");
await page.click("#tags-body tr[data-tag]");
const tagUsers = await page.$$eval("#tags-body .chip", (c) => c.length);
console.log(`hashtags: ${await page.$$eval("#tags-body tr[data-tag]", (r) => r.length)} tags, first used by ${tagUsers}`);
if (!tagUsers) fail("hashtags: clicking a tag shows no students");

await page.evaluate(() => { location.hash = "beheer"; });
await page.waitForSelector("#acc-body tr");
const budgetText = await page.textContent("#bh-budget");
if (!budgetText.includes(String(CFG.budget.monthlyCap).replace(/\B(?=(\d{3})+(?!\d))/g, "."))) fail("beheer: budget does not show the cap");
// Two platforms: runs and accounts per platform, one cap; the schedule says how often each is pulled.
const igAccounts = lib.parseAccounts(accountsSheet).filter((a) => a.instagramTracked).length;
if (!/TikTok: nog \d+ geplande profielruns deze maand × 13 accounts/.test(budgetText)) fail(`beheer: no TikTok budget line: ${budgetText.slice(0, 200)}`);
if (!new RegExp(`Instagram: nog \\d+ geplande profielruns deze maand × ${igAccounts} accounts`).test(budgetText)) fail(`beheer: no Instagram budget line: ${budgetText.slice(0, 300)}`);
const scheduleText = await page.textContent("#bh-schedule");
if (!/TikTok: 2× per dag, elke 12 uur: 08:00, 20:00/.test(scheduleText)) fail(`beheer: TikTok schedule wrong: ${scheduleText.slice(0, 200)}`);
if (!/Instagram: 6× per dag, elke 4 uur: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00/.test(scheduleText)) fail(`beheer: Instagram schedule wrong: ${scheduleText.slice(0, 300)}`);
console.log(`beheer: schedule "${scheduleText.replace(/\s+/g, " ").slice(0, 120)}…"`);
const issuesText = await page.textContent("#acc-issues");
if (!issuesText.includes("Rij 14") || !issuesText.includes("onbekend")) fail(`beheer: problems list incomplete: ${issuesText}`);
await page.fill('#add-form [name="handle"]', "https://www.tiktok.com/@Nieuw.Account");
const preview = await page.textContent("#add-preview");
if (!preview.includes("@nieuw.account")) fail(`beheer: handle preview wrong: ${preview}`);
await page.fill('#add-form [name="instagram"]', "https://www.instagram.com/Nora.IG/?igsh=1");
const preview2 = await page.textContent("#add-preview");
if (!preview2.includes("TikTok @nieuw.account + Instagram @nora.ig")) fail(`beheer: handle preview with Instagram wrong: ${preview2}`);
await page.fill('#add-form [name="instagram"]', "https://www.instagram.com/p/abc");
if (!(await page.textContent("#add-preview")).includes("Instagram kan niet")) fail("beheer: a post link is not refused in the preview");
await page.fill('#add-form [name="instagram"]', "https://www.instagram.com/Nora.IG/?igsh=1");
await page.fill('#add-form [name="name"]', "Nora");
await page.click('#add-form button[type="submit"]');
await page.waitForFunction(() => document.getElementById("add-preview").textContent.includes("toegevoegd"));
const added = posted.find((p) => p.url === "/api/accounts");
if (!added || added.body.name !== "Nora") fail("beheer: add student did not post");
if (added.body.instagram !== "https://www.instagram.com/Nora.IG/?igsh=1") fail(`beheer: add student did not post the Instagram field (${JSON.stringify(added.body)})`);

// Instagram handles: the list of active students without one, filled in from there; the table; no edit on a second account.
const groupsNow = [...lib.groupAccounts(lib.parseAccounts(accountsSheet)).values()];
const wantMissing = groupsNow.filter((g) => !g.instagram).length;
const missingNow = await page.$$eval("#ig-missing form[data-ig-quick]", (f) => f.length);
console.log(`beheer: ${missingNow} students without Instagram, of ${groupsNow.length}`);
if (missingNow !== wantMissing || !wantMissing) fail(`beheer: "zonder Instagram" list has ${missingNow}, expected ${wantMissing}`);
if (!(await page.textContent("#ig-count")).includes(`${wantMissing} van ${groupsNow.length}`)) fail("beheer: Instagram count wrong");
const withIssue = await page.$$eval("#ig-missing .badge.bad", (b) => b.map((x) => x.textContent));
if (!withIssue.some((t) => /post/.test(t))) fail(`beheer: the invalid Instagram link is not flagged in the list (${withIssue.join("|")})`);
if (!(await page.textContent("#acc-issues")).includes("Instagram")) fail("beheer: invalid Instagram handle missing from the problems list");
const anna = await page.$eval('#acc-body tr:has(button[data-ig-edit="2"])', (tr) => tr.children[3].querySelector("a")?.textContent.trim());
if (anna !== "@anna.gram") fail(`beheer: Instagram column shows "${anna}", expected @anna.gram`);
if (await page.$('#acc-body button[data-ig-edit="16"]')) fail("beheer: Instagram edit offered on a second TikTok account");
await page.fill('#ig-missing form[data-ig-quick] input', "@Quick.IG");
await page.click('#ig-missing form[data-ig-quick] button[type=submit]');
await page.waitForFunction(() => /opgeslagen/.test(document.getElementById("ig-msg").textContent));
const quick = posted.find((p) => p.url === "/api/accounts/instagram");
if (!quick || quick.body.handle !== "@Quick.IG" || quick.body.was !== "") fail(`beheer: quick Instagram did not post right (${JSON.stringify(quick && quick.body)})`);
await page.waitForFunction((n) => document.querySelectorAll("#ig-missing form[data-ig-quick]").length === n, wantMissing - 1);
// Change an existing handle from the table (was = the current one).
await page.click('#acc-body button[data-ig-edit="2"]');
await page.fill('#acc-body form[data-ig-form] [name=instagram]', "anna.new");
await page.click('#acc-body form[data-ig-form] button[type=submit]');
await page.waitForFunction(() => /opgeslagen/.test(document.getElementById("acc-msg").textContent));
const change = posted.filter((p) => p.url === "/api/accounts/instagram").at(-1);
if (change.body.row !== 2 || change.body.was !== "anna.gram" || change.body.handle !== "anna.new") fail(`beheer: Instagram change did not post right (${JSON.stringify(change.body)})`);
page.once("dialog", (d) => d.accept());
await page.click('#acc-body button[data-active="false"][data-handle="test_12"]');
await page.waitForTimeout(500);
if (!posted.some((p) => p.url === "/api/accounts/active" && p.body.active === false)) fail("beheer: deactivate did not post");
// "+ account": a second account for a student.
await page.click('#acc-body button[data-add-for="test_05"]');
await page.fill("#acc-body form[data-add-form] [name=handle]", "@Eva.Reclame");
await page.click("#acc-body form[data-add-form] button[type=submit]");
await page.waitForTimeout(500);
const second = posted.find((p) => p.url === "/api/accounts" && p.body.main);
if (!second || second.body.main !== "test_05" || second.body.handle !== "@Eva.Reclame") fail(`beheer: + account did not post right (${JSON.stringify(second && second.body)})`);
if (await page.$('#acc-body button[data-add-for="test_13"]')) fail("beheer: + account offered on a second account");
// Dagopdracht toevoegen en buiten schaal.
if ((await page.$$eval("#task-body tr", (r) => r.length)) !== 2) fail("beheer: dagopdrachten not listed");
await page.selectOption('#task-form [name="date"]', "2026-10-09");
await page.fill('#task-form [name="min"]', "3");
await page.click('#task-form button[type="submit"]');
await page.waitForFunction(() => /opgeslagen/.test(document.getElementById("task-msg").textContent));
const task = posted.find((p) => p.url === "/api/tasks");
if (!task || task.body.action !== "add" || task.body.date !== "2026-10-09" || task.body.min !== 3) fail(`beheer: dagopdracht not posted right (${JSON.stringify(task && task.body)})`);
await page.click('#acc-body button[data-outlier="test_04"]');
await page.waitForTimeout(400);
if (!posted.some((p) => p.url === "/api/outliers" && p.body.handle === "test_04" && p.body.on === true)) fail("beheer: buiten schaal did not post");
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
if (!lines[0].includes("opdrachten_niet_gehaald")) fail("export: no opdrachten_niet_gehaald column");
if (!lines[0].includes("mediaan_weergaven_per_video")) fail("export: no mediaan_weergaven_per_video column");
if (lines.length - 1 < students - 1) fail("export: missing rows");
if (!csv.includes("@test_01, @test_13")) fail("export: Anna's two accounts not on one row");
for (const col of ["tiktok_posts", "instagram_handle", "instagram_posts", "instagram_volgers", "instagram_volgers_sinds_start"]) if (!lines[0].includes(col)) fail(`export: no ${col} column`);
// Split a CSV line on ";" (fields with ";" inside are quoted, e.g. the warnings).
const cells = (line) => [...line.matchAll(/("(?:[^"]|"")*"|[^;]*)(;|$)/g)].slice(0, -1).map((m) => m[1].replace(/^"|"$/g, "").replace(/""/g, '"'));
const chrisLine = cells(lines.find((l) => l.startsWith("Chris;")));
const head = cells(lines[0]);
const col = (name) => chrisLine[head.indexOf(name)];
const chrisIg = igPosts.filter((p) => p.handle === "chris.ig").length;
// (Cells starting with @ get a leading ' so Excel does not read them as a formula.)
if (col("instagram_handle") !== "'@chris.ig" || col("instagram_posts") !== String(chrisIg) || col("instagram_volgers_sinds_start") !== "7") fail(`export: Chris's Instagram columns wrong (${col("instagram_handle")}, ${col("instagram_posts")}, ${col("instagram_volgers_sinds_start")})`);
if (Number(col("posts")) !== Number(col("tiktok_posts")) + chrisIg) fail("export: posts is not TikTok + Instagram");
if (!lines.find((l) => l.startsWith("Pim;;")) && !lines.find((l) => l.startsWith("Pim;"))) fail("export: Instagram-only student missing");
await page.waitForTimeout(300);
if (!posted.some((p) => p.url === "/api/log" && p.body.action === "export")) fail("export: not logged");
if (page.errors.length) fail(`browser errors: ${page.errors.join(" | ")}`);
await page.close();

// Before the very first Instagram run (no ig_* rows yet): one note on Overzicht instead of a badge on every student,
// and the Instagram handles still show.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const np = await ctx.newPage();
  if (process.env.CDN_SHIM) await (await import(process.env.CDN_SHIM)).default(np);
  await np.route("**/api/data", async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    await route.fulfill({ response: res, json: { ...data, igHandles: [], igHistory: [], igPosts: [], igBaseline: [] } });
  });
  await np.goto(base + "#overzicht");
  await np.waitForSelector("#ov-body tr[data-handle]");
  if (await np.$eval("#ov-ig-note", (e) => e.hidden)) fail("overzicht: no note that Instagram has not been fetched yet");
  if ((await np.textContent("#ov-body")).includes("nog niet opgehaald (Instagram)")) fail("overzicht: every student has a 'nog niet opgehaald (Instagram)' badge before the first Instagram run");
  if (!(await np.textContent('#ov-body tr[data-handle="test_01"]')).match(/IG @[\w.]+/)) fail("overzicht: Instagram handle missing before the first run");
  await np.evaluate(() => { location.hash = "vandaag"; });
  await np.waitForSelector("#td-todo li");
  if (/Instagram/.test(await np.textContent("#td-checked"))) fail("vandaag: shows an Instagram time before any Instagram run");
  console.log("overzicht: before the first Instagram run one note, no per-student badge");
  await ctx.close();
}

// Finale from Beheer: explanation with cost per hour, start with a deadline, LIVE banner, stop.
{
  const fp = await open({ width: 1280, height: 900 }, "#beheer");
  await fp.waitForSelector("#finale-start");
  if (await fp.isVisible("#reminder")) fail("reminder banner visible outside the reminder period");
  const card = await fp.textContent("#bh-finale");
  if (!/records per uur/.test(card) || !/elke 15 minuten/.test(card) || !/Eindstand/.test(card)) fail("finale card: explanation or cost per hour missing");
  // Dutch 24-hour fields instead of the browser's own date/time inputs ("02:00 AM").
  if (await fp.$('#bh-finale input[type="date"], #bh-finale input[type="time"]')) fail("finale card: native date/time inputs");
  const hours = await fp.$$eval('#finale-start [name="hour"] option', (o) => o.map((x) => x.textContent));
  const dayText = await fp.$eval('#finale-start [name="date"] option', (o) => o.textContent);
  if (hours.length !== 24 || hours[23] !== "23" || !/^(ma|di|wo|do|vr|za|zo) \d+ /.test(dayText)) fail(`finale card: not Dutch 24-hour fields (${dayText}, ${hours.length} hours)`);
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
// "Buiten schaal" never changes the rank: the outlier (test_11, 50x the views) is still number 1.
const first = await pres.$eval(".p-pod-1 .p-pod-handle", (e) => e.textContent);
if (!first.includes("@test_11")) fail(`presentatie: outlier lost its place on the podium (${first})`);
if (pres.errors.length) fail(`presentatie: browser errors: ${pres.errors.join(" | ")}`);
await pres.close();
// The public site's own pages with the same data (build.sh copies them): Grafiek and Groei scale
// without the outlier, the Stand keeps it at its place.
{
  const sp = await open({ width: 1280, height: 900 }, "present/index.html#grafiek");
  await sp.waitForFunction(() => window.Chart && Chart.getChart(document.getElementById("chart-main")), null, { timeout: 20000 });
  const g = await sp.evaluate(() => {
    const c = Chart.getChart(document.getElementById("chart-main"));
    return { max: c.scales.y.max, marks: c.data.datasets.filter((d) => d.outlierMark).map((d) => d.label) };
  });
  console.log(`site grafiek: y max ${g.max}, buiten schaal: ${g.marks.join(", ")}`);
  if (!(g.max < 200000) || !g.marks.includes("@test_11")) fail(`site grafiek: not scaled without the outlier (${JSON.stringify(g)})`);
  await sp.evaluate(() => { location.hash = "stand"; });
  await sp.waitForSelector("#board-body tr[data-handle]");
  if ((await sp.$eval("#board-body tr", (r) => r.dataset.handle)) !== "test_11") fail("site stand: outlier not at its own place");
  // Anna's two accounts are one participant ("@test_01 + @test_13"), with a row per account behind the toggle.
  const pRow = await sp.textContent('#board-body tr[data-handle="test_01"]');
  await sp.click('#board-body button[data-open="test_01"]');
  const pSubs = await sp.$$eval("#board-body tr.sub-row", (r) => r.map((x) => x.dataset.handle));
  console.log(`site stand: "${pRow.replace(/\s+/g, " ").trim().slice(0, 50)}…", per account: ${pSubs.join(", ")}`);
  if (!pRow.includes("@test_01 + @test_13") || pSubs.join() !== "test_01,test_13") fail("site stand: two accounts not combined");
  await sp.click('#board-body tr.sub-row[data-handle="test_13"]');
  await sp.waitForSelector("#acc-view");
  if ((await sp.$eval("#acc-view", (s) => s.value)) !== "test_13") fail("site account page: link to the second account doesn't select it");
  await sp.evaluate(() => { location.hash = "groei"; });
  await sp.waitForTimeout(500);
  if (sp.errors.length) fail(`site: browser errors: ${sp.errors.join(" | ")}`);
  if (process.env.SHOTS) {
    await sp.evaluate(() => { location.hash = "grafiek"; });
    await sp.waitForTimeout(500);
    await sp.screenshot({ path: `${process.env.SHOTS}/site-grafiek.png` });
  }
  await sp.close();
}

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
    if (m.kind === "graph") {
      // The y-axis scales on the others; the outlier is a ▲ marker with its real number.
      const g = await pp.evaluate(() => {
        const c = Chart.getChart(document.getElementById("p-chart"));
        return { max: c.scales.y.max, marks: c.data.datasets.filter((d) => d.outlierMark).map((d) => d.label) };
      });
      if (!(g.max < 200000) || g.marks.join() !== "@test_11") fail(`presentatie: graph not scaled without the outlier (${JSON.stringify(g)})`);
    }
    if (m.kind === "risers" && !(await pp.$(".p-bar-out"))) fail("presentatie: risers bar of the outlier not capped");
    if (process.env.SHOTS) await pp.screenshot({ path: `${process.env.SHOTS}/private-present-${w}-${i + 1}.png` });
    await pp.keyboard.press("ArrowRight");
  }
  console.log(`presentatie ${w}x${h}: ${total} slides checked`);
  await pp.close();
}

await browser.close();
server.close();
console.log(failed ? "Private check FAILED" : "Private check passed");
process.exit(failed ? 1 : 0);
