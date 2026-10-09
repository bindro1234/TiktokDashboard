// Unit tests for the shared logic (synthetic data only). Run: node --test private/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as lib from "../public/lib.js";

const CFG = JSON.parse(readFileSync(new URL("../src/config.json", import.meta.url)));
const ams = (s) => Date.parse(s); // ISO strings with an explicit offset

test("handle normalization matches the Python collector (tests/handle_cases.json)", () => {
  const cases = JSON.parse(readFileSync(new URL("../../tests/handle_cases.json", import.meta.url)));
  const tiktok = cases.filter((c) => (c.platform ?? "tiktok") === "tiktok");
  assert.ok(tiktok.length > 10);
  for (const c of tiktok) assert.equal(lib.normalizeHandle(c.raw).handle, c.handle, JSON.stringify(c.raw));
});

test("Instagram handle normalization matches the Python collector (same cases, Instagram's own rules)", () => {
  const cases = JSON.parse(readFileSync(new URL("../../tests/handle_cases.json", import.meta.url)));
  const instagram = cases.filter((c) => c.platform === "instagram");
  assert.ok(instagram.length > 20);
  for (const c of instagram) {
    const { handle, reason } = lib.normalizeInstagramHandle(c.raw);
    assert.equal(handle, c.handle, JSON.stringify(c.raw));
    assert.equal(reason === null, handle !== null, JSON.stringify(c.raw));
  }
  // The platforms differ: 30 characters and double periods.
  assert.equal(lib.normalizeHandle("a".repeat(30)).handle, null);
  assert.equal(lib.normalizeInstagramHandle("a".repeat(30)).handle, "a".repeat(30));
  assert.equal(lib.normalizeHandle("two..dots").handle, "two..dots");
  assert.equal(lib.normalizeInstagramHandle("two..dots").handle, null);
  assert.match(lib.normalizeInstagramHandle("https://www.instagram.com/p/DeRh47eptOn").reason, /post/);
});

test("Instagram: one account per student, on the first row; problems are reported", () => {
  // Same rows as test_instagram_accounts in tests/test_collector.py.
  const rows = [
    { _row: 2, student_name: "Anna", tiktok_handle: "@anna", active: "ja", main_account: "", Insta: "Anna.Gram" },
    { _row: 3, student_name: "Anna", tiktok_handle: "anna.ads", active: "ja", main_account: "anna", Insta: "anna.second" },
    { _row: 4, student_name: "Bram", tiktok_handle: "bram", active: "nee", Insta: "bram" },
    { _row: 5, student_name: "Cas", tiktok_handle: "cas", active: "ja", instagram_handle: "https://www.instagram.com/cas_ig/" },
    { _row: 6, student_name: "Dee", tiktok_handle: "dee", active: "ja", instagram_handle: "cas_ig" },
    { _row: 7, student_name: "Eli", tiktok_handle: "eli", active: "ja", instagram_handle: "https://www.instagram.com/p/Xyz" },
    { _row: 8, student_name: "Fay", tiktok_handle: "", active: "ja", instagram_handle: "fay.only" },
    { _row: 9, student_name: "Gus", tiktok_handle: "gus", active: "ja", instagram_handle: "" },
    { _row: 10, student_name: "Hal", tiktok_handle: "hal", active: "misschien", instagram_handle: "hal" },
  ];
  const out = lib.parseAccounts(rows);
  assert.deepEqual(out.filter((a) => a.instagramTracked).map((a) => [a.instagram, a.row]), [["anna.gram", 2], ["cas_ig", 5], ["fay.only", 8]]);
  const issue = (row) => out.find((a) => a.row === row).instagramIssue;
  assert.match(issue(3), /eerste rij/);       // on a second TikTok account's row
  assert.match(issue(6), /rij 5/);            // used by two students
  assert.match(issue(7), /post/);             // a link to a post, not a profile
  assert.equal(issue(4), null);               // inactive: ignored silently
  assert.equal(out.find((a) => a.row === 9).instagram, null);
  // A student with only Instagram is not a TikTok problem (and not tracked on TikTok); a row with nothing is.
  const fay = out.find((a) => a.row === 8);
  assert.equal([fay.issue, fay.tracked].join(), ",false");
  assert.equal(lib.parseAccounts([{ _row: 2, student_name: "Zed", tiktok_handle: "", active: "ja" }])[0].issue, "geen handle ingevuld");
  // Students: the Instagram handle comes from the student's first row; a student without one has null.
  const groups = lib.groupAccounts(out);
  assert.equal(groups.get("anna").instagram, "anna.gram");
  assert.equal(groups.get("anna").accounts.length, 2);
  assert.equal(groups.get("gus").instagram, null);
  assert.equal(groups.get("dee").instagram, null);
  assert.equal(groups.get("dee").instagramIssue, "dubbel: Instagram @cas_ig staat ook in rij 5");
  assert.equal(lib.instagramCell({ "Insta ": "x" }), "x");
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
  // Same cases as test_remaining_profile_runs: Friday 23 Oct 08:45, the 08u window already ran.
  // TikTok every 12 hours (08u, 20u), Instagram every 4 hours (ig-00u ... ig-20u).
  const at = ams("2026-10-23T08:45:00+02:00");
  assert.equal(lib.remainingProfileRuns(CFG, at, new Set(["2026-10-23/08u"])), 15);
  assert.equal(lib.remainingProfileRuns(CFG, at, new Set()), 16);
  assert.equal(lib.remainingProfileRuns(CFG, at, new Set(["2026-10-23/08u"]), "instagram"), 46);
  assert.equal(lib.remainingProfileRuns(CFG, at, new Set(["2026-10-23/ig-08u"]), "instagram"), 45);
  // Both platforms: 12 Oct 08:10 (the 08u windows are still open) = 38 TikTok + 112 Instagram runs, as in Python.
  const now = ams("2026-10-12T08:10:00+02:00");
  const b = lib.budget(CFG, [], { tiktok: 4, instagram: 3 }, now);
  assert.deepEqual([b.runsLeft, b.reserved, b.projected], [150, 38 * 4 + 112 * 3, 38 * 4 + 112 * 3]);
  assert.deepEqual(b.byPlatform, { tiktok: { runsLeft: 38, accounts: 4, reserved: 152 }, instagram: { runsLeft: 112, accounts: 3, reserved: 336 } });
  assert.deepEqual(lib.budget(CFG, [], 4, now).byPlatform.instagram, { runsLeft: 112, accounts: 0, reserved: 0 }); // a number = TikTok only
  // Both platforms count toward one cap; each has its own "last run".
  const both = [
    { timestamp: "2026-10-01T05:00:00Z", dry_run: false, actual_records: 45, run_type: "profiles", snapshot_ids: "sd_1" },
    { timestamp: "2026-10-01T09:00:00Z", dry_run: false, actual_records: 20, run_type: "ig_profiles", snapshot_ids: "sd_2" },
    { timestamp: "2026-10-01T09:30:00Z", dry_run: false, actual_records: 3, run_type: "ig_today_check", snapshot_ids: "sd_3" },
  ];
  assert.equal(lib.monthUsage(both, Date.parse("2026-10-02T00:00:00Z")), 68);
  assert.equal(lib.lastProfilesRun(both), Date.parse("2026-10-01T05:00:00Z"));
  assert.equal(lib.lastProfilesRun(both, lib.IG_PROFILE_RUN_TYPES), Date.parse("2026-10-01T09:00:00Z")); // a partial check is no full run
  // Campaign until Friday 30 Oct: windows open that day (20u for both platforms), none on the 31st.
  assert.equal(CFG.campaign.end, "2026-10-30");
  assert.equal(CFG.budget.monthlyCap, 23000);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-30T20:10:00+01:00")), ["2026-10-30/20u", "2026-10-30/ig-20u"]);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-30T22:10:00+01:00")), []);
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

