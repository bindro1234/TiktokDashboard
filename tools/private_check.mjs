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
  { _row: 14, student_name: "Lot", tiktok_handle: "https://vm.tiktok.com/ZNRxLeerlingPlaktEenHeleLangeLinkMetCijfers1234567890/", active: "ja" },
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
// Hashtags: Anna uses #glu on 30 Sep and 1 Oct but not on her newest post; Chris used #av first and #glu on his newest;
// Pim uses #glu on all but his newest post (#av only). Nobody else has an Instagram post.
[["2026-09-30", "glu fotografie"], ["2026-10-01", "glu"], ["2026-10-02", "fotografie"]].forEach(([day, tags]) => igPost("anna.gram", `${day}T09:15:00Z`, "reel", tags));
const chrisMissed = lib.studentStats(posts.filter((p) => p.handle === "test_03"), CFG, NOW, []).missedList;
const chrisRescued = chrisMissed.filter((d) => d >= IG_START).slice(0, 2);   // days Instagram counts (from IG_START)
// (Chris's #glu post also carries a typo of #fotografie: a close hashtag for the "gebruiken niet" list.)
chrisRescued.forEach((day, i) => igPost("chris.ig", `${day}T12:00:00Z`, "photo", i === 0 ? "av" : "glu fotografi"));
for (const day of ["2026-09-30", "2026-10-02"]) igPost("pim.only", `${day}T14:00:00Z`, "carousel");
igPost("pim.only", "2026-10-05T08:00:00Z"); igPost("pim.only", "2026-10-05T18:00:00Z");
igPost("pim.only", "2026-10-07T10:00:00Z"); igPost("pim.only", "2026-10-07T13:00:00Z", "photo", "av"); // today: reaches the dagopdracht (2)
igTracked.forEach((h, i) => {
  for (const day of ["2026-09-30", "2026-10-07"]) {
    igHistory.push({ timestamp: `${day}T05:00:00Z`, handle: h, followers: 100 + i * 10 + (day === "2026-10-07" ? 7 : 0), following: 50, posts_count: 20,
      is_private: false, campaign_posts: igPosts.filter((p) => p.handle === h).length });
  }
});
const igBaseline = igTracked.map((h, i) => ({ handle: h, baseline_at: "2026-09-30T05:00:00Z", baseline_followers: 100 + i * 10 }));
// "Video verdwenen": test_06 (Finn) lost one video on 6 Oct (recent) and one on 30 Sep (old); test_07 (Gijs) only the old one.
// Overzicht warns only about videos of the last 3 days; the student page lists them all.
const oldGone = "2026-09-30T16:00:00Z";
posts.find((p) => p.handle === "test_06" && !p.missing_since).missing_since = oldGone;
posts.find((p) => p.handle === "test_07" && !p.missing_since).missing_since = oldGone;
// Eva (test_05, no Instagram handle) put the same typo on a TikTok post after the Instagram start.
{
  const evaPost = posts.filter((p) => p.handle === "test_05" && p.created_at >= `${IG_START}T00:00:00Z`).at(-1);
  evaPost.hashtags = `${evaPost.hashtags} fotografi`.trim();
}
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

// The students' Instagram posts as the Hashtags tab gets them (one entry per student).
const students_for_tags = () => [...lib.groupAccounts(lib.parseAccounts(accountsSheet)).values()].map((g) => ({
  id: g.key, posts: g.instagram ? lib.instagramPosts(igPosts.filter((p) => p.handle === g.instagram)) : [] }));
