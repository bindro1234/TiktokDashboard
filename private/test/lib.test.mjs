// Unit tests for the shared logic (synthetic data only). Run: node --test private/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as lib from "../public/lib.js";

const CFG = JSON.parse(readFileSync(new URL("../src/config.json", import.meta.url)));
const ams = (s) => Date.parse(s); // ISO strings with an explicit offset

test("handle normalization matches the Python collector (tests/handle_cases.json)", () => {
  const cases = JSON.parse(readFileSync(new URL("../../tests/handle_cases.json", import.meta.url)));
  for (const c of cases) assert.equal(lib.normalizeHandle(c.raw).handle, c.handle, JSON.stringify(c.raw));
});

test("parseAccounts flags problems like the collector and keeps row numbers", () => {
  const rows = [
    { _row: 2, student_name: "A", tiktok_handle: "@one", active: "ja" },
    { _row: 3, student_name: "B", tiktok_handle: "https://vm.tiktok.com/x", active: "ja" },
    { _row: 4, student_name: "C", tiktok_handle: "ONE", active: "" },
    { _row: 5, student_name: "D", tiktok_handle: "two", active: "nee" },
    { _row: 6, student_name: "E", tiktok_handle: "three", active: "misschien" },
    { _row: 7, student_name: "", tiktok_handle: "four", active: true },
    { _row: 8, student_name: "G", tiktok_handle: "", active: "" },
  ];
  const out = lib.parseAccounts(rows);
  assert.deepEqual(out.filter((a) => a.tracked).map((a) => a.handle), ["one", "four"]);
  assert.deepEqual(out.filter((a) => a.issue).map((a) => a.row), [3, 4, 6, 8]);
  assert.match(out.find((a) => a.row === 4).issue, /rij 2/);
  assert.equal(out.find((a) => a.row === 5).active, false);
});

test("budget helpers agree with collector/model.py", () => {
  const log = [
    { timestamp: "2026-10-01T05:00:00Z", dry_run: false, actual_records: 45, run_type: "profiles", snapshot_ids: "sd_1", window: "2026-10-01/ochtend", status: "ok" },
    { timestamp: "2026-10-01T16:00:00Z", dry_run: true, actual_records: 45, run_type: "profiles", snapshot_ids: "sd_2" },
    { timestamp: "2026-09-30T16:00:00Z", dry_run: "FALSE", actual_records: 45, run_type: "force_refresh", snapshot_ids: "sd_3" },
    { timestamp: "2026-10-01T06:00:00Z", dry_run: false, actual_records: 0, run_type: "force_refresh", snapshot_ids: "", status: "refused" },
  ];
  assert.equal(lib.monthUsage(log, Date.parse("2026-10-02T00:00:00Z")), 45);
  assert.equal(lib.lastProfilesRun(log), Date.parse("2026-10-01T05:00:00Z"));
  assert.deepEqual([...lib.doneWindows(log)], ["2026-10-01/ochtend"]);
  // Same case as test_remaining_profile_runs: Friday 23 Oct 08:45, the morning already ran.
  const runs = lib.remainingProfileRuns(CFG, ams("2026-10-23T08:45:00+02:00"), new Set(["2026-10-23/ochtend"]));
  assert.equal(runs, 7);
});

test("studentStats: missed days, streaks, engagement and best video", () => {
  const p = (id, iso, views, likes = 0) => ({ video_id: id, created_at: iso, views, likes, comments: 1, shares: 0, hashtags: "glu fyp" });
  const posts = [
    p("1", "2026-09-28T08:00:00Z", 100, 9),
    p("2", "2026-09-29T21:30:00Z", 50),  // 23:30 Amsterdam on 29 Sept
    p("3", "2026-09-30T22:30:00Z", 300), // 00:30 Amsterdam on 1 Oct
    p("4", "2026-10-02T10:00:00Z", 50),
    p("5", "2026-10-02T12:00:00Z", 0),
    { ...p("6", "2026-09-27T10:00:00Z", 999), hashtags: "" }, // before the campaign: ignored
  ];
  const st = lib.studentStats(posts, CFG, ams("2026-10-03T12:00:00+02:00"));
  assert.equal(st.posts, 5);
  assert.equal(st.perDay.get("2026-10-01"), 1);
  assert.equal(st.perDay.get("2026-09-30"), 0);
  assert.deepEqual(st.missedList, ["2026-09-30"]);
  assert.equal(st.streak, 2);   // 1 and 2 Oct; nothing yet today (3 Oct) is not a break
  assert.equal(st.longest, 2);
  assert.equal(st.best.id, "3");
  assert.equal(st.avgViews, 100);
  assert.equal(st.engagement, (9 + 5) / 500);
  assert.equal(st.daysSinceLast, 1);
  assert.deepEqual(st.tags[0], ["fyp", 5]);
});