test("openWindows follows Amsterdam time in summer and winter, per platform", () => {
  // TikTok: 08u and 20u. Instagram: ig-00u, 04u, 08u, 12u, 16u, 20u.
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T08:45:00+02:00")), ["2026-10-01/08u", "2026-10-01/ig-08u"]);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T09:05:00+02:00")), []);           // odd hour: between windows
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T10:45:00+02:00")), []);           // a pool window, but in nobody's step
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-25T20:45:00+01:00")), ["2026-10-25/20u", "2026-10-25/ig-20u"]); // winter time
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-26T12:30:00+01:00")), ["2026-10-26/ig-12u"]);  // only Instagram
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T00:05:00+02:00")), ["2026-10-01/ig-00u"]);
  // A platform set to off has no windows.
  const noIg = { ...CFG, schedule: { ...CFG.schedule, windows: { ...CFG.schedule.windows, instagram: [] } } };
  assert.deepEqual(lib.openWindows(noIg, ams("2026-10-01T08:45:00+02:00")), ["2026-10-01/08u"]);
  // Friday 08:45: both 08u profile windows and the weekly refresh are open.
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-02T08:45:00+02:00")), ["2026-10-02/08u", "2026-10-02/ig-08u", "2026-10-02/weekrefresh"]);
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-01T09:45:00+02:00")), []);           // Thursday, no refresh
  assert.deepEqual(lib.openWindows(CFG, ams("2026-09-27T08:00:00+02:00")), []);  // before the campaign
  assert.deepEqual(lib.openWindows(CFG, ams("2026-10-31T08:00:00+01:00")), []);  // after collect_until
});

test("dueWindows skips done windows per platform, stops after max failures, adds the one-time check", () => {
  const at = ams("2026-10-01T20:25:00+02:00");
  assert.deepEqual(lib.dueWindows(CFG, [], at), ["2026-10-01/20u", "2026-10-01/ig-20u"]);
  // The platforms are independent: a TikTok window done says nothing about Instagram's.
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-01/20u", "skipped")], at), ["2026-10-01/ig-20u"]);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-01/ig-20u", "ok")], at), ["2026-10-01/20u"]);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-01/20u", "ok"), log("2026-10-01/ig-20u", "ok")], at), []);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-01/20u", "ok", true)], at), ["2026-10-01/20u", "2026-10-01/ig-20u"]); // dry run
  const fails = Array(CFG.schedule.maxAttemptsPerWindow).fill(log("2026-10-01/20u", "failed"));
  assert.deepEqual(lib.dueWindows(CFG, fails, at), ["2026-10-01/ig-20u"]);
  // The one-time check runs in the last TikTok window of its date, after that window's profiles run.
  const last = lib.platformWindows(CFG, "tiktok").at(-1).name;
  const check = ams(`${CFG.windowCheckDate}T20:45:00+02:00`);
  const eve = `${CFG.windowCheckDate}/${last}`;
  assert.deepEqual(lib.dueWindows(CFG, [log(eve, "ok"), log(`${eve.replace("/", "/ig-")}`, "ok")], check), [`${CFG.windowCheckDate}/window-check`]);
  assert.deepEqual(lib.dueWindows(CFG, [log(eve, "ok"), log(`${eve.replace("/", "/ig-")}`, "ok"), log(`${CFG.windowCheckDate}/window-check`, "ok")], check), []);
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
  // Every window of the pool must be covered, whichever frequency step a platform uses (each step is a
  // subset of the pool): check with a config in which both platforms use all of it ("2h").
  const pool = CFG.schedule.profileRuns;
  const all = { ...CFG, schedule: { ...CFG.schedule, windows: {
    tiktok: pool, instagram: pool.map((w) => ({ ...w, name: `ig-${w.name}` })) } } };
  // Summer time, the day the clocks go back (25 Oct), winter time.
  for (const day of ["2026-10-01", "2026-10-25", "2026-10-26"]) {
    for (const w of pool) {
      for (const name of [w.name, `ig-${w.name}`]) {
        const hits = firings(day).filter((t) => lib.openWindows(all, t).includes(`${day}/${name}`)).length;
        assert.ok(hits >= 3, `${day} ${name}: ${hits} hits`);
      }
    }
  }
  // The same for every choice that can be made on Beheer, worked out the way the Worker does it from the settings tab:
  // each step's windows (TikTok and Instagram) are hit at least 3 times by the hourly crons, in summer and winter time.
  for (const step of lib.FREQUENCY_CHOICES) {
    const chosen = lib.withFrequency(CFG, { tiktok: step, instagram: step });
    for (const day of ["2026-10-01", "2026-10-25", "2026-10-26"]) {
      for (const platform of lib.PLATFORMS) {
        for (const w of lib.platformWindows(chosen, platform)) {
          const hits = firings(day).filter((t) => lib.openWindows(chosen, t).includes(`${day}/${w.name}`)).length;
          assert.ok(hits >= 3, `${step} ${day} ${w.name}: ${hits} hits`);
        }
      }
    }
  }
  // The steps in use are subsets of that pool.
  const names = new Set(pool.map((w) => w.name));
  for (const platform of lib.PLATFORMS) {
    for (const w of lib.platformWindows(CFG, platform)) assert.ok(names.has(w.name.replace(/^ig-/, "")), w.name);
  }
  const r = CFG.schedule.refresh;
  for (const day of ["2026-10-02", "2026-10-30"]) { // first and last Friday of the collection
    const hits = firings(day).filter((t) => lib.openWindows(CFG, t).includes(`${day}/${r.name}`)).length;
    assert.ok(hits >= 4, `${day} ${r.name}: ${hits} hits`);
  }
});

// ---------- pull frequency per platform (settings tab, Beheer) ----------

const FRIDAY_NOON = Date.parse("2026-10-09T12:00:00+02:00");

test("frequency setting: only valid choices count, a typo keeps the start value; windows come from the step", () => {
  assert.deepEqual(lib.FREQUENCY_CHOICES, ["off", "daily", "12h", "6h", "4h", "2h"]);
  const saved = (rows) => lib.frequencySettings(lib.parseSettings(rows), CFG);
  assert.deepEqual(saved([{ key: "frequency_tiktok", value: "6H" }, { key: "frequency_instagram", value: " off " }, { key: "school_hashtags", value: "glu" }]),
    { tiktok: "6h", instagram: "off" });
  assert.deepEqual(saved([{ key: "frequency_tiktok", value: "3h" }, { key: "frequency_instagram", value: "" }]), {});
  assert.deepEqual(saved([{ key: "frequency_tiktok", value: "2h" }, { key: "frequency_tiktok", value: "daily" }]), { tiktok: "daily" });   // the last row wins
  assert.equal(lib.frequencyChoice("weekly", CFG), null);
  assert.equal(lib.frequencyChoice("4h", { ...CFG, frequencySteps: { "12h": ["08u", "20u"] } }), null, "a step the config doesn't define");
  // Every step is a set of hourly windows from the pool, Instagram ones keyed ig-.
  const names = (platform, step) => lib.windowsFor(CFG, platform, step).map((w) => w.name);
  assert.deepEqual(names("tiktok", "12h"), ["08u", "20u"]);
  assert.deepEqual(names("instagram", "daily"), ["ig-16u"]);
  assert.deepEqual(lib.FREQUENCY_CHOICES.map((c) => names("tiktok", c).length), [0, 1, 2, 4, 6, 12]);
  assert.deepEqual(names("tiktok", "off"), []);
  // withFrequency replaces what is given and leaves the rest and the original alone.
  const cfg = lib.withFrequency(CFG, { tiktok: "off" });
  assert.deepEqual(cfg.frequency, { tiktok: "off", instagram: "4h" });
  assert.deepEqual([lib.platformOn(cfg, "tiktok"), lib.platformOn(cfg, "instagram")], [false, true]);
  assert.deepEqual(lib.platformWindows(cfg, "tiktok"), []);
  assert.equal(lib.platformWindows(cfg, "instagram").length, 6);
  assert.deepEqual(CFG.frequency, { tiktok: "12h", instagram: "4h" });
  assert.deepEqual(lib.withFrequency(CFG, {}).frequency, CFG.frequency);
});

