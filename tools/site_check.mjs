// Checks the live website against the real published CSV links.
// Runs in GitHub Actions: node tools/site_check.mjs <site-url>
// Prints only counts and status, never sheet contents.

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { chromium } from "playwright";

const siteUrl = process.argv[2];
const origin = new URL(siteUrl).origin;

// Use the exact CSV URLs the site uses.
const sandbox = { window: {} };
vm.runInNewContext(readFileSync("site/config.js", "utf8"), sandbox);
const cfg = sandbox.window.TT_CONFIG;

const expected = {
  handles: ["handle", "is_private", "last_status"],
  history: ["timestamp", "handle", "total_views", "followers", "campaign_likes", "campaign_posts"],
  posts: ["video_id", "handle", "created_at", "views"],
  post_history: ["video_id", "handle", "timestamp", "views", "likes"],
  finale: ["started_at", "deadline", "status", "ended_at"],
  outliers: ["handle", "buiten_schaal"],
};
// Created by the first collector run after it was added (or the first "buiten schaal" switch);
// until then the site simply has no outliers.
const optional = new Set(["outliers"]);
const missingTabs = new Set();

let failed = false;
const fail = (msg) => { failed = true; console.log(`FAIL ${msg}`); };

for (const [tab, cols] of Object.entries(expected)) {
  let res, text;
  try {
    res = await fetch(cfg.csvUrl(tab), { headers: { Origin: origin } });
    text = await res.text();
  } catch (err) {
    fail(`${tab}: network error ${err.cause?.code || err.message}`);
    continue;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = (lines[0] || "").split(",").map((h) => h.trim());
  const cors = res.headers.get("access-control-allow-origin");
  const type = res.headers.get("content-type");
  console.log(`${tab}: HTTP ${res.status}, type=${type}, CORS=${cors}, data rows=${Math.max(0, lines.length - 1)}`
    + (tab === "posts" ? `, hashtags column=${header.includes("hashtags")}` : ""));
  // (Google may also answer an unknown gid with another tab's CSV: then the columns don't match.)
  if (optional.has(tab) && (!res.ok || !cols.every((c) => header.includes(c)))) {
    console.log(`${tab}: not created yet (fine: no account marked)`);
    missingTabs.add(tab);
    continue;
  }
  if (!res.ok) fail(`${tab}: HTTP ${res.status}`);
  else if (text.trimStart().startsWith("<")) fail(`${tab}: got HTML instead of CSV (not published?)`);
  else if (!cols.every((c) => header.includes(c))) fail(`${tab}: header is [${header.join(", ")}]`);
  if (cors !== "*" && cors !== origin) fail(`${tab}: browser fetch would be blocked (no CORS header for ${origin})`);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// A tab that doesn't exist yet answers 400; the site handles that, but Chrome still logs it.
const expectedError = (text) => missingTabs.size > 0 && /Failed to load resource.*\b400\b/.test(text);
page.on("console", (m) => m.type() === "error" && !expectedError(m.text()) && errors.push(m.text()));

// Requests still open, for the report when a page never settles.
const pending = new Map();
page.on("request", (r) => pending.set(r, Date.now()));
page.on("requestfinished", (r) => pending.delete(r));
page.on("requestfailed", (r) => pending.delete(r));
const consoleLog = [];
page.on("console", (m) => consoleLog.push(`${m.type()}: ${m.text().slice(0, 160)}`));

for (const hash of ["#stand", "#grafiek", "#groei"]) {
  try {
    await page.goto(siteUrl + hash, { waitUntil: "networkidle" });
  } catch (err) {
    fail(`site ${hash}: page never settled (${err.message.split("\n")[0]})`);
    console.log(`  still open: ${[...pending].map(([r, t]) => `${r.method()} ${r.url().slice(0, 140)} (${Math.round((Date.now() - t) / 1000)} s)`).join(" | ") || "none"}`);
    console.log(`  console: ${consoleLog.slice(-12).join(" | ") || "none"}`);
    const state = await page.evaluate(() => ({ rows: document.querySelectorAll("#board-body tr").length,
      updated: document.getElementById("updated")?.textContent, error: document.getElementById("error")?.textContent,
      ready: document.readyState })).catch((e) => ({ evaluate: e.message.slice(0, 100) }));
    console.log(`  page: ${JSON.stringify(state)}`);
    continue;
  }
  await page.waitForFunction(
    () => document.querySelector("#board-body tr") || !document.getElementById("error").hidden,
    null, { timeout: 30000 });
  const error = await page.$eval("#error", (el) => (el.hidden ? "" : el.textContent));
  const rows = await page.$$eval("#board-body tr[data-handle]", (r) => r.length);
  const canvases = await page.$$eval(".view:not([hidden]) canvas", (c) => c.length);
  console.log(`site ${hash}: board rows=${rows}, charts=${canvases}, updated="${await page.textContent("#updated")}"`);
  if (error) fail(`site ${hash}: shows error "${error}"`);
  if (hash === "#stand" && rows === 0) fail("site: leaderboard is empty");
}
// Video's tab (Snelste stijgers) renders; post_history is only fetched here, so log its size and speed.
{
  const t0 = Date.now();
  await page.goto(siteUrl + "#videos", { waitUntil: "networkidle" });
  await page.waitForSelector("#videos-body tr", { timeout: 60000 });
  await page.waitForFunction(() => !/laden/.test(document.getElementById("videos-body").textContent), null, { timeout: 60000 }).catch(() => {});
  const info = await page.evaluate(() => state.postHistory && { rows: state.postHistory.rows, ms: state.postHistory.ms });
  const rows = await page.$$eval("#videos-body tr[data-handle]", (r) => r.length);
  console.log(`site #videos: ${rows} videos in ${Date.now() - t0} ms` + (info ? `, post_history ${info.rows} rows fetched+parsed in ${info.ms} ms` : ", post_history not linked yet"));
  if (!(await page.isVisible("#view-videos"))) fail("site: Video's tab does not open");
  if (info && info.ms > 15000) fail(`site: post_history is too slow (${info.ms} ms)`);
}
// Hashtags tab renders (it may be empty until the collector has stored hashtags).
{
  await page.goto(siteUrl + "#hashtags", { waitUntil: "networkidle" });
  await page.waitForSelector("#tags-body tr", { timeout: 15000 }).catch(() => {});
  const tagRows = await page.$$eval("#tags-body tr[data-tag]", (r) => r.length);
  const visible = await page.isVisible("#view-hashtags");
  console.log(`site #hashtags: visible=${visible}, hashtag rows=${tagRows}, "${await page.textContent("#tags-meta")}"`);
  if (!visible) fail("site: hashtags view does not open");
}
// Sortable leaderboard: a header click sorts high to low, a second click reverses it.
{
  await page.goto(siteUrl + "#stand", { waitUntil: "networkidle" });
  await page.waitForSelector("#board-body tr[data-handle]", { timeout: 30000 });
  const values = (col) => page.$$eval(`#board-body td.${col}`, (tds) =>
    tds.map((td) => td.textContent.trim()).filter((t) => t !== "–").map((t) => Number(t.replace(/\./g, ""))));
  const sorted = (list, dir) => list.every((v, i) => i === 0 || (v - list[i - 1]) * dir <= 0);
  for (const col of ["followers", "posts", "likes", "views"]) {
    const btn = `#view-stand th[data-sort="${col}"] button`;
    await page.click(btn);
    const desc = await values(`c-${col}`);
    const ariaDesc = await page.getAttribute(`#view-stand th[data-sort="${col}"]`, "aria-sort");
    await page.click(btn);
    const asc = await values(`c-${col}`);
    const ariaAsc = await page.getAttribute(`#view-stand th[data-sort="${col}"]`, "aria-sort");
    const ok = sorted(desc, 1) && sorted(asc, -1) && ariaDesc === "descending" && ariaAsc === "ascending";
    console.log(`site sort ${col}: ${ok ? "ok" : "WRONG"} (${desc.length} values)`);
    if (!ok) fail(`site: sorting on ${col} is wrong (aria ${ariaDesc}/${ariaAsc})`);
  }
  const link = await page.getAttribute("#present-link", "href");
  console.log(`site presentatie button: href=${link}, visible=${await page.isVisible("#present-link")}`);
  if (link !== "?present" || !(await page.isVisible("#present-link"))) fail("site: Presentatie button missing");
}
const first = await page.$eval("#board-body tr[data-handle]", (r) => r.dataset.handle).catch(() => null);
if (first) {
  await page.goto(`${siteUrl}#account/${encodeURIComponent(first)}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const posts = await page.$$eval("#view-account tbody tr", (r) => r.length);
  console.log(`site account page: post rows=${posts}`);
}
// The old ?beheerder refresh button is gone: the public site has no admin UI at all
// (refreshing lives on the private site).
await page.goto(`${siteUrl}?beheerder#stand`, { waitUntil: "networkidle" });
const adminLeft = await page.$$eval("#admin, a[href*='force-refresh']", (e) => e.length);
console.log(`site ?beheerder: ${adminLeft ? "ADMIN UI STILL PRESENT" : "no admin UI (ok)"}`);
if (adminLeft) fail("site: admin UI still present with ?beheerder");
if (errors.length) fail(`site: browser errors: ${errors.join(" | ")}`);

// Presentation mode (?present) at both projector resolutions: every slide fits without
// scrolling, the slideshow cycles, no tabs/admin UI, light theme, "Bijgewerkt" shown.
for (const [w, h] of [[1920, 1080], [1280, 720]]) {
  const pp = await browser.newPage({ viewport: { width: w, height: h } });
  const perrors = [];
  pp.on("pageerror", (e) => perrors.push(e.message));
  pp.on("console", (m) => m.type() === "error" && !expectedError(m.text()) && perrors.push(m.text()));
  await pp.goto(`${siteUrl}?present&sec=2`, { waitUntil: "networkidle" });
  await pp.waitForSelector("#p-stage[data-kind]", { timeout: 30000 });
  const count = await pp.$$eval("#p-dots button", (s) => s.length);
  const kinds = [];
  for (let i = 0; i < count; i++) {
    await pp.waitForFunction((n) => document.querySelectorAll("#p-dots button")[n]?.classList.contains("on"), i, { timeout: 10000 });
    await pp.waitForTimeout(700); // let the enter animation finish
    const m = await pp.evaluate(() => {
      const st = document.getElementById("p-stage");
      const doc = document.documentElement;
      return {
        kind: st.dataset.kind,
        overflow: st.scrollHeight > st.clientHeight + 1 || st.scrollWidth > st.clientWidth + 1,
        scroll: doc.scrollHeight > innerHeight + 1 || doc.scrollWidth > innerWidth + 1,
      };
    });
    kinds.push(m.kind);
    if (m.overflow || m.scroll) fail(`present ${w}x${h}: slide ${i + 1} (${m.kind}) does not fit the screen`);
  }
  const ui = await pp.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    header: getComputedStyle(document.querySelector(".top")).display,
    admin: !!document.querySelector("#admin, a[href*='force-refresh']"),
    updated: document.getElementById("p-updated").textContent,
  }));
  await pp.waitForTimeout(3300);
  const idle = await pp.evaluate(() => document.getElementById("present").classList.contains("p-idle"));
  console.log(`present ${w}x${h}: slides=[${kinds.join(", ")}], theme=${ui.theme}, cursor hidden=${idle}, "${ui.updated}"`);
  for (const k of ["podium", "graph", "risers"]) if (!kinds.includes(k)) fail(`present ${w}x${h}: no ${k} slide`);
  if (ui.theme !== "light") fail(`present ${w}x${h}: theme is ${ui.theme}, expected light`);
  if (ui.header !== "none") fail(`present ${w}x${h}: tabs/header are visible`);
  if (ui.admin) fail(`present ${w}x${h}: admin button is visible`);
  if (!ui.updated.startsWith("Bijgewerkt")) fail(`present ${w}x${h}: no "Bijgewerkt" time`);
  if (!idle) fail(`present ${w}x${h}: cursor is not hidden after 3 s`);
  if (perrors.length) fail(`present ${w}x${h}: browser errors: ${perrors.join(" | ")}`);
  await pp.close();
}
// Manual skipping (slow timer so auto-advance can't interfere): arrows, Space, Shift+Space,
// PageUp/PageDown, wrap-around, and clicking a dot.
{
  const nav = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await nav.goto(`${siteUrl}?present&sec=120`, { waitUntil: "networkidle" });
  await nav.waitForSelector("#p-dots button.on", { timeout: 30000 });
  const total = await nav.$$eval("#p-dots button", (b) => b.length);
  const current = () => nav.$$eval("#p-dots button", (b) => b.findIndex((x) => x.classList.contains("on")));
  const steps = [
    ["ArrowRight", 1], ["Space", 2 % total], ["ArrowLeft", 1], ["Shift+Space", 0],
    ["ArrowLeft", total - 1], ["PageUp", total - 2], ["PageDown", total - 1], ["ArrowRight", 0],
  ];
  const got = [];
  for (const [key, want] of steps) {
    await nav.keyboard.press(key);
    const at = await current();
    got.push(`${key}→${at + 1}`);
    if (at !== want) fail(`present: ${key} went to slide ${at + 1}, expected ${want + 1}`);
  }
  await nav.click(`#p-dots button[data-slide="${total - 1}"]`);
  const clicked = await current();
  if (clicked !== total - 1) fail(`present: clicking the last dot went to slide ${clicked + 1}, expected ${total}`);
  await nav.keyboard.press("Space"); // the clicked dot must not keep focus and swallow Space
  const afterSpace = await current();
  if (afterSpace !== 0) fail(`present: Space after a dot click went to slide ${afterSpace + 1}, expected 1`);
  console.log(`present manual skip (${total} slides): ${got.join(" ")}, click dot→${clicked + 1}, Space→${afterSpace + 1}`);
  await nav.close();
}

// Pause: P / "." / B (clicker black-screen button) / the ⏸ button; skipping keeps it paused.
{
  const pz = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await pz.goto(`${siteUrl}?present&sec=2`, { waitUntil: "networkidle" });
  await pz.waitForSelector("#p-dots button.on", { timeout: 30000 });
  const at = () => pz.$$eval("#p-dots button", (b) => b.findIndex((x) => x.classList.contains("on")));
  const paused = () => pz.$eval("#p-paused", (e) => !e.hidden);
  await pz.keyboard.press("p");
  const a = await at();
  await pz.waitForTimeout(3000);
  const stayed = (await at()) === a && (await paused());
  await pz.keyboard.press("ArrowRight");
  const skipped = (await at()) !== a && (await paused());
  await pz.keyboard.press(".");
  const b = await at();
  await pz.waitForTimeout(3000);
  const resumed = !(await paused()) && (await at()) !== b;
  await pz.keyboard.press("b");
  const bPauses = await paused();
  await pz.click("#p-pause");
  const buttonResumes = !(await paused());
  console.log(`present pause: P stays=${stayed}, skip while paused=${skipped}, "." resumes=${resumed}, B pauses=${bPauses}, button resumes=${buttonResumes}`);
  if (!(stayed && skipped && resumed && bPauses && buttonResumes)) fail("present: pause does not work as expected");
  await pz.close();
}

const dark = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await dark.goto(`${siteUrl}?present&donker`, { waitUntil: "networkidle" });
const darkTheme = await dark.evaluate(() => document.documentElement.dataset.theme);
console.log(`present ?donker: theme=${darkTheme}`);
if (darkTheme !== "dark") fail("present: ?donker does not switch to the dark theme");
await browser.close();

console.log(failed ? "Site check FAILED" : "Site check passed");
process.exit(failed ? 1 : 0);
