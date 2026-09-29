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
    { timestamp: "2026-10-01T05:00:00Z", dry_run: false, actual_records: 45, run_type: "profiles", snapshot_ids: "sd_1", window: "2026-10-01/06u", status: "ok" },
    { timestamp: "2026-10-01T16:00:00Z", dry_run: true, actual_records: 45, run_type: "profiles", snapshot_ids: "sd_2" },
    { timestamp: "2026-09-30T16:00:00Z", dry_run: "FALSE", actual_records: 45, run_type: "force_refresh", snapshot_ids: "sd_3" },
    { timestamp: "2026-10-01T06:00:00Z", dry_run: false, actual_records: 0, run_type: "force_refresh", snapshot_ids: "", status: "refused" },
  ];
  assert.equal(lib.monthUsage(log, Date.parse("2026-10-02T00:00:00Z")), 45);
  assert.equal(lib.lastProfilesRun(log), Date.parse("2026-10-01T05:00:00Z"));
  assert.deepEqual([...lib.doneWindows(log)], ["2026-10-01/06u"]);
  // Same case as test_remaining_profile_runs: Friday 23 Oct 08:45, the 08u window already ran.
  const at = ams("2026-10-23T08:45:00+02:00");
  assert.equal(lib.remainingProfileRuns(CFG, at, new Set(["2026-10-23/08u"])), 43);
  assert.equal(lib.remainingProfileRuns(CFG, at, new Set()), 44);
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
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T06:45:00+02:00")), ["2026-10-01/06u"]);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T07:05:00+02:00")), []);           // odd hour: between windows
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-25T18:45:00+01:00")), ["2026-10-25/18u"]); // winter time
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-26T14:30:00+01:00")), ["2026-10-26/14u"]);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T00:05:00+02:00")), ["2026-10-01/00u"]);
  // Friday 08:45: the 08u profile window and the weekly refresh are both open.
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-02T08:45:00+02:00")), ["2026-10-02/08u", "2026-10-02/weekrefresh"]);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T09:45:00+02:00")), []);           // Thursday, no refresh
  assert.deepEqual(lib.openWindows(CFG, ams("2026-09-27T08:00:00+02:00")), []);  // before the campaign
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-27T08:00:00+01:00")), []);  // after collect_until
});

test("dueWindows skips done windows, stops after max failures, adds the one-time check", () => {
  const at = ams("2026-10-01T18:25:00+02:00");
  assert.deepEqual(lib.dueWindows(CFG, [], at), ["2026-10-01/18u"]);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-01/18u", "skipped")], at), []);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-01/18u", "ok", true)], at), ["2026-10-01/18u"]); // dry run
  const fails = Array(CFG.schedule.maxAttemptsPerWindow).fill(log("2026-10-01/18u", "failed"));
  assert.deepEqual(lib.dueWindows(CFG, fails, at), []);
  // The one-time check runs in the last window of its date, after that window's profiles run.
  const last = CFG.schedule.profileRuns.at(-1).name;
  const check = ams(`${CFG.windowCheckDate}T22:45:00+02:00`);
  const eve = `${CFG.windowCheckDate}/${last}`;
  assert.deepEqual(lib.dueWindows(CFG, [log(eve, "ok")], check), [`${CFG.windowCheckDate}/window-check`]);
  assert.deepEqual(lib.dueWindows(CFG, [log(eve, "ok"), log(`${CFG.windowCheckDate}/window-check`, "ok")], check), []);
});