test("frequency setting: the budget reservation counts the windows of the chosen step", () => {
  const counts = { tiktok: 60, instagram: 23 };
  const planned = (choice) => lib.budget(lib.withFrequency(CFG, choice), [], counts, FRIDAY_NOON).byPlatform;
  // Friday 12:00: TikTok 12h has the 20u window left today plus 2 a day for the 21 days to 30 Oct; Instagram 4h has 12u, 16u and 20u plus 6 a day.
  assert.deepEqual([planned({}).tiktok.runsLeft, planned({}).instagram.runsLeft], [1 + 21 * 2, 3 + 21 * 6]);
  assert.equal(planned({}).tiktok.reserved, 43 * 60);
  assert.deepEqual([planned({ tiktok: "off" }).tiktok.runsLeft, planned({ tiktok: "off" }).tiktok.reserved], [0, 0]);
  assert.equal(planned({ instagram: "2h" }).instagram.runsLeft, 6 + 21 * 12);   // 12u..22u today
  assert.equal(planned({ tiktok: "daily" }).tiktok.runsLeft, 1 + 21);             // 16u is still to come today
  assert.equal(lib.budget(lib.withFrequency(CFG, { tiktok: "off", instagram: "off" }), [], counts, FRIDAY_NOON).projected, 0);
});

test("frequencyPreview: records per day, the month total with the weekrefresh and finale reserves, against the cap", () => {
  const counts = { tiktok: 60, instagram: 23 };
  const current = { tiktok: "12h", instagram: "4h" };
  const preview = (choice, runLog = [], opts = {}) => lib.frequencyPreview(CFG, lib.budgetBase(runLog, FRIDAY_NOON), counts, FRIDAY_NOON, choice, current, opts);
  const now = preview(current);
  assert.deepEqual(now.platforms.map((p) => [p.platform, p.step, p.runsPerDay, p.accounts, p.perDay]), [["tiktok", "12h", 2, 60, 120], ["instagram", "4h", 6, 23, 138]]);
  assert.equal(now.perDay, 258);
  assert.deepEqual([now.used, now.planned, now.projected], [0, 5547, 5547]);
  // The weekrefresh reserves up to refreshNumOfPosts per TikTok account (a Friday is still to come this month); a finale that
  // hasn't happened reserves its longest possible length.
  assert.equal(now.refresh, CFG.refreshNumOfPosts * 60);
  assert.equal(now.finale, lib.finaleCost(CFG, counts, 0, CFG.finale.maxHours * 3600e3).total);
  assert.deepEqual([now.total, now.cap, now.headroom, now.fits, now.allowed], [5547 + now.refresh + now.finale, 23000, 23000 - now.total, true, true]);
  assert.equal(preview(current, [], { finaleDone: true }).finale, 0);
  // Everything every 2 hours doesn't fit under the cap: 21.414 planned + the reserves.
  const big = preview({ tiktok: "2h", instagram: "2h" });
  assert.deepEqual([big.perDay, big.projected, big.fits, big.allowed], [720 + 276, 21414, false, false]);
  // TikTok off: no TikTok runs, and no weekrefresh reserve either (the refresh is a TikTok pull).
  const off = preview({ tiktok: "off", instagram: "4h" });
  assert.deepEqual([off.platforms[0].perDay, off.platforms[0].planned, off.refresh], [0, 0, 0]);
  assert.equal(off.finale, lib.finaleCost(lib.withFrequency(CFG, { tiktok: "off" }), counts, 0, CFG.finale.maxHours * 3600e3).total);
  // Records already used count: with the month almost full even a small choice no longer fits...
  const full = [{ timestamp: new Date(FRIDAY_NOON).toISOString(), run_type: "profiles", window: "x", actual_records: 22900, dry_run: false, status: "ok" }];
  const small = preview({ tiktok: "daily", instagram: "daily" }, full);
  assert.deepEqual([small.used, small.fits], [22900, false]);
  // ...but it is still allowed because it plans fewer records than the current setting (so a setting can always be lowered).
  assert.equal(small.allowed, true);
  assert.equal(preview({ tiktok: "2h", instagram: "4h" }, full).allowed, false);
  assert.equal(preview(current, full).allowed, true, "keeping what is saved is never refused");
  // Nothing past the campaign: no reserves outside this month.
  const november = lib.frequencyPreview(CFG, lib.budgetBase([], Date.parse("2026-11-05T12:00:00+01:00")), counts, Date.parse("2026-11-05T12:00:00+01:00"), current, current);
  assert.deepEqual([november.projected, november.refresh, november.finale], [0, 0, 0]);
});

test("windows: a platform that is off has no windows, no weekly refresh and no finale runs", () => {
  const ten = Date.parse("2026-10-02T08:40:00+02:00");   // Friday 08:40: weekrefresh window, TikTok 08u and Instagram ig-08u
  assert.deepEqual(lib.openWindows(CFG, ten), ["2026-10-02/08u", "2026-10-02/ig-08u", "2026-10-02/weekrefresh"]);
  assert.deepEqual(lib.openWindows(lib.withFrequency(CFG, { tiktok: "off" }), ten), ["2026-10-02/ig-08u"]);
  assert.deepEqual(lib.openWindows(lib.withFrequency(CFG, { instagram: "off" }), ten), ["2026-10-02/08u", "2026-10-02/weekrefresh"]);
  assert.deepEqual(lib.openWindows(lib.withFrequency(CFG, { tiktok: "off", instagram: "off" }), ten), []);
  const at = Date.parse("2026-10-26T13:05:00Z");   // the first slot of the finale, where both platforms run
  const live = lib.finaleState([FIN], at, 8);
  assert.deepEqual(lib.openWindows(CFG, at, live), ["2026-10-26/finale-1400", "2026-10-26/ig-finale-1400"]);
  assert.deepEqual(lib.openWindows(lib.withFrequency(CFG, { tiktok: "off" }), at, live), ["2026-10-26/ig-finale-1400"]);
  assert.deepEqual(lib.openWindows(lib.withFrequency(CFG, { instagram: "off" }), at, live), ["2026-10-26/finale-1400"]);
  assert.deepEqual(lib.openWindows(lib.withFrequency(CFG, { tiktok: "off", instagram: "off" }), at, live), []);
  // A finale on a Friday morning has the weekly refresh too, but only with TikTok on.
  const fri = lib.finaleState([{ ...FIN, started_at: "2026-10-30T06:00:00Z", deadline: "2026-10-30T09:00:00Z" }], Date.parse("2026-10-30T07:40:00Z"), 8);
  assert.ok(lib.openWindows(CFG, Date.parse("2026-10-30T07:40:00Z"), fri).includes("2026-10-30/weekrefresh"));
  assert.ok(!lib.openWindows(lib.withFrequency(CFG, { tiktok: "off" }), Date.parse("2026-10-30T07:40:00Z"), fri).includes("2026-10-30/weekrefresh"));
});

