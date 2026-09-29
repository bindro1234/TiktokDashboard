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
};

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
  console.log(`${tab}: HTTP ${res.status}, type=${type}, CORS=${cors}, data rows=${Math.max(0, lines.length - 1)}`);
  if (!res.ok) fail(`${tab}: HTTP ${res.status}`);
  else if (text.trimStart().startsWith("<")) fail(`${tab}: got HTML instead of CSV (not published?)`);
  else if (!cols.every((c) => header.includes(c))) fail(`${tab}: header is [${header.join(", ")}]`);
  if (cors !== "*" && cors !== origin) fail(`${tab}: browser fetch would be blocked (no CORS header for ${origin})`);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

for (const hash of ["#stand", "#grafiek", "#groei"]) {
  await page.goto(siteUrl + hash, { waitUntil: "networkidle" });
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
const first = await page.$eval("#board-body tr[data-handle]", (r) => r.dataset.handle).catch(() => null);
if (first) {
  await page.goto(`${siteUrl}#account/${encodeURIComponent(first)}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const posts = await page.$$eval("#view-account tbody tr", (r) => r.length);
  console.log(`site account page: post rows=${posts}`);
}
if (errors.length) fail(`site: browser errors: ${errors.join(" | ")}`);
await browser.close();

console.log(failed ? "Site check FAILED" : "Site check passed");
process.exit(failed ? 1 : 0);