test("toCsv: Excel NL separator, decimal comma, formula protection", () => {
  const csv = lib.toCsv(["naam", "pct"], [["=HYPERLINK(1)", 4.5], ["Jan; Piet", 3]], { sep: ";", decimalComma: true });
  assert.equal(csv, "naam;pct\r\n'=HYPERLINK(1);4,5\r\n\"Jan; Piet\";3\r\n");
  assert.equal(lib.toCsv(["a"], [["x,y"]]), "a\r\n\"x,y\"\r\n");
});

// ---------- collector windows (backup timer) ----------

const log = (window, status, dry = false) => ({ window, status, dry_run: dry, timestamp: "2026-10-01T00:00:00Z" });

test("openWindows follows Amsterdam time in summer and winter", () => {
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T06:45:00+02:00")), ["2026-10-01/ochtend"]);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T08:05:00+02:00")), []);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-26T19:45:00+01:00")), ["2026-10-26/avond"]);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-02T08:45:00+02:00")), ["2026-10-02/weekrefresh"]); // Friday
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T08:45:00+02:00")), []);                         // Thursday
  assert.deepEqual(lib.openWindows(CFG, ams("2026-09-27T07:00:00+02:00")), []);  // before the campaign
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-27T07:00:00+01:00")), []);  // after collect_until
});

test("dueWindows skips done windows, stops after max failures, adds the one-time check", () => {
  const at = ams("2026-10-01T18:25:00+02:00");
  assert.deepEqual(lib.dueWindows(CFG, [], at), ["2026-10-01/avond"]);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-01/avond", "skipped")], at), []);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-01/avond", "ok", true)], at), ["2026-10-01/avond"]); // dry run
  const fails = Array(CFG.schedule.maxAttemptsPerWindow).fill(log("2026-10-01/avond", "failed"));
  assert.deepEqual(lib.dueWindows(CFG, fails, at), []);
  const check = ams(`${CFG.windowCheckDate}T18:45:00+02:00`);
  const eve = `${CFG.windowCheckDate}/avond`;
  assert.deepEqual(lib.dueWindows(CFG, [log(eve, "ok")], check), [`${CFG.windowCheckDate}/window-check`]);
  assert.deepEqual(lib.dueWindows(CFG, [log(eve, "ok"), log(`${CFG.windowCheckDate}/window-check`, "ok")], check), []);
});

test("the Cloudflare cron in wrangler.toml hits every window at least 4 times, summer and winter", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const crons = JSON.parse(toml.match(/^crons\s*=\s*(\[.*\])/m)[1]);
  const expand = (field, max) => field.split(",").flatMap((part) => {
    const [a, b] = part.split("-").map(Number);
    return part === "*" ? [...Array(max).keys()] : b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
  const firings = (day) => crons.flatMap((c) => {
    const [min, hour, dom, mon, dow] = c.split(/\s+/);
    assert.deepEqual([dom, mon, dow], ["*", "*", "*"]);
    return expand(hour, 24).flatMap((h) => expand(min, 60).map((m) => Date.parse(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`)));
  });
  // 1 Oct / 2 Oct (Friday) in summer time, 26 Oct in winter time; the refresh window on a winter Friday (30 Oct).
  for (const day of ["2026-10-01", "2026-10-26"]) {
    for (const w of CFG.schedule.profileRuns) {
      const hits = firings(day).filter((t) => lib.openWindows(CFG, t).includes(`${day}/${w.name}`)).length;
      assert.ok(hits >= 4, `${day} ${w.name}: ${hits} hits`);
    }
  }
  const r = CFG.schedule.refresh;
  for (const day of ["2026-10-02", "2026-10-30"]) {
    const hits = firings(day).filter((t) => { const hm = lib.localTime(t); return r.start <= hm && hm <= r.end; }).length;
    assert.ok(hits >= 4, `${day} ${r.name}: ${hits} hits`);
  }
});