test("Controleer nu: a platform that is off is left out of the targets and named as skipped", () => {
  const now = ams("2026-10-06T13:00:00+02:00");
  const students = [
    { handle: "a", posts: [], accounts: [{ handle: "a", isPrivate: false }, { handle: "a.ig", isPrivate: false, platform: "instagram" }] },
    { handle: "instagram:d", posts: [], accounts: [{ handle: "d", isPrivate: false, platform: "instagram" }] },
    { handle: "done", posts: [{ created_at: "2026-10-06T07:00:00Z" }], accounts: [{ handle: "done", isPrivate: false }] },
  ];
  const st = lib.todayStatus(CFG, students, [], now);
  const freq = (tiktok, instagram) => ({ tiktok, instagram });
  assert.deepEqual(lib.todayTargets(st), ["a", "instagram:a.ig", "instagram:d"]);                        // no frequency: nothing left out
  assert.deepEqual(lib.todayTargets(st, freq("12h", "4h")), ["a", "instagram:a.ig", "instagram:d"]);
  assert.deepEqual(lib.todayTargets(st, freq("off", "4h")), ["instagram:a.ig", "instagram:d"]);
  assert.deepEqual(lib.todayTargets(st, freq("12h", "off")), ["a"]);
  assert.deepEqual(lib.todayTargets(st, freq("off", "off")), []);
  assert.deepEqual(lib.todaySkipped(st, freq("12h", "4h")), []);
  assert.deepEqual(lib.todaySkipped(st, freq("off", "4h")), ["tiktok"]);
  assert.deepEqual(lib.todaySkipped(st, freq("off", "off")), ["tiktok", "instagram"]);
  // A platform that is off but has nothing to check isn't named: only Instagram accounts are left here.
  const onlyIg = lib.todayStatus(CFG, students.slice(1, 2), [], now);
  assert.deepEqual(lib.todaySkipped(onlyIg, freq("off", "4h")), []);
});

// ---------- hashtags: close to the one searched ----------

test("closeTag: the real cases (#grafischlyceum, #grafischlyceumutecht) are close to #grafischlyceumutrecht; short hashtags and other words are not", () => {
  const school = "grafischlyceumutrecht";
  assert.equal(lib.closeTag(school, "grafischlyceum"), true);        // the start of it (7 Instagram posts in the review)
  assert.equal(lib.closeTag(school, "grafischlyceumutecht"), true);  // a missing letter (29 TikTok posts)
  assert.equal(lib.closeTag(school, "grafischlyceumutrech"), true);
  assert.equal(lib.closeTag(school, "grafischlyceumurtecht"), true, "two neighbouring letters swapped counts as one slip");
  assert.equal(lib.closeTag("grafischlyceum", school), true, "also the other way round (searching the short one)");
  assert.equal(lib.closeTag("fotografie", "fotografi"), true);
  assert.equal(lib.closeTag("school", "schoolproject"), true);
  // Never the same hashtag, and never the short school ones: glu and av would otherwise match half of all hashtags.
  assert.equal(lib.closeTag(school, school), false);
  assert.deepEqual(["gluuwu", "glu1", "gl", "avond", "avontuur", "glutenvrij"].map((t) => lib.closeTag("glu", t)), [false, false, false, false, false, false]);
  assert.deepEqual(["avond", "ave", "a"].map((t) => lib.closeTag("av", t)), [false, false, false]);
  // Other words stay other words: one slip needs 7 letters, two need 12.
  assert.equal(lib.closeTag("viral", "vital"), false);
  assert.equal(lib.closeTag("fotografie", "fotograaf"), false);
  assert.equal(lib.closeTag(school, "grafischlyceumutrechtiscool"), true, "a longer hashtag that starts with it");
  assert.equal(lib.closeTag(school, "grafischeschool"), false);
  assert.equal(lib.closeTag("", "x"), false);
});

test("tagUsage: students who don't use the hashtag get the close ones they used instead (Instagram and TikTok), most used first; users get none", () => {
  const ig = (day, hashtags) => ({ post_id: day + hashtags, handle: "x", created_at: `${day}T10:00:00Z`, hashtags });
  const tt = (day, hashtags) => ({ video_id: day + hashtags, handle: "x", created_at: `${day}T10:00:00Z`, hashtags });
  const students = [
    { id: "uses", posts: [ig("2026-10-08", "grafischlyceumutrecht glu")], tiktokPosts: [] },
    { id: "short", posts: [ig("2026-10-08", "grafischlyceum"), ig("2026-10-09", "grafischlyceum fotografie"), ig("2026-10-09", "grafischlyceumutecht")] },
    { id: "tiktok", posts: [], tiktokPosts: [tt("2026-10-08", "grafischlyceumutecht fyp"), tt("2026-10-09", "grafischlyceumutecht")], note: "geen Instagram-handle" },
    { id: "both", posts: [ig("2026-10-08", "grafischlyceum")], tiktokPosts: [tt("2026-10-09", "grafischlyceum")] },
    { id: "before", posts: [], tiktokPosts: [tt("2026-10-01", "grafischlyceumutecht")] },   // before the Instagram start: no hint
    { id: "other", posts: [ig("2026-10-08", "glu fotografie")], tiktokPosts: [tt("2026-10-08", "viral")] },
    { id: "none", posts: [] },
  ];
  const u = lib.tagUsage(students, "grafischlyceumutrecht", "2026-10-07");
  assert.deepEqual(u.uses.map((x) => x.id), ["uses"]);
  const near = (id) => u.notUse.find((x) => x.id === id).near;
  assert.deepEqual(near("short"), [{ tag: "grafischlyceum", instagram: 2, tiktok: 0, total: 2 }, { tag: "grafischlyceumutecht", instagram: 1, tiktok: 0, total: 1 }]);
  assert.deepEqual(near("tiktok"), [{ tag: "grafischlyceumutecht", instagram: 0, tiktok: 2, total: 2 }]);
  assert.deepEqual(near("both"), [{ tag: "grafischlyceum", instagram: 1, tiktok: 1, total: 2 }]);
  assert.deepEqual([near("before"), near("other"), near("none")], [[], [], []]);
  // TikTok never makes a student "use" the hashtag: the usage numbers stay Instagram.
  assert.equal(u.notUse.find((x) => x.id === "tiktok").total, 0);
  // Searching a short school hashtag finds no relatives at all.
  assert.ok(lib.tagUsage(students, "glu", "2026-10-07").notUse.every((x) => x.near.length === 0));
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

test("finale windows replace the normal ones while live: Instagram every slot, TikTok only at the start and the last run; keys match the collector", () => {
  const at = (hhmm) => Date.parse(`2026-10-26T${hhmm}:00Z`);
  const live = lib.finaleState([FIN], at("14:05"), 8);   // 13:00-15:00 UTC = 14:00-16:00 Amsterdam (winter time)
  assert.equal(lib.finaleWindowKey(Date.parse("2026-10-26T15:29:00Z"), 15), "2026-10-26/finale-1615");
  // Middle slot (15:05 local): Instagram only.
  assert.deepEqual(lib.openWindows(CFG, at("14:05"), live), ["2026-10-26/ig-finale-1500"]);
  // First slot (14:00 local) and last slot (15:45 local): both platforms.
  assert.deepEqual(lib.openWindows(CFG, at("13:05"), live), ["2026-10-26/finale-1400", "2026-10-26/ig-finale-1400"]);
  assert.deepEqual(lib.openWindows(CFG, at("14:50"), live), ["2026-10-26/finale-1545", "2026-10-26/ig-finale-1545"]);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-26/ig-finale-1500", "ok")], at("14:05"), live), []);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-26/finale-1400", "ok")], at("13:05"), live), ["2026-10-26/ig-finale-1400"]);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-26/finale-1400", "ok"), log("2026-10-26/ig-finale-1400", "ok")], at("13:05"), live), []);
  assert.deepEqual(lib.dueWindows(CFG, [log("2026-10-26/ig-finale-1445", "ok")], at("14:05"), live), ["2026-10-26/ig-finale-1500"]);
  assert.equal(lib.amsMs("2026-10-26", "16:00"), Date.parse("2026-10-26T15:00:00Z"));
  assert.equal(lib.amsMs("2026-10-01", "16:00"), Date.parse("2026-10-01T14:00:00Z"));
  assert.equal(lib.finaleRuns(0, 2 * 3600e3, 15), 8);
});