test("the Cloudflare cron in wrangler.toml hits every window at least 3 times, also across the DST change", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const crons = JSON.parse(toml.match(/^crons\s*=\s*(\[.*\])/m)[1]);
  // Cron fields with lists, ranges, steps and * (same parser idea as tests/test_collector.py).
  const expand = (field, lo, hi) => field.split(",").flatMap((part) => {
    const [range, step] = part.split("/");
    let [a, b] = range === "*" ? [lo, hi] : range.split("-").map(Number);
    if (b === undefined) b = step ? hi : a;
    const out = [];
    for (let v = a; v <= b; v += Number(step || 1)) out.push(v);
    return out;
  });
  const firingsOn = (day) => crons.flatMap((c) => {
    const [min, hour, dom, mon, dow] = c.split(/\s+/);
    const d = new Date(day + "T00:00:00Z");
    if (!expand(dom, 1, 31).includes(d.getUTCDate()) || !expand(mon, 1, 12).includes(d.getUTCMonth() + 1)) return [];
    if (dow !== "*" && !expand(dow, 0, 6).includes(d.getUTCDay())) return [];
    return expand(hour, 0, 23).flatMap((h) => expand(min, 0, 59).map((m) => Date.parse(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`)));
  });
  // UTC days around the local day: the 00u window starts the evening before in UTC.
  const firings = (day) => [-1, 0, 1].flatMap((d) => firingsOn(lib.addDays(day, d)));
  // Summer time, the day the clocks go back (25 Oct), winter time.
  for (const day of ["2026-10-01", "2026-10-25", "2026-10-26"]) {
    for (const w of CFG.schedule.profileRuns) {
      const hits = firings(day).filter((t) => lib.openWindows(CFG, t).includes(`${day}/${w.name}`)).length;
      assert.ok(hits >= 3, `${day} ${w.name}: ${hits} hits`);
    }
  }
  const r = CFG.schedule.refresh;
  for (const day of ["2026-10-02", "2026-10-23"]) { // first and last Friday of the collection
    const hits = firings(day).filter((t) => lib.openWindows(CFG, t).includes(`${day}/${r.name}`)).length;
    assert.ok(hits >= 4, `${day} ${r.name}: ${hits} hits`);
  }
});

// ---------- finale (manual) ----------

const FIN = { started_at: "2026-10-26T13:00:00Z", started_by: "x@y.nl", deadline: "2026-10-26T15:00:00Z", status: "active", ended_at: "" };

test("finaleState: live, ended (Eindstand), stopped early, cancelled, hard maximum", () => {
  const st = (row, iso) => lib.finaleState([row], Date.parse(iso), CFG.finale.maxHours);
  assert.equal(st(FIN, "2026-10-26T12:59:00Z").phase, null);
  assert.equal(st(FIN, "2026-10-26T14:00:00Z").phase, "live");
  assert.equal(st(FIN, "2026-10-26T15:00:00Z").phase, "ended");
  const stopped = st({ ...FIN, status: "stopped", ended_at: "2026-10-26T14:10:00Z" }, "2026-10-26T14:20:00Z");
  assert.deepEqual([stopped.phase, new Date(stopped.end).toISOString()], ["ended", "2026-10-26T14:10:00.000Z"]);
  assert.equal(st({ ...FIN, status: "cancelled" }, "2026-10-26T14:00:00Z"), null);
  const long = st({ ...FIN, deadline: "2026-10-27T13:00:00Z" }, "2026-10-26T21:00:00Z");
  assert.equal(long.phase, "ended"); // cut off at start + maxHours
  assert.equal(lib.finaleState([], Date.now(), 8), null);
});

test("finale windows replace the 2-hourly ones while live; keys match the collector", () => {
  const live = lib.finaleState([FIN], Date.parse("2026-10-26T14:05:00Z"), 8);
  const at = Date.parse("2026-10-26T14:05:00Z"); // 15:05 Amsterdam (winter time)
  assert.equal(lib.finaleWindowKey(Date.parse("2026-10-26T15:29:00Z"), 15), "2026-10-26/finale-1615");
  assert.deepEqual(lib.openWindows(CFG, at, live), ["2026-10-26/finale-1500"]);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-26/finale-1500", "ok")], at, live), []);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-26/finale-1445", "ok")], at, live), ["2026-10-26/finale-1500"]);
  assert.equal(lib.amsMs("2026-10-26", "16:00"), Date.parse("2026-10-26T15:00:00Z"));
  assert.equal(lib.amsMs("2026-10-01", "16:00"), Date.parse("2026-10-01T14:00:00Z"));
  assert.equal(lib.finaleRuns(0, 2 * 3600e3, 15), 8);
});
