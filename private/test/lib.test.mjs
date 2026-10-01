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
  assert.equal(lib.remainingProfileRuns(CFG, at, new Set(["2026-10-23/08u"])), 91);
  assert.equal(lib.remainingProfileRuns(CFG, at, new Set()), 92);
  // Campaign until Friday 30 Oct: windows open that day, none on the 31st.
  assert.equal(CFG.campaign.end, "2026-10-30");
  assert.equal(CFG.budget.monthlyCap, 23000);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-30T22:10:00+01:00")), ["2026-10-30/22u"]);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-31T00:10:00+01:00")), []);
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
  assert.equal(st.medianViews, 50);   // views 100, 50, 300, 50, 0: the typical video, not the average
  assert.equal(st.engagement, (9 + 5) / 500);
  assert.equal(st.daysSinceLast, 1);
  assert.deepEqual(st.tags[0], ["fyp", 5]);
});

test("off days: weekends and Herfstvakantie never break a streak, aren't missed or warned about", () => {
  assert.equal(lib.isOffDay(CFG, "2026-10-03"), true);   // Saturday
  assert.equal(lib.isOffDay(CFG, "2026-10-21"), true);   // Herfstvakantie (Wednesday)
  assert.equal(lib.isOffDay(CFG, "2026-10-26"), false);  // Monday after the holiday
  assert.equal(lib.offDayName(CFG, "2026-10-19"), "Herfstvakantie");
  assert.equal(lib.offDayName(CFG, "2026-10-04"), "weekend");
  const p = (id, iso) => ({ video_id: id, created_at: iso, views: 10 });
  // Every weekday until Mon 12 Oct, Tue 13 missed, then Wed 14 - Sat 17 (a free day, still counts).
  const posts = [];
  for (let d = "2026-09-28"; d <= "2026-10-12"; d = lib.addDays(d, 1)) {
    if (!lib.isOffDay(CFG, d)) posts.push(p(d, `${d}T10:00:00Z`));
  }
  for (const d of ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]) posts.push(p(d, `${d}T10:00:00Z`));
  // Monday 26 Oct at noon: nothing since Saturday 17, but the week between was all free days.
  let st = lib.studentStats(posts, CFG, ams("2026-10-26T12:00:00+02:00"));
  assert.deepEqual(st.missedList, ["2026-10-13"]);
  assert.equal(st.streak, 4);        // 14-17 Oct; 18-25 Oct free, 26 Oct not over yet
  assert.equal(st.longest, 11);      // 28 Sep - 12 Oct: 11 weekdays, weekends in between don't break it
  assert.equal(st.quietDays, 1);     // only today (26 Oct) counts: no warning
  // Posting every school day to the end (26-30 Oct): the streak carries on and stays after the campaign ends.
  for (const d of ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]) posts.push(p("e" + d, `${d}T10:00:00Z`));
  st = lib.studentStats(posts, CFG, ams("2026-11-02T12:00:00+01:00"));
  assert.equal(st.streak, 9);
  // Posted Wednesday 30 Sep, now Sunday 4 Oct: Thu and Fri count, the weekend doesn't.
  st = lib.studentStats([p("a", "2026-09-30T10:00:00Z")], CFG, ams("2026-10-04T12:00:00+02:00"));
  assert.equal(st.quietDays, 2);
  assert.deepEqual(st.missedList, ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"]);
  assert.equal(st.streak, 0);        // Thu 1 and Fri 2 Oct were missed
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
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-31T08:00:00+01:00")), []);  // after collect_until
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
  for (const day of ["2026-10-02", "2026-10-30"]) { // first and last Friday of the collection
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

// ---------- dagopdrachten, Vandaag, buiten schaal, Opvallend ----------

test("parseAssignments: active rows only, last row per date wins, sheet serial dates", () => {
  const rows = [
    { _row: 2, date: "2026-10-02", min_posts: 3, label: "eerst", active: "ja" },
    { _row: 3, date: "2026-10-02", min_posts: 5, label: "later", active: "" },
    { _row: 4, date: "2026-10-05", min_posts: 2, label: "", active: "nee" },
    { _row: 5, date: 46301, min_posts: "2", label: "", active: "ja" }, // 6 Oct 2026 as a Sheets serial number
    { _row: 6, date: "kapot", min_posts: 2, active: "ja" },
  ];
  assert.deepEqual(lib.parseAssignments(rows).map((a) => [a.row, a.date, a.min, a.label]),
    [[3, "2026-10-02", 5, "later"], [5, "2026-10-06", 2, ""]]);
});

test("dagopdracht: judged after the day, never breaks the streak; zero posts is still a missed day", () => {
  const p = (id, iso) => ({ video_id: id, created_at: iso, views: 10 });
  const tasks = [{ date: "2026-10-01", min: 3, label: "" }, { date: "2026-10-02", min: 2, label: "" },
    { date: "2026-10-05", min: 2, label: "" }, { date: "2026-10-06", min: 2, label: "" }];
  const posts = [p("a", "2026-09-30T10:00:00Z"),
    p("b", "2026-10-01T09:00:00Z"), p("c", "2026-10-01T11:00:00Z"),       // 2 of 3: not reached
    p("d", "2026-10-02T09:00:00Z"), p("e", "2026-10-02T11:00:00Z"),       // 2 of 2: reached
    p("f", "2026-10-06T09:00:00Z")];                                     // today, 1 of 2: still pending
  const st = lib.studentStats(posts, CFG, ams("2026-10-06T15:00:00+02:00"), tasks);
  assert.deepEqual(st.tasks.map((t) => [t.date, t.count, t.status]),
    [["2026-10-01", 2, "missed"], ["2026-10-02", 2, "reached"], ["2026-10-05", 0, "missed"], ["2026-10-06", 1, "pending"]]);
  assert.equal(st.tasksMissed, 2);
  // Streak: 30 Sep - 2 Oct, weekend free, 5 Oct missed (0 posts), today 6 Oct posted -> 1. The 2/3 on 1 Oct
  // does not break anything; 5 Oct does, as a normal missed day.
  assert.equal(st.streak, 1);
  assert.deepEqual(st.missedList, ["2026-09-28", "2026-09-29", "2026-10-05"]);
  const plain = lib.studentStats(posts, CFG, ams("2026-10-06T15:00:00+02:00"));
  assert.equal(plain.streak, st.streak);
  assert.equal(plain.longest, st.longest);
});

test("todayStatus / todayTargets: who still has to post today; private accounts can't be checked", () => {
  const now = ams("2026-10-06T13:00:00+02:00");
  const students = [
    { handle: "a", posts: [{ created_at: "2026-10-06T07:00:00Z" }] },                                 // posted 09:00
    { handle: "b", posts: [{ created_at: "2026-10-05T21:30:00Z" }] },                                 // 23:30 yesterday
    { handle: "c", posts: [], isPrivate: true },
    { handle: "d", posts: [] },
  ];
  let st = lib.todayStatus(CFG, students, [], now);
  assert.deepEqual(st.rows.map((r) => [r.handle, r.count, r.done]), [["a", 1, true], ["b", 0, false], ["c", 0, false], ["d", 0, false]]);
  assert.deepEqual(lib.todayTargets(st), ["b", "d"]);
  // With a dagopdracht of 2 today, one post is not enough yet.
  st = lib.todayStatus(CFG, students, [{ date: "2026-10-06", min: 2, label: "" }], now);
  assert.equal(st.task.min, 2);
  assert.deepEqual(lib.todayTargets(st), ["a", "b", "d"]);
  assert.equal(lib.todayStatus(CFG, students, [], ams("2026-10-10T12:00:00+02:00")).offDay, true); // Saturday
});

test("lastTodayCheck: from the activity log (dispatch) or run_log (today_check)", () => {
  const runLog = [{ run_type: "today_check", timestamp: "2026-10-06T10:00:00Z", dry_run: false },
    { run_type: "profiles", timestamp: "2026-10-06T11:00:00Z", dry_run: false },
    { run_type: "today_check", timestamp: "2026-10-06T11:30:00Z", dry_run: true }];
  assert.equal(lib.lastTodayCheck(runLog, []), Date.parse("2026-10-06T10:00:00Z"));
  assert.equal(lib.lastTodayCheck(runLog, [{ action: lib.TODAY_CHECK_ACTION, timestamp: "2026-10-06T10:20:00Z" }]),
    Date.parse("2026-10-06T10:20:00Z"));
  // A check never counts as a full profiles run (no 30-minute "Nu verversen" cooldown, no 60-minute skip).
  assert.equal(lib.lastProfilesRun([{ run_type: "today_check", timestamp: "2026-10-06T10:00:00Z", snapshot_ids: "sd" }]), null);
});

test("parseOutliers and median", () => {
  assert.deepEqual([...lib.parseOutliers([{ handle: "@Big.One", buiten_schaal: "ja" }, { handle: "x", buiten_schaal: "nee" }, { handle: "", buiten_schaal: "ja" }])], ["big.one"]);
  assert.equal(lib.median([5, 1, 3]), 3);
  assert.equal(lib.median([4, 1, 3, 2]), 2.5);
  assert.equal(lib.median([]), null);
});

test("signals: likes per view, step growth, silent videos and follower jumps, relative to the class", () => {
  const S = CFG.signals;
  const v = (id, handle, views, likes, comments = 5, shares = 1) => ({ video_id: id, handle, views, likes, comments, shares });
  const posts = [
    v("1", "a", 2000, 200), v("2", "b", 3000, 300), v("3", "c", 4000, 400), v("4", "d", 5000, 500), // ratio 0.10
    v("5", "e", 6000, 6),          // 0.001: far below
    v("6", "f", 1500, 900),        // 0.6: far above
    v("7", "g", 500, 1),           // too small to judge
    v("8", "h", 8000, 800, 0, 0),  // many views, no comments or shares
    v("9", "i", 10000, 1000),      // step: 1,000 -> 9,500 in 2 h, then flat
  ];
  const h = 3600e3, t0 = Date.parse("2026-10-05T08:00:00Z");
  const byVideo = new Map([["9", [{ t: t0, views: 1000 }, { t: t0 + 2 * h, views: 9500 }, { t: t0 + 4 * h, views: 9700 },
    { t: t0 + 8 * h, views: 9900 }, { t: t0 + 14 * h, views: 10000 }]],
    // Natural growth: spread over many runs, never one big step.
    ["1", [{ t: t0, views: 200 }, { t: t0 + 2 * h, views: 700 }, { t: t0 + 4 * h, views: 1300 }, { t: t0 + 6 * h, views: 2000 }]]]);
  const series = new Map([
    ["a", [{ t: t0, views: 0, followers: 10 }, { t: t0 + 24 * h, views: 2000, followers: 30 }]],  // 100 views per follower
    ["b", [{ t: t0, views: 0, followers: 10 }, { t: t0 + 24 * h, views: 3000, followers: 40 }]],
    ["c", [{ t: t0, views: 0, followers: 10 }, { t: t0 + 2 * h, views: 50, followers: 400 }]],    // +390 followers, 50 views
  ]);
  const flags = lib.signals(S, posts, byVideo, series);
  const kinds = (k) => flags.filter((f) => f.kind === k).map((f) => f.video || f.handle).sort();
  assert.deepEqual(kinds("likes"), ["5", "6"]);
  assert.equal(flags.find((f) => f.video === "6").high, true);
  assert.deepEqual(kinds("step"), ["9"]);
  assert.ok(flags.find((f) => f.kind === "step").share > 0.8);
  assert.deepEqual(kinds("silent"), ["8"]);
  assert.deepEqual(kinds("followers"), ["c"]);
  assert.equal(flags.find((f) => f.kind === "followers").followers, 390);
  assert.ok(!flags.some((f) => f.video === "7"), "small videos are never flagged");
});