test("finaleSlots / finaleTiktokSlot: same slots as finale_tiktok_slot in the collector", () => {
  const at = (hhmm) => Date.parse(`2026-10-26T${hhmm}:00Z`);
  const f = (start, end) => ({ start: at(start), end: at(end) });
  const tiktok = (finale, times) => times.map((t) => lib.finaleTiktokSlot(finale, at(t), 15));
  // 13:00-15:00: first slot 13:00-13:14, last slot 14:45-14:59.
  assert.deepEqual(tiktok(f("13:00", "15:00"), ["13:00", "13:14", "13:15", "13:45", "14:30", "14:44", "14:45", "14:59"]), [true, true, false, false, false, false, true, true]);
  assert.equal(lib.finaleSlots(at("13:00"), at("15:00"), 15).count, 8);
  // Started mid-slot: that slot is the start run. A deadline on a slot boundary ends with the slot before it.
  assert.deepEqual(tiktok(f("13:07", "15:00"), ["13:07", "13:14", "13:15"]), [true, true, false]);
  assert.deepEqual(tiktok(f("13:00", "14:45"), ["14:15", "14:30", "14:44"]), [false, true, true]);
  assert.equal(lib.finaleSlots(at("13:00"), at("14:45"), 15).count, 7);
  // Shorter than a slot: one slot, one run for each platform.
  assert.deepEqual(lib.finaleSlots(at("13:00"), at("13:10"), 15), { first: lib.finaleSlots(at("13:00"), at("13:10"), 15).first, last: lib.finaleSlots(at("13:00"), at("13:10"), 15).first, count: 1 });
  // A deadline moved later moves the last run with it.
  assert.deepEqual(tiktok(f("13:00", "15:30"), ["14:50", "15:20"]), [false, true]);
});