const posted = [];
let schoolTags = [...CFG.hashtags.school];   // the school hashtags as saved on Beheer
let frequency = { ...CFG.frequency };        // the pull frequency as saved on Beheer (settings tab); starts at the config.yaml value
const effective = () => lib.withFrequency(CFG, frequency);
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
    const cfgNow = effective();
    return [200, { me: "docent@school.nl", serverTime: NOW,
      config: { campaign: CFG.campaign, budget: CFG.budget, schedule: cfgNow.schedule, refreshNumOfPosts: CFG.refreshNumOfPosts,
        forceMinMinutes: CFG.forceMinMinutes, finale: CFG.finale, offDays: CFG.offDays, todayCheck: CFG.todayCheck, signals: CFG.signals,
        frequency: cfgNow.frequency, frequencyDefault: CFG.frequency, frequencySteps: CFG.frequencySteps, instagram: igConfig },
      finale, finaleHasRun,
      settings: { schoolHashtags: schoolTags, schoolHashtagsDefault: [...CFG.hashtags.school] },
      accounts, handles, history, posts, igHandles, igHistory, igPosts, igBaseline, runLog, activity,
      budget: lib.budget(cfgNow, runLog, { tiktok: tracked.length, instagram: accounts.filter((a) => a.instagramTracked).length }, NOW),
      budgetBase: { used: lib.monthUsage(runLog, NOW), done: [...lib.doneWindows(runLog)] },
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
    if (req.url === "/api/settings/hashtags") {
      const { tags, invalid } = lib.parseTagList(body.tags);
      if (invalid.length) return [400, { error: `Geen geldige hashtag: "${invalid[0]}". Gebruik letters, cijfers en _ .` }];
      if (body.was !== schoolTags.join(" ")) return [409, { error: "De lijst is intussen veranderd. Laad de pagina opnieuw." }];
      schoolTags = tags;
      return [200, { ok: true, tags, message: `Schoolhashtags opgeslagen: ${tags.map((t) => "#" + t).join(" ")}.` }];
    }
    if (req.url === "/api/settings/frequency") {
      const current = effective().frequency;
      if (lib.PLATFORMS.some((pl) => !lib.frequencyChoice(body[pl], CFG))) return [400, { error: "Kies voor TikTok Uit, 1× per dag of elke 12, 6, 4 of 2 uur." }];
      if (lib.PLATFORMS.some((pl) => body.was?.[pl] !== current[pl])) return [409, { error: "De instelling is intussen veranderd. Laad de pagina opnieuw." }];
      const accountsNow = lib.parseAccounts(accountsSheet);
      const pv = lib.frequencyPreview(CFG, lib.budgetBase(runLog, NOW), { tiktok: tracked.length, instagram: accountsNow.filter((a) => a.instagramTracked).length },
        NOW, body, current, { finaleDone: finaleHasRun });
      if (!pv.allowed) return [409, { error: `Past niet in het budget: ${pv.total} is meer dan de limiet van ${pv.cap}. Kies een lagere frequentie.` }];
      frequency = { tiktok: body.tiktok, instagram: body.instagram };
      return [200, { ok: true, frequency, message: `Schema opgeslagen: TikTok ${lib.FREQUENCY_NL[body.tiktok]}, Instagram ${lib.FREQUENCY_NL[body.instagram]}.` }];
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

async function open(viewport, path = "", font = process.env.CHECK_FONT) {
  const page = await browser.newPage({ viewport, acceptDownloads: true });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  // A 409 or 400 from the fake API is an expected answer (refresh cooldown, a refused form entry), not a page error.
  page.on("console", (m) => m.type() === "error" && !/status of (409|400)/.test(m.text()) && page.errors.push(m.text()));
  if (process.env.CDN_SHIM) await (await import(process.env.CDN_SHIM)).default(page);
  // Every text in a given font: CHECK_FONT="DejaVu Sans" for the whole run, or a font per page (see FONTS below). GitHub's
  // runners fall back to a wider font than a developer machine, and the layout must not depend on which font there is.
  if (font) {
    await page.addInitScript((font) => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = `*, *::before, *::after { font-family: ${font} !important; }`;
        document.head.appendChild(style);
      });
    }, font);
  }
  await page.goto(base + path);
  return page;
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
// The elements that stick out past the viewport (outside the tables, which scroll inside their own box): for the failure message.
const stickingOut = (page) => page.evaluate(() => [...document.querySelectorAll("body *")]
  .filter((e) => !e.closest(".table-wrap") && e.getBoundingClientRect().right > innerWidth + 1 && e.getBoundingClientRect().width > 0)
  .slice(0, 6).map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).join(".") : ""} (right edge ${Math.round(e.getBoundingClientRect().right)}px, "${e.textContent.trim().replace(/\s+/g, " ").slice(0, 50)}"; in ${e.parentElement.id || e.parentElement.tagName.toLowerCase()})`).join(", "));

// Wide fonts for the phone sweeps: DejaVu Sans is the fallback font on GitHub's Linux runners (their default sans; about 7%
// wider than Inter and 13% wider than Liberation Sans), a monospace font is wider still. A stress font only counts when it
// is really that wide: the sample text below is 438px in DejaVu Sans and 497px in DejaVu Sans Mono at 15px (Liberation Mono
// 495px), so a machine without the font fails here instead of passing without testing anything. Absolute widths, not
// "wider than the default": on the runner the default already is DejaVu Sans.
const FONTS = [["DejaVu Sans", "DejaVu Sans", 430], ["monospace", '"DejaVu Sans Mono", "Liberation Mono", monospace', 485]];
const textWidth = (page) => page.evaluate(() => {
  const span = document.createElement("span");
  span.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font-size:15px";
  span.textContent = "Instagram-handle van deze leerling toevoegen en opslaan";
  document.body.appendChild(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return width;
});
const sweeps = [[{ width: 1280, height: 900 }, null], [{ width: 390, height: 844 }, null],
  ...FONTS.map((font) => [{ width: 390, height: 844 }, font])];
for (const [viewport, font] of sweeps) {
  const tag = `${viewport.width}px${font ? `, ${font[0]}` : ""}`;
  const page = await open(viewport, "#overzicht", font ? font[1] : process.env.CHECK_FONT);
  await page.waitForSelector("#ov-body tr[data-handle]");
  if (font && !process.env.CHECK_FONT) {
    const width = await textWidth(page);
    if (!(width >= font[2])) fail(`${tag}: the stress font did not apply (the sample text is ${Math.round(width)}px wide at 15px, wanted at least ${font[2]}px): is the font installed?`);
  }
  for (const view of ["overzicht", "vandaag", "leerlingen", "hashtags", "stijgers", "opvallend", "presentatie", "beheer", "export"]) {
    await page.evaluate((v) => { location.hash = v; }, view);
    await page.waitForTimeout(250);
    if (!(await page.isVisible(`#view-${view}`))) fail(`${tag}: tab ${view} not shown`);
    if (!(await noHScroll(page))) fail(`${tag}: tab ${view} scrolls sideways (scrollWidth ${await page.evaluate(() => document.documentElement.scrollWidth)}px; sticking out: ${await stickingOut(page) || "nothing outside the tables"})`);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/private-${view}-${tag}.png`, fullPage: true });
  }
  if (page.errors.length) fail(`${tag}: browser errors: ${page.errors.join(" | ")}`);
  console.log(`${tag}: all tabs open, no sideways scroll`);
  await page.close();
}

// Text pasted into the forms on Beheer (a long link, a sentence) shows up in previews and messages: in a wide font at phone size
// none of that may push the page sideways.
{
  const longLink = "https://www.instagram.com/leerling_met_een_hele_lange_naam_die_niet_past/reel/Cxyz1234567890abcdefghijklmnop/?igsh=MWRsbHVicXRyZWF0Z2VuZA%3D%3D";
  for (const [name, css] of [["DejaVu Sans", "DejaVu Sans"], ["monospace", '"DejaVu Sans Mono", "Liberation Mono", monospace']]) {
    const bp = await open({ width: 390, height: 844 }, "#beheer", css);
    await bp.waitForSelector("#acc-body tr");
    await bp.fill("#sh-input", `glu ${longLink} ${longLink.toUpperCase()}`);
    await bp.fill('#add-form [name="handle"]', longLink.replace("instagram", "tiktok"));
    await bp.fill('#add-form [name="instagram"]', longLink + "/zzzzzzzzzzzzzzzzzzzzzzzzzzzz");
    await bp.waitForTimeout(150);
    if (!(await noHScroll(bp))) fail(`390px, ${name}: pasted links on Beheer scroll the page sideways (sticking out: ${await stickingOut(bp)})`);
    await bp.close();
  }
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
for (const w of ["privé", "niet gevonden", "verdwenen", "privé (Instagram)", "niet gevonden (Instagram)", "privé (TikTok)"]) if (!text.includes(w)) fail(`overzicht: no "${w}" warning`);
// Instagram has started and most students have no (valid) handle: for them "geen Instagram-handle" replaces "dagen geen post"
// (test_04 stopped posting on TikTok on 4 Oct but may post on Instagram), and nobody else is warned about silence.
const noHandleCount = [...lib.groupAccounts(lib.parseAccounts(accountsSheet)).values()].filter((g) => !g.instagram).length;
{
  const quiet = await page.textContent('#ov-body tr[data-handle="test_04"]');
  if (!quiet.includes("geen Instagram-handle") || /geen post/.test(quiet)) fail(`overzicht: student without a handle who stopped posting wrong (${quiet.replace(/\s+/g, " ").slice(0, 160)})`);
  const flagged = await page.$$eval("#ov-body tr[data-handle]", (r) => r.filter((x) => x.textContent.includes("geen Instagram-handle")).length);
  if (flagged !== noHandleCount) fail(`overzicht: ${flagged} rows with "geen Instagram-handle", expected ${noHandleCount}`);
  if (/geen post/.test(text)) fail("overzicht: a 'geen post' warning although everybody quiet lacks an Instagram handle");
  const handleOf = await page.$eval('#ov-body tr[data-handle="test_04"]', (r) => r.querySelector('button[data-warn]').textContent);
  if (!handleOf) fail("overzicht: no clickable warning on the student without a handle");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/private-overzicht-nohandle-1280px.png`, fullPage: true });
}
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
{
  const group = await page.$eval('#ov-actions .action-group:has(a[href="#beheer/instagram"])', (g) => g.textContent.replace(/\s+/g, " "));
  if (!group.includes("Geen Instagram-handle: niet te controleren") || !group.includes(`(${noHandleCount})`) || !group.includes("Handles invullen")) fail(`overzicht: Actie nodig group for missing handles wrong (${group.slice(0, 160)})`);
  const todoGroup = await page.$eval("#ov-actions", (a) => [...a.querySelectorAll(".action-group")].filter((g) => /Nog niet gepost vandaag|Dagopdracht vandaag/.test(g.querySelector("h3").textContent)).map((g) => g.textContent).join(" "));
  if (todoGroup.includes("Dewi")) fail("overzicht: a student without a handle is listed as 'nog niet gepost vandaag'");
}
if (!/mediaan per leerling/.test(await page.textContent("#ov-tiles"))) fail("overzicht: no median next to the total");
await page.click('#ov-body td.wide-only button[data-warn]:text("verdwenen")');
const detail = await page.textContent("#ov-body tr.warn-detail");
if (!/verdwenen sinds/.test(detail) || !/open ↗/.test(detail)) fail(`overzicht: warning details missing (${detail.slice(0, 80)})`);
{
  // Finn lost a video on 6 Oct and one on 30 Sep: Overzicht only knows about the recent one, and says where the rest is.
  const finn = await page.$eval('#ov-body tr[data-handle="test_06"]', (r) => r.textContent.replace(/\s+/g, " "));
  if (!/1 video verdwenen/.test(finn) || /2 video's verdwenen/.test(finn)) fail(`overzicht: Finn's "verdwenen" badge (${finn.slice(0, 200)})`);
  const items = await page.$$eval("#ov-body tr.warn-detail li li", (li) => li.filter((x) => /verdwenen sinds/.test(x.textContent)).map((x) => x.textContent.replace(/\s+/g, " ")));
  if (items.length !== 1 || !/6 okt/.test(items[0]) && !/di 6/.test(items[0])) fail(`overzicht: the details list ${items.length} videos (${items.join(" | ")})`);
  const detailBox = await page.textContent("#ov-body tr.warn-detail");
  if (!/Alleen de laatste 3 dagen; in totaal 2 video's verdwenen/.test(detailBox.replace(/\s+/g, " ")) || !(await page.$('#ov-body tr.warn-detail a[href="#leerlingen/test_06"]'))) fail(`overzicht: no pointer to the student page (${detailBox.replace(/\s+/g, " ").slice(0, 300)})`);
  // Gijs only lost a video 9 days ago: no warning on Overzicht at all.
  const gijs = await page.$eval('#ov-body tr[data-handle="test_07"]', (r) => r.textContent);
  if (/verdwenen/.test(gijs)) fail(`overzicht: an old "verdwenen" is still on Overzicht (${gijs.slice(0, 120)})`);
}
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
// No Instagram handle: since the Instagram start a day without a post is "niet te controleren" (striped), not "gemist";
// before it, and on days with a post, nothing changes. Students with a handle have no such cells.
{
  const days = lib.campaignDays(CFG);
  const dewi = lib.studentStats(posts.filter((p) => p.handle === "test_04"), CFG, NOW, tasks, { unknownFrom: IG_START });
  const classes = await page.$$eval('.heat tr[data-handle="test_04"] td.day', (c) => c.map((x) => x.className.split(/\s+/)));
  const unknownDays = days.filter((d, i) => classes[i].includes("unverified")), missedDays = days.filter((d, i) => classes[i].includes("miss"));
  if (!dewi.unknownList.length || unknownDays.join() !== dewi.unknownList.join()) fail(`leerlingen: "niet te controleren" cells ${unknownDays} vs ${dewi.unknownList}`);
  if (missedDays.join() !== dewi.missedList.join() || missedDays.some((d) => d >= IG_START)) fail(`leerlingen: missed cells of a student without a handle ${missedDays} (all before ${IG_START}?)`);
  const title = await page.$eval(`.heat tr[data-handle="test_04"] td.day:nth-child(${days.indexOf(dewi.unknownList[0]) + 2})`, (c) => c.title);
  if (!/geen Instagram-handle: niet te controleren/.test(title)) fail(`leerlingen: tooltip of an unknown day (${title})`);
  const withHandle = await page.$$eval('.heat tr[data-handle="test_03"] td.unverified, .heat tr[data-handle="test_01"]:not(.sub-row) td.unverified', (c) => c.length);
  if (withHandle) fail(`leerlingen: ${withHandle} "niet te controleren" cells for students with a handle`);
  if (!(await page.textContent(".legend-row")).includes("niet te controleren (geen Instagram-handle)")) fail("leerlingen: no legend entry for unknown days");
  const gemist = await page.$eval('.heat tr[data-handle="test_04"]', (tr) => tr.querySelector("td.num:nth-last-child(3)")?.textContent);
  console.log(`leerlingen: Dewi (no handle) ${dewi.unknownList.length} days niet te controleren, ${dewi.missedList.length} gemist (${gemist})`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/private-kalender-nohandle-1280px.png`, fullPage: true });
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
// The student page keeps the full list of videos that disappeared, however long ago.
for (const [h, n] of [["test_06", 2], ["test_07", 1]]) {
  await page.evaluate((x) => { location.hash = "leerlingen/" + x; }, h);
  await page.waitForSelector(".cal");
  const head = (await page.textContent("#ll-content .detail-head")).replace(/\s+/g, " ");
  const items = await page.$$eval("#ll-content .warn-list li li", (li) => li.length);
  if (!head.includes(`${n} video${n > 1 ? "'s" : ""} verdwenen`) || items !== n) fail(`student detail: ${h} shows "${head.slice(-80)}" with ${items} videos, expected ${n}`);
}
await page.evaluate(() => { location.hash = "leerlingen/test_04"; });
await page.waitForSelector(".cal");
{
  const dewi = lib.studentStats(posts.filter((p) => p.handle === "test_04"), CFG, NOW, tasks, { unknownFrom: IG_START });
  const unk = await page.$$eval(".cal .d.unverified", (d) => d.map((x) => x.textContent));
  if (unk.length !== dewi.unknownList.length || !unk.every((t) => t.includes("?"))) fail(`student detail: ${unk.length} unknown calendar days (${unk.join("|")}), expected ${dewi.unknownList.length}`);
  const tile = await page.$eval("#ll-content .tile:has(.label:text('Gemiste dagen'))", (t) => t.textContent.replace(/\s+/g, " "));
  if (!tile.includes(` ${dewi.missedDays} `) && !tile.includes(`${dewi.missedDays}tot`) || !tile.includes(`${dewi.unknownDays} dagen niet te controleren (geen Instagram-handle)`)) fail(`student detail: missed-days tile (${tile})`);
  const hint = await page.textContent("#ll-content .card .hint:has-text('Niet te controleren')");
  if (!hint.includes("geen Instagram-handle")) fail("student detail: no list of the days that can't be checked");
  const warn = await page.textContent("#ll-content .warn-list");
  if (!warn.includes("geen Instagram-handle") || !warn.includes("Laatste TikTok-post") || !(await page.$('#ll-content .warn-list a[href="#beheer/instagram"]'))) fail(`student detail: warning without the explanation or the link (${warn.slice(0, 160)})`);
  const badges = await page.$$eval("#ll-content .detail-head .badge", (b) => b.map((x) => x.textContent));
  if (badges.some((t) => /geen post/.test(t)) || !badges.includes("geen Instagram-handle")) fail(`student detail: badges of a student without a handle (${badges.join("|")})`);
}
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
// Under "Controleer nu": one short line (what counts, stories, how long), not two paragraphs; the cost line above names the platforms.
{
  const hints = await page.$$eval("#view-vandaag .card:first-child p.hint", (p) => p.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
  if (hints.length !== 1 || hints[0].length > 160 || !hints[0].includes("Stories worden niet meegeteld.") || !/5–7 minuten per platform/.test(hints[0])) fail(`vandaag: the explanation under Controleer nu (${hints.length} paragraphs: ${hints.join(" | ")})`);
}
if (todayCounts[2] !== "1") fail("vandaag: private account not listed separately");
// No Instagram handle and nothing on TikTok today: "niet te controleren", in a group of their own with a link to the handle form,
// not under "nog niet gepost". Together the four lists hold every student once.
{
  const v = await page.evaluate(() => {
    const names = (id) => [...document.querySelectorAll(`#${id} li`)].map((li) => li.textContent.replace(/\s+/g, " ").trim());
    return { n: document.getElementById("td-nohandle-n").textContent, hidden: document.getElementById("td-nohandle-card").hidden, list: names("td-nohandle"),
      todo: names("td-todo"), done: names("td-done"), priv: names("td-priv"), link: document.querySelector('#td-nohandle-card a[href="#beheer/instagram"]')?.textContent,
      title: document.querySelector("#td-nohandle-card h3").textContent.replace(/\s+/g, " ").trim() };
  });
  const dewiLine = v.list.find((t) => t.startsWith("Dewi"));
  if (v.hidden || !dewiLine || v.todo.some((t) => t.startsWith("Dewi"))) fail(`vandaag: Dewi (no handle, stopped posting) not in the "niet te controleren" group (${JSON.stringify(v)})`);
  if (!/laatste TikTok-post/.test(dewiLine) || !v.link || !/^Geen Instagram-handle: niet te controleren \(\d+\)$/.test(v.title)) fail(`vandaag: group text wrong (${dewiLine} / ${v.link} / ${v.title})`);
  if (Number(v.n) !== v.list.length) fail("vandaag: group count differs from its list");
  if (v.list.length + Number(todayCounts[0]) + Number(todayCounts[1]) + Number(todayCounts[2]) !== students) fail(`vandaag: lists do not add up to ${students} students (${v.list.length}/${todayCounts.join("/")})`);
  console.log(`vandaag: ${v.list.length} students "niet te controleren" (no Instagram handle), todo ${todayCounts[0]}`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/private-vandaag-nohandle-1280px.png`, fullPage: true });
}
// Pim (only Instagram) posted twice today on Instagram: done (dagopdracht 2), with the platform and a link to the post.
const pimToday = await page.$eval('#td-done li:has(a[href="#leerlingen/instagram%3Apim.only"])', (li) => ({ text: li.textContent.replace(/\s+/g, " "), href: li.querySelector('a[target]')?.href }));
if (!/2\/2/.test(pimToday.text) || !/op Instagram/.test(pimToday.text) || !pimToday.href?.startsWith("https://www.instagram.com/")) fail(`vandaag: Instagram-only student wrong (${JSON.stringify(pimToday)})`);
if (!/Instagram/.test(await page.textContent("#td-checked"))) fail("vandaag: last checked has no Instagram time");
if (!(await page.textContent("#view-vandaag")).includes("Stories worden niet meegeteld.")) fail("vandaag: no note about stories");
let confirmText = "";
page.once("dialog", (d) => { confirmText = d.message(); d.accept(); });
await page.click("#td-check");
await page.waitForFunction(() => /5–7 minuten|gestart/.test(document.getElementById("td-msg").textContent));
if (!posted.some((p) => p.url === "/api/today/check")) fail("vandaag: Controleer nu did not post");
if (!/\(\d+ TikTok, 1 Instagram\)/.test(confirmText) || !/5–10 minuten/.test(confirmText)) fail(`vandaag: the confirmation does not name both platforms (${confirmText})`);

// Opvallend: flags with their numbers.
await page.evaluate(() => { location.hash = "opvallend"; });
await page.waitForFunction(() => document.querySelectorAll("#sig-body tr").length && !/laden/.test(document.getElementById("sig-body").textContent));
const sig = await page.textContent("#sig-body");
console.log(`opvallend: ${await page.textContent("#sig-meta")}`);
for (const w of ["Likes per weergave", "Geen reacties of shares"]) if (!sig.includes(w)) fail(`opvallend: no "${w}" flag`);
if (/bot/i.test(sig)) fail("opvallend: says 'bot'");

// Hashtags: search, school presets, who uses it and who does not, "ontbreekt op laatste post", the most-used table.
await page.evaluate(() => { location.hash = "hashtags"; });
await page.waitForSelector("#tags-body tr[data-tag]");
const presets = await page.$$eval("#tag-presets button[data-preset]", (b) => b.map((x) => x.dataset.preset));
if (presets.join() !== "glu,grafischlyceumutrecht,av") fail(`hashtags: school presets ${presets.join()}`);
const tagNote = await page.textContent("#tag-note");
if (!/caption/.test(tagNote) || !/reacties/.test(tagNote) || !/Instagram/.test(tagNote)) fail(`hashtags: no note that only caption hashtags are visible (${tagNote})`);
if (!/Typ een hashtag/.test(await page.textContent("#tag-result"))) fail("hashtags: no hint before anything is typed");
const rowsText = async (sel) => page.$$eval(`${sel} li`, (li) => li.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
// A school hashtag with one click: the search box is filled and both lists appear.
await page.click('#tag-presets button[data-preset="glu"]');
if ((await page.inputValue("#tag-search")) !== "glu") fail("hashtags: a preset does not fill the search box");
let uses = await rowsText("#tag-uses"), notUse = await rowsText("#tag-notuse");
const annaU = uses.find((t) => t.startsWith("Anna")), pimU = uses.find((t) => t.startsWith("Pim"));
if (uses.length !== 3 || !annaU || !pimU || !uses.some((t) => t.startsWith("Chris"))) fail(`hashtags: #glu users wrong (${uses.join(" | ")})`);
if (!/2 van 3 posts/.test(annaU) || !/laatst gebruikt do 1 okt/.test(annaU) || !/ontbreekt op laatste post/.test(annaU)) fail(`hashtags: Anna's line wrong (${annaU})`);
if (!/5 van 6 posts/.test(pimU) || !/ontbreekt op laatste post/.test(pimU)) fail(`hashtags: Pim's line wrong (${pimU})`);
const chrisU = uses.find((t) => t.startsWith("Chris"));
if (!/1 van 2 posts/.test(chrisU) || /ontbreekt op laatste post/.test(chrisU)) fail(`hashtags: Chris's line wrong (${chrisU})`);
if (!(await page.$('#tag-uses a[href^="https://www.instagram.com/"]'))) fail("hashtags: no link to the post");
if (notUse.length !== students - 3) fail(`hashtags: ${notUse.length} students not using #glu, expected ${students - 3}`);
const notes = notUse.join(" | ");
for (const w of ["geen Instagram-handle", "privé", "ongeldige Instagram-handle"]) if (!notes.includes(w)) fail(`hashtags: students without a visible Instagram have no "${w}" note`);
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/private-hashtags-glu-1280px.png`, fullPage: true });
// Filter: only who misses it on the newest post. Everyone with posts uses #glu, so the other list is empty.
await page.check("#tag-missing");
uses = await rowsText("#tag-uses"); notUse = await rowsText("#tag-notuse");
if (uses.map((t) => t.split(" ")[0]).sort().join() !== "Anna,Pim" || notUse.join() !== "Niemand.") fail(`hashtags: filter on #glu wrong (${uses.join(" | ")} / ${notUse.join(" | ")})`);
// #av: Chris used it on his first post (not the newest), Pim on his newest, Anna never.
await page.fill("#tag-search", "#AV ");
uses = await rowsText("#tag-uses"); notUse = await rowsText("#tag-notuse");
if (uses.length !== 1 || !uses[0].startsWith("Chris") || notUse.join() !== (notUse.length === 1 ? notUse[0] : "") || !notUse[0].startsWith("Anna") || !/0 van 3 posts/.test(notUse[0])) fail(`hashtags: #av with the filter wrong (${uses.join(" | ")} / ${notUse.join(" | ")})`);
await page.uncheck("#tag-missing");
uses = await rowsText("#tag-uses");
if (uses.map((t) => t.split(" ")[0]).sort().join() !== "Chris,Pim") fail(`hashtags: #av users wrong (${uses.join(" | ")})`);
// Typing a part of a hashtag nobody uses offers the ones that start with it; a click searches it.
await page.fill("#tag-search", "gl");
if (!/Niemand gebruikt #gl\. Bedoel je: #glu/.test((await page.textContent("#tag-result")).replace(/\s+/g, " "))) fail("hashtags: no 'bedoel je' for a part of a hashtag");
await page.click('#tag-result button[data-preset="glu"]');
if ((await page.inputValue("#tag-search")) !== "glu" || (await rowsText("#tag-uses")).length !== 3) fail("hashtags: the suggestion does not search");
await page.fill("#tag-search", "glu!");
if (!/is geen hashtag/.test(await page.textContent("#tag-result"))) fail("hashtags: nothing said about something that is no hashtag");
// The most-used table is Instagram only (no TikTok hashtags, no views) and a click fills the search box.
const igTable = lib.tagTable(students_for_tags(), IG_START);
const tableRows = await page.$$eval("#tags-body tr[data-tag]", (r) => r.map((x) => [x.dataset.tag, ...[...x.children].slice(2, 4).map((c) => Number(c.textContent.replace(/\D/g, "")))]));
const gluRow = tableRows.find((r) => r[0] === "glu"), gluExp = igTable.find((t) => t.tag === "glu");
if (!gluRow || gluRow[1] !== gluExp.posts || gluRow[2] !== gluExp.students) fail(`hashtags: table row for #glu ${gluRow} vs ${gluExp.posts}/${gluExp.students}`);
if (tableRows.length !== igTable.length || tableRows[0][0] !== "glu") fail(`hashtags: table has ${tableRows.length} rows, first ${tableRows[0]}`);
if (tableRows.some((r) => ["fyp", "viral", "schoolproject", "tiktoknl", "sport"].includes(r[0]))) fail("hashtags: a TikTok hashtag is in the Instagram table");
if (await page.$("#tag-out, #tags-body td.num:nth-child(5)")) fail("hashtags: views or the buiten-schaal switch are still on the tab");
await page.click('#tag-sort button[data-v="students"]');
if ((await page.getAttribute('#tag-sort button[data-v="students"]', "aria-pressed")) !== "true") fail("hashtags: sort by students not pressed");
await page.click('#tags-body tr[data-tag="fotografie"]');
if ((await page.inputValue("#tag-search")) !== "fotografie" || !(await page.textContent("#tag-uses")).includes("Anna")) fail("hashtags: a click in the table does not fill the search box");
// Who has posted without it comes first, those nothing can be seen of (no Instagram, private, not found) last.
const notFoto = await rowsText("#tag-notuse");
if (!notFoto[0].startsWith("Chris") || !/0 van 2 posts/.test(notFoto[0]) || !/geen Instagram-handle/.test(notFoto.at(-1))) fail(`hashtags: order of the "gebruiken niet" list (${notFoto.join(" | ")})`);
// A hashtag that looks like the one searched is named next to the student: Chris on Instagram, Eva (no handle) on TikTok.
{
  const chris = notFoto.find((t) => t.startsWith("Chris")), eva = notFoto.find((t) => t.startsWith("Eva"));
  if (!/gebruikt #fotografi \(1× Instagram\)$/.test(chris)) fail(`hashtags: Chris's close hashtag (${chris})`);
  if (!/geen Instagram-handle/.test(eva) || !/gebruikt #fotografi \(1× TikTok\)$/.test(eva)) fail(`hashtags: Eva's close hashtag on TikTok (${eva})`);
  if ((await rowsText("#tag-uses")).some((t) => /gebruikt #/.test(t))) fail("hashtags: a student who uses the hashtag got a 'gebruikt #' hint");
  // The numbers stay Instagram: Eva does not count as a user because of TikTok.
  if (!notFoto.some((t) => t.startsWith("Eva")) || (await rowsText("#tag-uses")).some((t) => t.startsWith("Eva"))) fail("hashtags: a TikTok post made Eva a user");
  // A short school hashtag has no relatives.
  await page.fill("#tag-search", "glu");
  if ((await rowsText("#tag-notuse")).some((t) => /gebruikt #/.test(t))) fail("hashtags: #glu got close-hashtag hints");
  await page.fill("#tag-search", "fotografie");
  if (process.env.SHOTS) await page.locator("#tag-result").screenshot({ path: `${process.env.SHOTS}/private-hashtags-near-1280px.png` });
}
{
  // The same at phone size: the lists stack, nothing pushes the page sideways.
  const hp = await open({ width: 390, height: 844 }, "#hashtags");
  await hp.waitForSelector("#tag-presets button");
  await hp.click('#tag-presets button[data-preset="glu"]');
  await hp.check("#tag-missing");
  if (!(await noHScroll(hp))) fail("390px: Hashtags with a search scrolls sideways");
  if (process.env.SHOTS) await hp.screenshot({ path: `${process.env.SHOTS}/private-hashtags-glu-390px.png`, fullPage: true });
  await hp.close();
}
console.log(`hashtags: ${tableRows.length} Instagram hashtags, #glu used by 3 of ${students} students`);

await page.evaluate(() => { location.hash = "beheer"; });
await page.waitForSelector("#acc-body tr");
const budgetText = await page.textContent("#bh-budget");
if (!budgetText.includes(String(CFG.budget.monthlyCap).replace(/\B(?=(\d{3})+(?!\d))/g, "."))) fail("beheer: budget does not show the cap");
// Two platforms: runs and accounts per platform, one cap; the schedule says how often each is pulled.
const igAccounts = lib.parseAccounts(accountsSheet).filter((a) => a.instagramTracked).length;
if (!/TikTok: nog \d+ geplande profielruns deze maand × 13 accounts/.test(budgetText)) fail(`beheer: no TikTok budget line: ${budgetText.slice(0, 200)}`);
if (!new RegExp(`Instagram: nog \\d+ geplande profielruns deze maand × ${igAccounts} accounts`).test(budgetText)) fail(`beheer: no Instagram budget line: ${budgetText.slice(0, 300)}`);
const scheduleText = await page.textContent("#freq-preview");
if (!/TikTok: 2× per dag, elke 12 uur: 08:00, 20:00/.test(scheduleText)) fail(`beheer: TikTok schedule wrong: ${scheduleText.slice(0, 200)}`);
if (!/Instagram: 6× per dag, elke 4 uur: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00/.test(scheduleText)) fail(`beheer: Instagram schedule wrong: ${scheduleText.slice(0, 300)}`);
console.log(`beheer: schedule "${scheduleText.replace(/\s+/g, " ").slice(0, 120)}…"`);
// Schema: a choice per platform in fixed steps (no slider), what it costs before anything is saved, saving, refusing what doesn't fit
// under the cap (lowering is always allowed), and "Uit" showing up on Beheer and Vandaag.
{
  const nlNum = (n) => new Intl.NumberFormat("nl-NL").format(n);
  const counts = { tiktok: tracked.length, instagram: igAccounts };
  const pvOf = (choice) => lib.frequencyPreview(CFG, lib.budgetBase(runLog, NOW), counts, NOW, choice, { tiktok: "12h", instagram: "4h" }, { finaleDone: finaleHasRun });
  const labels = ["Uit", "1× per dag", "Elke 12 uur", "Elke 6 uur", "Elke 4 uur", "Elke 2 uur"];
  for (const pl of ["tiktok", "instagram"]) {
    const opts = await page.$$eval(`#freq-${pl} option`, (o) => o.map((x) => [x.value, x.textContent]));
    if (opts.map((o) => o[1]).join() !== labels.join() || opts.map((o) => o[0]).join() !== "off,daily,12h,6h,4h,2h") fail(`beheer: choices for ${pl} are ${opts.join(" | ")}`);
  }
  if (await page.$('#freq-form input[type="range"], #freq-form input[type="number"]')) fail("beheer: the frequency is a free input, not fixed steps");
  const select = async (tiktok, instagram) => { await page.selectOption("#freq-tiktok", tiktok); await page.selectOption("#freq-instagram", instagram); };
  const preview = async () => (await page.textContent("#freq-preview")).replace(/\s+/g, " ");
  // What is saved (the config.yaml start value) is selected, nothing to save yet.
  if ((await page.inputValue("#freq-tiktok")) !== "12h" || (await page.inputValue("#freq-instagram")) !== "4h" || !(await page.isDisabled("#freq-save"))) fail("beheer: the saved frequency is not what is selected");
  let text = await preview();
  const base = pvOf({ tiktok: "12h", instagram: "4h" });
  if (!text.includes("Dit is het huidige schema.") || !text.includes(`× ${counts.tiktok} accounts = ${nlNum(base.platforms[0].perDay)} records per dag`)
      || !text.includes(`× ${counts.instagram} accounts = ${nlNum(base.platforms[1].perDay)} records per dag`)) fail(`beheer: schedule preview wrong (${text.slice(0, 300)})`);
  if (!text.includes(`= ${nlNum(base.projected)}`) || !text.includes(`weekrefresh ${nlNum(base.refresh)}`) || !text.includes(`van de limiet van ${nlNum(CFG.budget.monthlyCap)}`)) fail(`beheer: month total / reserves wrong (${text.slice(0, 500)})`);
  // Choosing shows the cost at once (before saving) and enables Opslaan.
  await select("2h", "2h");
  const big = pvOf({ tiktok: "2h", instagram: "2h" });
  text = await preview();
  if (!text.includes("12× per dag") || !text.includes(`${nlNum(big.perDay)} records per dag`) || !text.includes(`= ${nlNum(big.projected)}`) || !text.includes("Past binnen de limiet.") || (await page.isDisabled("#freq-save"))) {
    fail(`beheer: preview of "2h" wrong (${text.slice(0, 400)})`);
  }
  if (process.env.SHOTS) await page.locator("#freq-form").locator("xpath=ancestor::div[contains(@class,'card')]").screenshot({ path: `${process.env.SHOTS}/private-schema-2h-1280px.png` });
  // Reload data while a choice is open: the choice stays (a reload must not throw it away).
  await page.evaluate(() => document.querySelector("#freq-form").dispatchEvent(new Event("change", { bubbles: true })));
  if ((await page.inputValue("#freq-tiktok")) !== "2h") fail("beheer: the open choice was reset");
  // A full month: bigger doesn't fit (refused, Opslaan off), lowering is allowed even though the month is over the cap.
  runLog.push({ timestamp: new Date(NOW).toISOString(), run_type: "profiles", window: "big", dry_run: false, expected_records: 1,
    actual_records: CFG.budget.monthlyCap - 300, errors: 0, status: "ok", snapshot_ids: "sd_big", notes: "" });
  await page.reload();
  await page.waitForSelector("#acc-body tr");
  await select("2h", "4h");
  text = await preview();
  if (!/Past niet in het budget: [\d.]+ is meer dan de limiet van 23\.000/.test(text) || !(await page.isDisabled("#freq-save"))) fail(`beheer: a choice that doesn't fit is not refused (${text.slice(-260)})`);
  if (process.env.SHOTS) await page.locator("#freq-form").locator("xpath=ancestor::div[contains(@class,'card')]").screenshot({ path: `${process.env.SHOTS}/private-schema-refused-1280px.png` });
  await select("daily", "off");
  text = await preview();
  if (!text.includes("kost minder dan het huidige schema") || (await page.isDisabled("#freq-save"))) fail(`beheer: lowering is not allowed over the cap (${text.slice(-260)})`);
  runLog.pop();
  await page.reload();
  await page.waitForSelector("#acc-body tr");
  if (process.env.SHOTS) {
    const ph = await open({ width: 390, height: 844 }, "#beheer");
    await ph.waitForSelector("#freq-form");
    await ph.selectOption("#freq-tiktok", "off");
    await ph.locator("#freq-form").locator("xpath=ancestor::div[contains(@class,'card')]").screenshot({ path: `${process.env.SHOTS}/private-schema-off-390px.png` });
    if (!(await noHScroll(ph))) fail("390px: Beheer with the schedule form scrolls sideways");
    await ph.close();
  }
  // Save TikTok "Uit": posted with what the page showed, the page follows, and Nu verversen and Controleer nu say it is skipped.
  await select("off", "4h");
  text = await preview();
  if (!text.includes("TikTok: uit: geen geplande runs, 0 records per dag") || !/TikTok staat uit: geen geplande runs, geen weekrefresh en geen finale-runs/.test(text) || !text.includes("weekrefresh uit")) fail(`beheer: preview of "Uit" wrong (${text.slice(0, 400)})`);
  await page.click("#freq-save");
  await page.waitForFunction(() => /Schema opgeslagen: TikTok uit, Instagram elke 4 uur/.test(document.getElementById("freq-msg").textContent));
  const savedBody = posted.filter((x) => x.url === "/api/settings/frequency").at(-1).body;
  if (JSON.stringify(savedBody) !== JSON.stringify({ tiktok: "off", instagram: "4h", was: { tiktok: "12h", instagram: "4h" } })) fail(`beheer: frequency posted ${JSON.stringify(savedBody)}`);
  await page.waitForFunction(() => /huidige schema/.test(document.getElementById("freq-preview").textContent));
  if (!(await page.textContent("#bh-refresh-note")).includes("TikTok staat uit en wordt overgeslagen.")) fail("beheer: no note on Nu verversen that TikTok is skipped");
  if (!(await page.textContent("#bh-schedule")).includes("uit: TikTok staat uit")) fail("beheer: weekrefresh line does not say it is off");
  await page.evaluate(() => { location.hash = "vandaag"; });
  await page.waitForSelector("#td-todo li");
  const cost = await page.textContent("#td-cost");
  if (!/TikTok staat uit en wordt overgeslagen/.test(cost) || /TikTok\)/.test(cost.replace("TikTok staat", ""))) fail(`vandaag: cost line with TikTok off (${cost})`);
  if (!/Geplande runs: TikTok uit, Instagram elke 4 uur/.test((await page.textContent("#view-vandaag")).replace(/\s+/g, " "))) fail("vandaag: planned runs do not show TikTok as off");
  let confirmed = "";
  page.once("dialog", (d) => { confirmed = d.message(); d.dismiss(); });
  await page.click("#td-check");
  if (!/TikTok staat uit en wordt overgeslagen\./.test(confirmed) || /TikTok,/.test(confirmed.replace("TikTok staat", ""))) fail(`vandaag: the confirmation does not name the skipped platform (${confirmed})`);
  // Back to the start value (and a refused save: someone changed it meanwhile).
  await page.evaluate(() => { location.hash = "beheer"; });
  await page.waitForSelector("#freq-form");
  await select("12h", "4h");
  await page.click("#freq-save");
  await page.waitForFunction(() => /Schema opgeslagen: TikTok elke 12 uur/.test(document.getElementById("freq-msg").textContent));
  await page.waitForFunction(() => /huidige schema/.test(document.getElementById("freq-preview").textContent));
  frequency = { tiktok: "daily", instagram: "daily" };   // another teacher saves in the meantime
  await select("6h", "4h");
  await page.click("#freq-save");
  await page.waitForFunction(() => /intussen veranderd/.test(document.getElementById("freq-msg").textContent));
  frequency = { ...CFG.frequency };
  console.log(`beheer: schema ${labels.length} steps, preview, save, refusal, lowering, Uit on Beheer and Vandaag`);
}
const issuesText = await page.textContent("#acc-issues");
if (!issuesText.includes("Rij 14") || !issuesText.includes("onbekend")) fail(`beheer: problems list incomplete: ${issuesText}`);
// Schoolhashtags: the saved list, a live preview, a refused entry, a save, "Standaardlijst" and the new presets on the Hashtags tab.
{
  const saves = () => posted.filter((x) => x.url === "/api/settings/hashtags");
  if ((await page.inputValue("#sh-input")) !== "glu grafischlyceumutrecht av") fail(`beheer: school hashtags field shows "${await page.inputValue("#sh-input")}"`);
  await page.fill("#sh-input", "GLU #av, nieuw-tag");
  const preview = await page.textContent("#sh-preview");
  if (!preview.includes("#glu") || !preview.includes("#av") || !preview.includes("nieuw-tag ✗")) fail(`beheer: school hashtags preview wrong (${preview})`);
  await page.click('#sh-form button[type="submit"]');
  await page.waitForFunction(() => /Geen geldige hashtag/.test(document.getElementById("sh-msg").textContent));
  await page.fill("#sh-input", "GLU #av, schoolproject");
  await page.click('#sh-form button[type="submit"]');
  await page.waitForFunction(() => /Schoolhashtags opgeslagen: #glu #av #schoolproject/.test(document.getElementById("sh-msg").textContent));
  const last = saves().at(-1);
  if (saves().length !== 2 || last.body.tags !== "GLU #av, schoolproject" || last.body.was !== "glu grafischlyceumutrecht av") fail(`beheer: school hashtags did not post right (${JSON.stringify(last && last.body)})`);
  await page.waitForFunction(() => document.getElementById("sh-input").value === "glu av schoolproject");
  await page.click("#sh-default");
  if ((await page.inputValue("#sh-input")) !== "glu grafischlyceumutrecht av" || saves().length !== 2) fail("beheer: Standaardlijst does not fill the field without saving");
  await page.evaluate(() => { location.hash = "hashtags"; });
  await page.waitForSelector("#tag-presets button");
  const nowPresets = await page.$$eval("#tag-presets button[data-preset]", (b) => b.map((x) => x.dataset.preset));
  if (nowPresets.join() !== "glu,av,schoolproject") fail(`beheer: the saved school hashtags are not the presets (${nowPresets.join()})`);
  await page.evaluate(() => { location.hash = "beheer"; });
  await page.waitForSelector("#acc-body tr");
}
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
// With the handle filled in, the same student is judged again: "dagen geen post" is back, the "niet te controleren" days
// turn into "gemist", and the missing-handle warning is gone (Dewi stopped posting on TikTok on 4 Oct).
{
  const fresh = await open({ width: 1280, height: 900 }, "#overzicht");
  await fresh.waitForSelector('#ov-body tr[data-handle="test_04"]');
  const row = await fresh.textContent('#ov-body tr[data-handle="test_04"]');
  if (!/dagen geen post/.test(row) || row.includes("geen Instagram-handle")) fail(`overzicht: student with a new handle still treated as without (${row.replace(/\s+/g, " ").slice(0, 160)})`);
  const flagged = await fresh.$$eval("#ov-body tr[data-handle]", (r) => r.filter((x) => x.textContent.includes("geen Instagram-handle")).length);
  if (flagged !== noHandleCount - 1) fail(`overzicht: ${flagged} students flagged after one handle was added, expected ${noHandleCount - 1}`);
  await fresh.evaluate(() => { location.hash = "leerlingen"; });
  await fresh.waitForSelector(".heat tbody tr");
  const again = await fresh.$$eval('.heat tr[data-handle="test_04"] td.day', (c) => ({ unknown: c.filter((x) => x.classList.contains("unverified")).length, miss: c.filter((x) => x.classList.contains("miss")).length }));
  const dewiNow = lib.studentStats(posts.filter((p) => p.handle === "test_04"), CFG, NOW, tasks);
  if (again.unknown || again.miss !== dewiNow.missedList.length || again.miss < 3) fail(`leerlingen: Dewi with a handle: ${JSON.stringify(again)}, expected ${dewiNow.missedList.length} missed and none unknown`);
  await fresh.evaluate(() => { location.hash = "vandaag"; });
  await fresh.waitForSelector("#td-todo li");
  const todo = await fresh.textContent("#td-todo");
  if (!todo.includes("Dewi")) fail("vandaag: Dewi, now with a handle, is not under 'nog niet gepost'");
  console.log(`beheer: after filling in a handle Dewi is judged again (${again.miss} gemist, "dagen geen post" back)`);
  await fresh.close();
}
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
if (!lines[0].includes("dagen_niet_te_controleren")) fail("export: no dagen_niet_te_controleren column");
{
  // A student who still has no handle and has days without a post since the Instagram start (Dewi got one on Beheer above).
  const pick = tracked.map((h, i) => ({ h, name: names[i], st: lib.studentStats(posts.filter((p) => p.handle === h), CFG, NOW, tasks, { unknownFrom: IG_START }) }))
    .find((x) => x.name && x.h !== "test_04" && x.h !== "test_12" && x.st.unknownDays > 0 && !accountsSheet.find((r) => r.tiktok_handle.replace("@", "") === x.h)?.instagram_handle);
  if (!pick) fail("fixture: no student without a handle has days that can't be checked");
  else {
    const line = cells(lines.find((l) => l.startsWith(pick.name + ";")));
    const got = [line[head.indexOf("dagen_niet_te_controleren")], line[head.indexOf("gemiste_dagen")]].join("/");
    if (got !== `${pick.st.unknownDays}/${pick.st.missedDays}`) fail(`export: ${pick.name} (no handle) unknown/missed days ${got}, expected ${pick.st.unknownDays}/${pick.st.missedDays}`);
    if (!line[head.indexOf("let_op")].includes("geen Instagram-handle")) fail("export: let_op has no 'geen Instagram-handle'");
  }
  // The export keeps every video that disappeared (Finn lost two); only Overzicht limits it to the last days.
  const finnExport = cells(lines.find((l) => l.startsWith("Finn;")));
  if (!finnExport[head.indexOf("let_op")].includes("2 video's verdwenen")) fail(`export: Finn's let_op (${finnExport[head.indexOf("let_op")]})`);
}
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
  // Instagram every 15 minutes, TikTok only at the start and the last run: said in the text and in the cost.
  const flat = card.replace(/\s+/g, " ");
  if (!/Instagram-profielen elke 15 minuten/.test(flat) || !/TikTok alleen bij de start en bij de laatste run/.test(flat)
      || !/records per uur voor Instagram \(4 runs × \d+ accounts\), plus voor TikTok [\d.]+ records in totaal \(2 runs × \d+ accounts: bij de start en bij de laatste run\)/.test(flat)) fail(`finale card: cost text wrong (${flat.slice(0, 600)})`);
  // Dutch 24-hour fields instead of the browser's own date/time inputs ("02:00 AM").
  if (await fp.$('#bh-finale input[type="date"], #bh-finale input[type="time"]')) fail("finale card: native date/time inputs");
  const hours = await fp.$$eval('#finale-start [name="hour"] option', (o) => o.map((x) => x.textContent));
  const dayText = await fp.$eval('#finale-start [name="date"] option', (o) => o.textContent);
  if (hours.length !== 24 || hours[23] !== "23" || !/^(ma|di|wo|do|vr|za|zo) \d+ /.test(dayText)) fail(`finale card: not Dutch 24-hour fields (${dayText}, ${hours.length} hours)`);
  const est = await fp.textContent("#finale-start-estimate");
  const m = est.match(/(\d+) Instagram-runs × (\d+) accounts \+ 2 TikTok-runs × (\d+) accounts ≈ ([\d.]+) records/);
  if (!m || Number(m[1]) * Number(m[2]) + 2 * Number(m[3]) !== Number(m[4].replace(/\./g, ""))) fail(`finale card: estimate wrong (${est})`);
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

// Beheer: "Leerlingen zonder Instagram" is only there while somebody lacks a handle. This goes last: it gives students handles.
{
  const igMissing = () => [...lib.groupAccounts(lib.parseAccounts(accountsSheet)).values()].filter((g) => !g.instagram);
  const bp = await open({ width: 1280, height: 900 }, "#beheer");
  await bp.waitForSelector("#acc-body tr");
  if (await bp.$eval("#ig-card", (c) => c.hidden) || !igMissing().length) fail("beheer: 'Leerlingen zonder Instagram' hidden while students lack a handle");
  // Everybody but one has a handle: the last one is filled in through the form, which then makes the block disappear.
  const [last, ...rest] = igMissing();
  for (const g of rest) accountsSheet.find((r) => r._row === g.instagramRow).instagram_handle = `fill.ig${g.instagramRow}`;
  await bp.reload();
  await bp.waitForSelector("#ig-missing form[data-ig-quick]");
  if ((await bp.$$eval("#ig-missing form[data-ig-quick]", (f) => f.length)) !== 1 || await bp.$eval("#ig-card", (c) => c.hidden)) fail("beheer: the block should show the one student without a handle");
  await bp.fill("#ig-missing form[data-ig-quick] input", "@Last.One");
  await bp.click("#ig-missing form[data-ig-quick] button[type=submit]");
  await bp.waitForFunction(() => document.getElementById("ig-card").hidden, null, { timeout: 10000 });
  const said = await bp.textContent("#acc-msg");
  if (!/Instagram van .*@last\.one opgeslagen/.test(said)) fail(`beheer: no confirmation after saving the last handle (${said})`);
  if (!(await bp.isVisible("#acc-body tr")) || !(await bp.isVisible("#freq-form"))) fail("beheer: the rest of Beheer disappeared with the block");
  // The students' Vandaag/Overzicht groups agree: nobody without a handle is left either.
  await bp.evaluate(() => { location.hash = "overzicht"; });
  await bp.waitForSelector("#ov-body tr[data-handle]");
  if (/geen Instagram-handle/.test(await bp.textContent("#ov-actions"))) fail("overzicht: Actie nodig still lists students without a handle");
  if (process.env.SHOTS) { await bp.evaluate(() => { location.hash = "beheer"; }); await bp.screenshot({ path: `${process.env.SHOTS}/private-beheer-no-ig-block-1280px.png`, fullPage: true }); }
  if (bp.errors.length) fail(`beheer without the Instagram block: browser errors: ${bp.errors.join(" | ")}`);
  console.log(`beheer: the Instagram block is gone once the last of ${rest.length + 1} students got a handle; the confirmation moved above the table`);
  await bp.close();
}

await browser.close();
server.close();
console.log(failed ? "Private check FAILED" : "Private check passed");
process.exit(failed ? 1 : 0);