test("finaleCost: Instagram every slot, TikTok twice (start and last run), nothing for a platform that is off", () => {
  const at = (hhmm) => Date.parse(`2026-10-26T${hhmm}:00Z`);
  const counts = { tiktok: 60, instagram: 23 };
  // Two hours = 8 slots.
  assert.deepEqual(lib.finaleCost(CFG, counts, at("13:00"), at("15:00")), { tiktokRuns: 2, instagramRuns: 8, tiktok: 120, instagram: 184, total: 304 });
  // The longest finale (8 hours = 32 slots): 32 × 23 + 2 × 60.
  assert.deepEqual(lib.finaleCost(CFG, counts, 0, CFG.finale.maxHours * 3600e3), { tiktokRuns: 2, instagramRuns: 32, tiktok: 120, instagram: 736, total: 856 });
  // Within one slot there is one run, not two. A running finale has done its start run: only the last one is left.
  assert.deepEqual(lib.finaleCost(CFG, counts, at("13:00"), at("13:10")), { tiktokRuns: 1, instagramRuns: 1, tiktok: 60, instagram: 23, total: 83 });
  assert.deepEqual(lib.finaleCost(CFG, counts, at("14:00"), at("15:00"), { started: true }), { tiktokRuns: 1, instagramRuns: 4, tiktok: 60, instagram: 92, total: 152 });
  // A platform that is off costs nothing.
  assert.deepEqual(lib.finaleCost(lib.withFrequency(CFG, { tiktok: "off" }), counts, at("13:00"), at("15:00")), { tiktokRuns: 0, instagramRuns: 8, tiktok: 0, instagram: 184, total: 184 });
  assert.equal(lib.finaleCost(lib.withFrequency(CFG, { instagram: "off" }), counts, at("13:00"), at("15:00")).total, 120);
  assert.equal(lib.finaleCost(lib.withFrequency(CFG, { tiktok: "off", instagram: "off" }), counts, at("13:00"), at("15:00")).total, 0);
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

test("lastTodayCheck: from the activity log (dispatch) or run_log (today_check, ig_today_check)", () => {
  assert.equal(lib.lastTodayCheck([{ run_type: "ig_today_check", timestamp: "2026-10-06T10:10:00Z", dry_run: false }], []), Date.parse("2026-10-06T10:10:00Z"));
  const runLog = [{ run_type: "today_check", timestamp: "2026-10-06T10:00:00Z", dry_run: false },
    { run_type: "profiles", timestamp: "2026-10-06T11:00:00Z", dry_run: false },
    { run_type: "today_check", timestamp: "2026-10-06T11:30:00Z", dry_run: true }];
  assert.equal(lib.lastTodayCheck(runLog, []), Date.parse("2026-10-06T10:00:00Z"));
  assert.equal(lib.lastTodayCheck(runLog, [{ action: lib.TODAY_CHECK_ACTION, timestamp: "2026-10-06T10:20:00Z" }]),
    Date.parse("2026-10-06T10:20:00Z"));
  // A check never counts as a full profiles run (no 30-minute "Nu verversen" cooldown, no 60-minute skip).
  assert.equal(lib.lastProfilesRun([{ run_type: "today_check", timestamp: "2026-10-06T10:00:00Z", snapshot_ids: "sd" }]), null);
});

test("rankInstagram: places on followers gained since the baseline; equal gains share a place; no gain, no place", () => {
  const places = lib.rankInstagram([
    { key: "a", gained: 7, followers: 107 }, { key: "b", gained: 12, followers: 132 }, { key: "c", gained: 7, followers: 500 },
    { key: "d", gained: 0, followers: 90 }, { key: "e", gained: null, followers: 40 }, { key: "f", gained: -2, followers: 10 },
  ]);
  // b first; a and c are level on +7 (place 2 for both); d on 0 is place 4; a loss comes after; no baseline yet: no place.
  assert.deepEqual([...places], [["b", 1], ["c", 2], ["a", 2], ["d", 4], ["f", 5]]);
  assert.equal(places.has("e"), false);
  assert.deepEqual([...lib.rankInstagram([])], []);
  // The same gain with the same followers: stable, by key.
  assert.deepEqual([...lib.rankInstagram([{ key: "y", gained: 1, followers: 5 }, { key: "x", gained: 1, followers: 5 }])], [["x", 1], ["y", 1]]);
  // An account whose baseline is more than 90 minutes after the first one was added later.
  assert.equal(lib.IG_LATE_MS, 90 * 60 * 1000);
});

test("parseOutliers: Instagram handles use Instagram's own rules", () => {
  const rows = [{ handle: "@Big.One", buiten_schaal: "ja" }, { handle: "https://www.instagram.com/Other_Acc/?igsh=x", buiten_schaal: "ja" }, { handle: "no.way", buiten_schaal: "nee" }];
  assert.deepEqual([...lib.parseOutliers(rows, lib.normalizeInstagramHandle)], ["big.one", "other_acc"]);
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

// ---------- students with two accounts ----------

test("parseAccounts/groupAccounts: a second account joins its student via main_account", () => {
  const rows = [
    { _row: 2, student_name: "Anna", tiktok_handle: "@anna", active: "ja", main_account: "" },
    { _row: 3, student_name: "Anna", tiktok_handle: "anna.ads", active: "ja", main_account: "@Anna" },
    { _row: 4, student_name: "Bram", tiktok_handle: "bram", active: "nee", main_account: "" },
    { _row: 5, student_name: "Bram", tiktok_handle: "bram2", active: "ja", main_account: "bram" },     // main inactive
    { _row: 6, student_name: "Cas", tiktok_handle: "cas3", active: "ja", main_account: "anna.ads" },   // chain
  ];
  const acc = lib.parseAccounts(rows);
  assert.deepEqual(acc.filter((a) => a.tracked).map((a) => [a.handle, a.group]),
    [["anna", "anna"], ["anna.ads", "anna"], ["bram2", "bram2"], ["cas3", "cas3"]]);
  assert.match(acc.find((a) => a.handle === "bram2").groupIssue, /niet actief/);
  assert.ok(acc.find((a) => a.handle === "cas3").groupIssue);
  const groups = lib.groupAccounts(acc);
  assert.deepEqual([...groups.values()].map((g) => [g.key, g.name, g.accounts.map((a) => a.handle)]),
    [["anna", "Anna", ["anna", "anna.ads"]], ["bram2", "Bram", ["bram2"]], ["cas3", "Cas", ["cas3"]]]);
});

test("mergeSeries adds accounts up with each one's latest value (a partial check doesn't dip)", () => {
  const a = [{ t: 1, views: 100, followers: 10, posts: 1, likes: 5 }, { t: 3, views: 150, followers: 11, posts: 1, likes: 6 },
    { t: 4, views: 160, followers: 11, posts: 1, likes: 6 }];
  const b = [{ t: 1, views: 1000, followers: null, posts: 2, likes: 50 }, { t: 3, views: 1200, followers: null, posts: 3, likes: 60 }];
  // t=4 is a "Controleer nu" run that only fetched a: b keeps its value of t=3.
  assert.deepEqual(lib.mergeSeries([a, b]).map((p) => [p.t, p.views, p.followers, p.posts]),
    [[1, 1100, 10, 3], [3, 1350, 11, 4], [4, 1360, 11, 4]]);
  assert.deepEqual(lib.mergeSeries([a, []]), a);
});

test("two accounts: a post on either counts for the streak, Vandaag and Controleer nu", () => {
  const p = (id, handle, iso) => ({ video_id: id, handle, created_at: iso, views: 10 });
  const posts = [p("1", "anna", "2026-10-05T10:00:00Z"), p("2", "anna.ads", "2026-10-06T10:00:00Z"), p("3", "anna", "2026-10-07T10:00:00Z")];
  const now = ams("2026-10-07T15:00:00+02:00");
  const both = lib.studentStats(posts, CFG, now);
  assert.equal(both.streak, 3);                          // Mon (anna), Tue (anna.ads), Wed (anna)
  assert.equal(lib.studentStats(posts.filter((x) => x.handle === "anna"), CFG, now).streak, 1); // Tue missed on its own
  const st = lib.todayStatus(CFG, [
    { handle: "anna", posts, accounts: [{ handle: "anna" }, { handle: "anna.ads" }] },
    { handle: "bo", posts: [], accounts: [{ handle: "bo" }, { handle: "bo.priv", isPrivate: true }] },
    { handle: "cy", posts: [], accounts: [{ handle: "cy", isPrivate: true }] },
  ], [], now);
  assert.deepEqual(st.rows.map((r) => [r.handle, r.done, r.private]), [["anna", true, false], ["bo", false, false], ["cy", false, true]]);
  assert.deepEqual(lib.todayTargets(st), ["bo"]);         // bo's private account and cy can't be checked
});

test("groupAccounts: a student with only Instagram is a group of its own, keyed instagram:<handle>", () => {
  const out = lib.parseAccounts([
    { _row: 2, student_name: "Anna", tiktok_handle: "anna", active: "ja", instagram_handle: "anna.ig" },
    { _row: 3, student_name: "Fay", tiktok_handle: "", active: "ja", instagram_handle: "@Fay.Only" },
    { _row: 4, student_name: "Gus", tiktok_handle: "", active: "nee", instagram_handle: "gus.ig" },   // inactive: no group
    { _row: 5, student_name: "Hal", tiktok_handle: "", active: "ja", instagram_handle: "" },          // nothing to follow
  ]);
  const groups = lib.groupAccounts(out);
  assert.deepEqual([...groups.keys()], ["anna", "instagram:fay.only"]);
  const fay = groups.get("instagram:fay.only");
  assert.deepEqual([fay.name, fay.accounts.length, fay.instagram, fay.instagramRow, fay.instagramIssue], ["Fay", 0, "fay.only", 3, null]);
  assert.equal(lib.instagramKey("fay.only"), "instagram:fay.only");
});

test("instagramPosts marks ig_posts rows as Instagram posts and skips rows without an id", () => {
  const rows = lib.instagramPosts([{ post_id: "17", handle: "a", created_at: "2026-10-07T10:00:00Z" }, { post_id: " ", handle: "a" }]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].platform, rows[0].video_id, rows[0].handle], ["instagram", "17", "a"]);
  assert.equal(lib.isInstagramPost(rows[0]), true);
  assert.equal(lib.isInstagramPost({ video_id: "1" }), false);
});

test("studentStats: a post on either platform makes the day; views and likes stay TikTok only", () => {
  const tt = (id, iso, views) => ({ video_id: id, handle: "a", created_at: iso, views, likes: 10, comments: 1, shares: 0, hashtags: "glu" });
  const ig = (id, iso) => ({ post_id: id, handle: "a.ig", created_at: iso, platform: "instagram", hashtags: "fotografie glu" });
  const posts = [
    tt("1", "2026-09-28T08:00:00Z", 100),
    ig("i1", "2026-09-29T08:00:00Z"),           // Tuesday: only Instagram
    tt("2", "2026-09-30T08:00:00Z", 300),
    ig("i2", "2026-09-30T09:00:00Z"),           // Wednesday: both platforms
    ig("i3", "2026-10-01T08:00:00Z"),
  ];
  const now = ams("2026-10-02T12:00:00+02:00");
  const both = lib.studentStats(posts, CFG, now);
  const tiktokOnly = lib.studentStats(posts.filter((p) => !lib.isInstagramPost(p)), CFG, now);
  assert.deepEqual([both.posts, both.tiktokPosts, both.instagramPosts], [5, 2, 3]);
  assert.deepEqual(both.byDay.get("2026-09-30"), { tiktok: 1, instagram: 1 });
  assert.deepEqual(both.byDay.get("2026-09-29"), { tiktok: 0, instagram: 1 });
  // TikTok alone misses 29 Sep and 1 Oct; with Instagram nothing is missed and the streak runs from 28 Sep.
  assert.deepEqual(tiktokOnly.missedList, ["2026-09-29", "2026-10-01"]);
  assert.deepEqual(both.missedList, []);
  assert.deepEqual([both.streak, both.longest, both.daysPosted], [4, 4, 4]);
  // Numbers that need TikTok data ignore Instagram posts.
  assert.deepEqual([both.views, both.likes, both.avgViews, both.medianViews], [400, 20, 200, 200]);
  assert.equal(both.best.id, "2");
  assert.equal(both.engagement, (20 + 2) / 400);
  // Hashtags of both platforms; the last post and its platform; "geen post" counts from the last post on either.
  assert.deepEqual(both.tags.map(([t]) => t), ["glu", "fotografie"]);
  assert.deepEqual([both.lastDay, both.lastPlatform], ["2026-10-01", "instagram"]);
  assert.equal(both.quietDays, 1);
  assert.equal(tiktokOnly.lastPlatform, "tiktok");
  // A dagopdracht counts posts on any platform.
  const task = lib.studentStats(posts, CFG, now, [{ date: "2026-09-30", min: 2, label: "" }, { date: "2026-10-01", min: 2, label: "" }]);
  assert.deepEqual(task.tasks.map((t) => [t.date, t.count, t.status]), [["2026-09-30", 2, "reached"], ["2026-10-01", 1, "missed"]]);
});

test("studentStats: days before options.from are free (a student with only Instagram can't be judged before its start)", () => {
  const ig = (id, iso) => ({ post_id: id, handle: "a.ig", created_at: iso, platform: "instagram" });
  const posts = [ig("i1", "2026-10-01T08:00:00Z"), ig("i2", "2026-10-02T08:00:00Z")];
  const now = ams("2026-10-06T12:00:00+02:00");
  const plain = lib.studentStats(posts, CFG, now);
  const from = lib.studentStats(posts, CFG, now, [], { from: "2026-10-01" });
  assert.deepEqual(plain.missedList, ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-05"]);
  assert.deepEqual(from.missedList, ["2026-10-05"]); // Monday 5 Oct is a real miss; 28-30 Sep were never measured
  assert.deepEqual([from.isOff("2026-09-30"), from.isOff("2026-10-01"), from.isOff("2026-10-05")], [true, false, false]);
  assert.equal(from.offName("2026-09-30"), "nog niet gevolgd");
  assert.equal(from.offName("2026-10-03"), "weekend");
  assert.equal(from.offName("2026-10-05"), null);
  assert.equal(from.missedDays, 1);
  assert.equal(from.quietDays, 2); // 5 and 6 Oct (3 and 4 Oct are weekend)
  // Before anything was measured: no "geen post" days at all.
  assert.equal(lib.studentStats([], CFG, ams("2026-09-29T12:00:00+02:00"), [], { from: "2026-10-01" }).quietDays, 0);
});

test("studentStats: options.unknownFrom - a day without a post can't be judged when the student's Instagram is invisible", () => {
  const tt = (id, iso) => ({ video_id: id, handle: "a", created_at: iso, views: 10 });
  const posts = [tt("1", "2026-09-29T08:00:00Z"), tt("2", "2026-10-01T08:00:00Z")];
  const now = ams("2026-10-06T12:00:00+02:00");
  const tasks = [{ date: "2026-09-29", min: 2, label: "" }, { date: "2026-10-01", min: 2, label: "" }, { date: "2026-10-02", min: 1, label: "" }];
  const plain = lib.studentStats(posts, CFG, now, tasks);
  const unk = lib.studentStats(posts, CFG, now, tasks, { unknownFrom: "2026-10-01" });
  // Without the option nothing changes: 28 and 30 Sep, 2 Oct and 5 Oct are missed (3-4 Oct is a weekend).
  assert.deepEqual(plain.missedList, ["2026-09-28", "2026-09-30", "2026-10-02", "2026-10-05"]);
  assert.deepEqual([plain.unknownDays, plain.unknownList, plain.isUnknown("2026-10-02")], [0, [], false]);
  assert.deepEqual(lib.studentStats(posts, CFG, now, tasks, { unknownFrom: null }).missedList, plain.missedList);
  // From 1 Oct a day without a post is "niet te controleren": not missed, and the days before it are judged as usual.
  assert.deepEqual(unk.missedList, ["2026-09-28", "2026-09-30"]);
  assert.deepEqual(unk.unknownList, ["2026-10-02", "2026-10-05"]);
  assert.deepEqual([unk.missedDays, unk.unknownDays], [2, 2]);
  // The weekend stays "vrij" (free wins), a day with a post and today are never unknown, nor is a day before the option.
  assert.deepEqual(["2026-10-03", "2026-10-01", "2026-10-06", "2026-09-30"].map((d) => unk.isUnknown(d)), [false, false, false, false]);
  assert.deepEqual(["2026-10-02", "2026-10-05"].map((d) => unk.isUnknown(d)), [true, true]);
  // Unknown days neither break the streak nor end the longest run: 1 Oct counts, 2 Oct and 5 Oct are skipped, 30 Sep (judged) breaks it.
  assert.deepEqual([plain.streak, unk.streak, unk.longest], [0, 1, 1]);
  // A dagopdracht that isn't reached is "unknown" from that day on, "missed" before it.
  assert.deepEqual(unk.tasks.map((t) => [t.date, t.count, t.status]), [["2026-09-29", 1, "missed"], ["2026-10-01", 1, "unknown"], ["2026-10-02", 0, "unknown"]]);
  assert.equal(unk.tasksMissed, 1);
  assert.deepEqual(plain.tasks.map((t) => t.status), ["missed", "missed", "missed"]);
  // "Dagen geen post" is not touched here: the pages leave that warning out for a student without a handle.
  assert.equal(unk.quietDays, plain.quietDays);
});

test("todayGroups: no handle and nothing on TikTok today is 'niet te controleren', not 'nog niet gepost'", () => {
  const now = ams("2026-10-06T13:00:00+02:00");
  const today = { created_at: "2026-10-06T07:00:00Z" };
  const acc = (private_ = false) => [{ handle: "x", isPrivate: private_ }];
  const students = [
    { handle: "done", posts: [today], accounts: acc() },
    { handle: "todo", posts: [], accounts: acc() },
    { handle: "nohandle", posts: [], noHandle: true, accounts: acc() },
    { handle: "nohandle-done", posts: [today], noHandle: true, accounts: acc() },
    { handle: "priv", posts: [], accounts: acc(true) },
    { handle: "nohandle-priv", posts: [], noHandle: true, accounts: acc(true) },
  ];
  const g = lib.todayGroups(lib.todayStatus(CFG, students, [], now));
  const names = (rows) => rows.map((r) => r.handle);
  assert.deepEqual(names(g.todo), ["todo"]);
  assert.deepEqual(names(g.done), ["done", "nohandle-done"]);      // posted on TikTok today: fine, handle or not
  assert.deepEqual(names(g.unverifiable), ["nohandle", "nohandle-priv"]);   // the handle is what fixes both
  assert.deepEqual(names(g.priv), ["priv"]);
  // Every student is in exactly one list.
  assert.equal(g.todo.length + g.done.length + g.unverifiable.length + g.priv.length, students.length);
  // "Controleer nu" still fetches the TikTok account of a student without a handle (it is a public account).
  assert.deepEqual(lib.todayTargets(lib.todayStatus(CFG, students, [], now)), ["x", "x"]);
});

test("todayStatus: an Instagram post counts; Controleer nu fetches the public accounts of both platforms; private only when all accounts are", () => {
  const now = ams("2026-10-06T13:00:00+02:00");
  const igPost = { platform: "instagram", created_at: "2026-10-06T07:00:00Z" };
  const students = [
    { handle: "a", posts: [igPost], accounts: [{ handle: "a", isPrivate: false }, { handle: "a.ig", isPrivate: false, platform: "instagram" }] },
    { handle: "b", posts: [], accounts: [{ handle: "b", isPrivate: false }, { handle: "b.ig", isPrivate: false, platform: "instagram" }] },
    { handle: "c", posts: [], accounts: [{ handle: "c", isPrivate: true }, { handle: "c.ig", isPrivate: false, platform: "instagram" }] },
    { handle: "instagram:d", posts: [], accounts: [{ handle: "d", isPrivate: false, platform: "instagram" }] },
    { handle: "e", posts: [], accounts: [{ handle: "e", isPrivate: true }, { handle: "e.ig", isPrivate: true, platform: "instagram" }] },
  ];
  const st = lib.todayStatus(CFG, students, [], now);
  assert.deepEqual(st.rows.map((r) => [r.handle, r.done, r.private, r.checkable]),
    [["a", true, false, ["a", "instagram:a.ig"]], ["b", false, false, ["b", "instagram:b.ig"]], ["c", false, false, ["instagram:c.ig"]],
      ["instagram:d", false, false, ["instagram:d"]], ["e", false, true, []]]);
  // Only students who are not done (a posted on Instagram) and not private (e): TikTok handles bare, Instagram with the platform in front.
  const targets = lib.todayTargets(st);
  assert.deepEqual(targets, ["b", "instagram:b.ig", "instagram:c.ig", "instagram:d"]);
  assert.deepEqual(lib.targetSplit(targets), { tiktok: 1, instagram: 3 });
  assert.deepEqual(lib.targetSplit([]), { tiktok: 0, instagram: 0 });
});

test("normalizeTag / parseTagList: one hashtag in any form; a list typed by a teacher", () => {
  assert.equal(lib.normalizeTag("#GLU "), "glu");
  assert.equal(lib.normalizeTag("##av"), "av");
  assert.equal(lib.normalizeTag("grafisch_lyceum2"), "grafisch_lyceum2");
  assert.equal(lib.normalizeTag("fotografie"), "fotografie");
  for (const bad of ["", "#", "twee woorden", "a-b", "glu!", "x".repeat(61), null]) assert.equal(lib.normalizeTag(bad), null, String(bad));
  assert.deepEqual(lib.parseTagList("glu, #AV  grafischlyceumutrecht;av"), { tags: ["glu", "av", "grafischlyceumutrecht"], invalid: [] });
  assert.deepEqual(lib.parseTagList("glu nieuw-tag #ok"), { tags: ["glu", "ok"], invalid: ["nieuw-tag"] });
  assert.deepEqual(lib.parseTagList(["#a", "b"]), { tags: ["a", "b"], invalid: [] });
  assert.deepEqual(lib.parseTagList(""), { tags: [], invalid: [] });
});

test("schoolHashtags: the list saved on Beheer, or the start value from config.yaml", () => {
  const start = ["glu", "av"];
  assert.deepEqual(lib.schoolHashtags(lib.parseSettings([]), start), start);
  assert.deepEqual(lib.schoolHashtags(lib.parseSettings([{ key: "other", value: "x", _row: 2 }]), start), start);
  const saved = lib.parseSettings([{ key: "school_hashtags", value: "glu #Nieuw", _row: 2 }, { key: "", value: "x" }]);
  assert.deepEqual(lib.schoolHashtags(saved, start), ["glu", "nieuw"]);
  assert.equal(saved.get("school_hashtags").row, 2);
  // A list that was cleared on purpose stays empty (no fallback); the last row of a key wins.
  assert.deepEqual(lib.schoolHashtags(lib.parseSettings([{ key: "school_hashtags", value: "" }]), start), []);
  assert.deepEqual(lib.schoolHashtags(lib.parseSettings([{ key: "school_hashtags", value: "a" }, { key: "school_hashtags", value: "b" }]), start), ["b"]);
  assert.deepEqual(lib.schoolHashtags(lib.parseSettings([]), undefined), []);
});

test("tagUsage: who uses a hashtag (x van y posts, last used, newest post), who does not; the Instagram start day", () => {
  const post = (iso, hashtags) => ({ created_at: iso, hashtags });
  const students = [
    { id: "anna", posts: [post("2026-10-08T09:00:00Z", "fotografie"), post("2026-10-07T09:00:00Z", "glu fotografie"), post("2026-10-09T09:00:00Z", "glu")] },
    { id: "bram", posts: [post("2026-10-08T09:00:00Z", "av"), post("2026-10-09T09:00:00Z", "glu av")] },
    { id: "cas", posts: [post("2026-10-08T09:00:00Z", "fotografie")] },
    { id: "dee", posts: [], note: "privé" },
    { id: "eli", posts: [post("2026-10-06T21:30:00Z", "glu")] },              // 23:30 on 6 Oct Amsterdam: before the start day
  ];
  const usage = lib.tagUsage(students, "glu", "2026-10-07");
  assert.deepEqual(usage.uses.map((u) => [u.id, u.used, u.total, u.onLast, new Date(u.last).toISOString()]),
    [["anna", 2, 3, true, "2026-10-09T09:00:00.000Z"], ["bram", 1, 2, true, "2026-10-09T09:00:00.000Z"]]);
  assert.deepEqual(usage.notUse.map((n) => [n.id, n.total, n.note]), [["cas", 1, null], ["dee", 0, "privé"], ["eli", 0, null]]);
  // The newest post decides "ontbreekt op laatste post", not the order of the rows.
  const av = lib.tagUsage(students, "av", "2026-10-07");
  assert.deepEqual(av.uses.map((u) => [u.id, u.used, u.total, u.onLast]), [["bram", 2, 2, true]]);
  const fotografie = lib.tagUsage(students, "fotografie", "2026-10-07");
  assert.deepEqual(fotografie.uses.map((u) => [u.id, u.used, u.total, u.onLast]), [["anna", 2, 3, false], ["cas", 1, 1, true]]);
  assert.equal(fotografie.uses[0].lastPost.created_at, "2026-10-08T09:00:00Z");
  // The filter: uses it but not on the newest post, or has posted without ever using it.
  const missing = lib.missingOnLast(fotografie);
  assert.deepEqual(missing.uses.map((u) => u.id), ["anna"]);
  assert.deepEqual(missing.notUse.map((n) => n.id), ["bram"]);
  // Without a start day every post counts; a post without a date never does.
  assert.equal(lib.tagUsage(students, "glu", null).uses.find((u) => u.id === "eli").used, 1);
  assert.equal(lib.tagUsage([{ id: "x", posts: [post("", "glu")] }], "glu", null).uses.length, 0);
});

test("tagTable: most used hashtags over all students (Instagram, from the start day)", () => {
  const post = (iso, hashtags) => ({ created_at: iso, hashtags });
  const rows = lib.tagTable([
    { id: "a", posts: [post("2026-10-07T09:00:00Z", "glu fotografie GLU"), post("2026-10-08T09:00:00Z", "glu")] },
    { id: "b", posts: [post("2026-10-09T09:00:00Z", "glu av"), post("2026-10-01T09:00:00Z", "oud")] },
    { id: "c", posts: [] },
  ], "2026-10-07");
  const by = Object.fromEntries(rows.map((r) => [r.tag, r]));
  assert.deepEqual(Object.keys(by).sort(), ["av", "fotografie", "glu"]);               // "oud" is from before the start day
  assert.deepEqual([by.glu.posts, by.glu.students, new Date(by.glu.last).toISOString()], [3, 2, "2026-10-09T09:00:00.000Z"]);
  assert.deepEqual([by.fotografie.posts, by.fotografie.students, by.av.posts], [1, 1, 1]);   // a hashtag twice in one post counts once
});
