"""Unit tests with synthetic data only (no real scraped data in the repo). Run: python -m unittest"""

import datetime as dt
import json
import pathlib
import re
import unittest

from collector import config, model
from collector.config import UTC
from collector.handles import normalize_handle, parse_accounts
from collector.runner import Collector

CFG = config.load()
CAMP = CFG.campaign
AMS = CFG.tz


def local(y, m, d, hh, mm):
    return dt.datetime(y, m, d, hh, mm, tzinfo=AMS)


class HandleTests(unittest.TestCase):
    def test_variants(self):
        for raw in ["chessifity", "@chessifity", " @Chessifity ", "CHESS IFITY", "https://www.tiktok.com/@chessifity",
                    "tiktok.com/@Chessifity?lang=nl", "https://www.tiktok.com/@chessifity/video/123"]:
            self.assertEqual(normalize_handle(raw)[0], "chessifity", raw)

    def test_shared_cases(self):
        """Same cases as the private site's JavaScript port (private/test)."""
        cases = json.loads((pathlib.Path(__file__).parent / "handle_cases.json").read_text(encoding="utf-8"))
        for case in cases:
            self.assertEqual(normalize_handle(case["raw"])[0], case["handle"], case["raw"])

    def test_invalid(self):
        for raw in ["", "https://vm.tiktok.com/ZMabc/", "naam met €", "a" * 25, "ends.with.dot."]:
            handle, reason = normalize_handle(raw)
            self.assertIsNone(handle, raw)
            self.assertTrue(reason)

    def test_accounts_flags_instead_of_failing(self):
        rows = [
            {"student_name": "A", "tiktok_handle": "@one", "active": "ja"},
            {"student_name": "B", "tiktok_handle": "https://vm.tiktok.com/x", "active": "ja"},
            {"student_name": "C", "tiktok_handle": "ONE", "active": ""},
            {"student_name": "D", "tiktok_handle": "two", "active": "nee"},
            {"student_name": "E", "tiktok_handle": "three", "active": "misschien"},
            {"student_name": "F", "tiktok_handle": "four", "active": True},
        ]
        handles, issues = parse_accounts(rows)
        self.assertEqual(handles, ["one", "four"])
        self.assertEqual(len(issues), 3)
        self.assertFalse(any(name in " ".join(issues) for name in ["'A'", "'B'", "'C'", "'E'"]))


    def test_account_groups(self):
        """A student's second account points at their first one (main_account); the sites add them up."""
        from collector.handles import account_groups
        rows = [
            {"student_name": "Anna", "tiktok_handle": "@anna", "active": "ja", "main_account": ""},
            {"student_name": "Anna", "tiktok_handle": "anna.ads", "active": "ja", "main_account": "@Anna"},
            {"student_name": "Bram", "tiktok_handle": "bram", "active": "nee", "main_account": ""},
            {"student_name": "Bram", "tiktok_handle": "bram2", "active": "ja", "main_account": "bram"},   # main inactive
            {"student_name": "Cas", "tiktok_handle": "cas3", "active": "ja", "main_account": "anna.ads"},  # chain
            {"student_name": "Dee", "tiktok_handle": "dee", "active": "ja", "main_account": "dee"},      # itself
        ]
        groups, issues = account_groups(rows)
        self.assertEqual(groups, {"anna": "anna", "anna.ads": "anna", "bram2": "bram2", "cas3": "cas3", "dee": "dee"})
        self.assertEqual(len(issues), 2)
        self.assertFalse(any(n in " ".join(issues) for n in ["Anna", "Bram", "Cas"]))  # no names in logs


class SheetTests(unittest.TestCase):
    def test_column_letters(self):
        from collector.sheets import _col
        self.assertEqual([_col(1), _col(13), _col(26), _col(27), _col(52)], ["A", "M", "Z", "AA", "AZ"])


def cron_firings(expr: str, day: dt.date) -> list[dt.datetime]:
    """UTC firings of a 5-field cron on one UTC day (lists, ranges, steps and *)."""
    def expand(field, lo, hi):
        out = []
        for part in field.split(","):
            rng, _, step = part.partition("/")
            if rng == "*":
                a, b = lo, hi
            else:
                a, _, b = rng.partition("-")
                a, b = int(a), int(b) if b else (hi if step else int(a))
            out.extend(range(int(a), int(b) + 1, int(step or 1)))
        return out
    minute, hour, dom, month, dow = expr.split()
    if day.day not in expand(dom, 1, 31) or day.month not in expand(month, 1, 12):
        return []
    if dow != "*" and day.isoweekday() % 7 not in expand(dow, 0, 6):
        return []
    return [dt.datetime.combine(day, dt.time(h, m), UTC)
            for h in expand(hour, 0, 23) for m in expand(minute, 0, 59)]


def repo_crons():
    """The GitHub cron lines in collect.yml and the Cloudflare backup cron in private/wrangler.toml."""
    root = pathlib.Path(__file__).resolve().parent.parent
    github = re.findall(r'cron:\s*"([^"]+)"', (root / ".github/workflows/collect.yml").read_text())
    toml = (root / "private/wrangler.toml").read_text()
    cloudflare = json.loads(re.search(r"^crons\s*=\s*(\[.*\])", toml, re.M).group(1))
    return {"github": github, "cloudflare": cloudflare}


class WindowTests(unittest.TestCase):
    def test_twelve_two_hourly_windows(self):
        starts = [w.start for w in CFG.profile_windows]
        self.assertEqual(starts, [dt.time(h, 0) for h in range(0, 24, 2)])
        for w in CFG.profile_windows:
            self.assertEqual((w.end.hour, w.end.minute), (w.start.hour, 59), w.name)

    def test_windows_across_dst(self):
        w06 = next(w for w in CFG.profile_windows if w.name == "06u")
        # Summer time (UTC+2) and winter time (UTC+1, from 25 Oct 2026): same local window.
        cases = [
            (dt.datetime(2026, 10, 1, 3, 50, tzinfo=UTC), False),   # 05:50 CEST, too early
            (dt.datetime(2026, 10, 1, 4, 5, tzinfo=UTC), True),     # 06:05 CEST
            (dt.datetime(2026, 10, 1, 4, 59, tzinfo=UTC), True),    # 06:59 CEST
            (dt.datetime(2026, 10, 1, 5, 0, tzinfo=UTC), False),    # 07:00 CEST, too late
            (dt.datetime(2026, 10, 26, 4, 50, tzinfo=UTC), False),  # 05:50 CET, too early
            (dt.datetime(2026, 10, 26, 5, 10, tzinfo=UTC), True),   # 06:10 CET
        ]
        for when, expected in cases:
            self.assertEqual(w06.contains(when.astimezone(AMS)), expected, when)

    def test_crons_cover_every_window(self):
        """Both GitHub cron and the Cloudflare backup must hit every window at least 3 times,
        in summer time, on the day the clocks go back (25 Oct) and in winter time."""
        for source, crons in repo_crons().items():
            self.assertTrue(crons, source)
            for day in [dt.date(2026, 10, 1), dt.date(2026, 10, 25), dt.date(2026, 10, 26)]:
                # UTC days around it: the local 00u window starts the evening before in UTC.
                firings = [t for c in crons for d in (-1, 0, 1)
                           for t in cron_firings(c, day + dt.timedelta(days=d))]
                for window in CFG.profile_windows:
                    hits = [t for t in firings if window.contains(t.astimezone(AMS))
                            and t.astimezone(AMS).date() == day]
                    self.assertGreaterEqual(len(hits), 3, (source, day, window.name))
            refresh = CFG.refresh_window
            for day in [dt.date(2026, 10, 2), dt.date(2026, 10, 30)]:  # Fridays in summer and winter time
                hits = sum(refresh.contains(t.astimezone(AMS)) for c in crons for t in cron_firings(c, day))
                self.assertGreaterEqual(hits, 4, (source, day))


class BudgetTests(unittest.TestCase):
    def test_month_usage_ignores_dry_runs_and_other_months(self):
        rows = [
            {"timestamp": "2026-10-01T05:00:00Z", "dry_run": False, "actual_records": 45},
            {"timestamp": "2026-10-01T16:00:00Z", "dry_run": True, "actual_records": 45},
            {"timestamp": "2026-09-30T16:00:00Z", "dry_run": "FALSE", "actual_records": 45},
        ]
        self.assertEqual(model.month_usage(rows, dt.datetime(2026, 10, 2, tzinfo=UTC)), 45)

    def test_remaining_profile_runs(self):
        now = local(2026, 10, 23, 8, 45)  # Friday refresh time; the 08u window already ran
        done = {"2026-10-23/08u"}
        # 10u..22u on the 23rd (7) + 12 on each of the 24th to the 30th (84) = 91 runs;
        # collection stops after 30 Oct.
        self.assertEqual(model.remaining_profile_runs(CFG, now, done), 91)
        # Without the 08u run it is still open (ends 08:59), so it counts too.
        self.assertEqual(model.remaining_profile_runs(CFG, now, set()), 92)

    def test_campaign_end_and_cap(self):
        self.assertEqual((CAMP.end, CAMP.collect_until), (dt.date(2026, 10, 30), dt.date(2026, 10, 30)))
        self.assertEqual(CFG.monthly_cap, 23000)
        # 26-30 Oct are normal school days; the Herfstvakantie stays 19-23 Oct.
        self.assertFalse(any(CFG.off_days.contains(dt.date(2026, 10, d)) for d in range(26, 31)))
        self.assertTrue(CFG.off_days.contains(dt.date(2026, 10, 23)))
        # Every profile window of the last day is still collected; none on 31 Oct.
        last = local(2026, 10, 30, 21, 0)
        self.assertEqual(model.remaining_profile_runs(CFG, last, set()), 1)  # 22u (20u ended at 20:59)
        self.assertEqual(model.remaining_profile_runs(CFG, local(2026, 10, 31, 1, 0), set()), 0)

    def test_window_state(self):
        rows = [{"window": "k1", "status": "failed", "dry_run": False},
                {"window": "k1", "status": "failed", "dry_run": False},
                {"window": "k2", "status": "ok", "dry_run": False},
                {"window": "k3", "status": "dry-run", "dry_run": True}]
        done, failures = model.window_state(rows)
        self.assertEqual(done, {"k2"})
        self.assertEqual(failures["k1"], 2)

    def test_bd_date(self):
        self.assertEqual(model.bd_date(dt.date(2026, 9, 28)), "09-28-2026")


def profile_record(handle, videos, pinned=(), reposts=(), videos_count=None):
    return {
        "account_id": handle, "followers": 10, "following": 1, "likes": 5, "is_private": False,
        "videos_count": videos_count if videos_count is not None else len(videos),
        "input": {"url": f"https://www.tiktok.com/@{handle}"},
        "pinned_posts": [{"url": f"https://www.tiktok.com/@{handle}/video/{v}"} for v in pinned],
        "top_posts_data": [{"post_id": vid, "post_url": f"https://www.tiktok.com/@{'other' if vid in reposts else handle}/video/{vid}",
                            "post_type": "video", "hashtags": ["FYP", "glu"], "description": "x"} for vid, _, _ in videos],
        "top_videos": [{"video_id": vid, "create_date": date, "playcount": views, "diggcount": 1,
                        "commentcount": 0, "share_count": 0} for vid, date, views in videos],
    }


class ProfileTests(unittest.TestCase):
    def test_parse_profile_filters_campaign_pinned_reposts(self):
        rec = profile_record("stu", [
            ("100", "2026-09-29T10:00:00.000Z", 50),
            ("101", "2026-09-30T10:00:00.000Z", 70),
            ("90", "2025-01-01T10:00:00.000Z", 9999),   # old pinned video
            ("102", "2026-10-01T10:00:00.000Z", 5),     # repost
            ("103", "2026-09-27T21:59:00.000Z", 1),     # 23:59 Amsterdam on 27 Sept: before start
        ], pinned=["90"], reposts=["102"], videos_count=40)
        out = model.parse_profile(rec, "stu", CAMP, "now")
        self.assertEqual(sorted(v["video_id"] for v in out["videos"]), ["100", "101"])
        self.assertEqual(out["reposts"], 1)
        self.assertEqual(out["window"]["pinned_in_window"], 1)
        # Oldest own non-pinned video ignores the pinned one and the repost.
        self.assertEqual(out["window"]["window_oldest_nonpinned"], "2026-09-27T21:59:00Z")
        self.assertEqual(out["videos"][0]["hashtags"], "fyp glu")
        self.assertEqual(out["seen_ids"], {"100", "101", "90", "102", "103"})

    def test_parse_hashtags(self):
        self.assertEqual(model.parse_hashtags(["#FYP", "glu", "fyp", None, "undefined"]), "fyp glu")
        self.assertEqual(model.parse_hashtags(None, "Kijk dit! #Glu #schoolproject, #fyp."), "glu schoolproject fyp")
        self.assertEqual(model.parse_hashtags([], ""), "")

    def test_mark_missing(self):
        posts = [
            {"video_id": "1", "handle": "a", "created_at": "2026-10-01T10:00:00Z", "missing_since": ""},
            {"video_id": "2", "handle": "a", "created_at": "2026-10-03T10:00:00Z", "missing_since": ""},
            {"video_id": "3", "handle": "a", "created_at": "2026-10-04T10:00:00Z", "missing_since": "t0"},
            {"video_id": "4", "handle": "b", "created_at": "2026-10-04T10:00:00Z", "missing_since": ""},
        ]
        # Window of @a reaches back to 2 Oct and holds only video 5: video 1 simply aged out,
        # video 2 disappeared, video 3 was already flagged. @b was not in this run.
        flagged = model.mark_missing(posts, {"a": ({"5"}, "2026-10-02T00:00:00Z")}, "t1")
        self.assertEqual(flagged, ["2"])
        self.assertEqual([p["missing_since"] for p in posts], ["", "t1", "t0", ""])
        # Seen again: the flag is cleared.
        merged = model.upsert_posts(posts, [{"video_id": "2", "handle": "a", "created_at": "2026-10-03T10:00:00Z",
                                             "views": 1, "pinned": False, "hashtags": ""}], "t2", "profile")
        self.assertEqual({r["video_id"]: r["missing_since"] for r in merged}["2"], "")

    def test_upsert_keeps_views_monotonic_and_old_videos(self):
        existing = [{"video_id": "1", "handle": "a", "created_at": "2026-09-29T10:00:00Z", "views": 500,
                     "likes": 3, "first_seen": "t0", "last_seen": "t0", "source": "profile"},
                    {"video_id": "2", "handle": "a", "created_at": "2026-09-30T10:00:00Z", "views": 40,
                     "first_seen": "t0", "last_seen": "t0", "source": "profile"}]
        incoming = [{"video_id": "1", "handle": "a", "created_at": "2026-09-29T10:00:00Z", "views": 450,
                     "likes": 4, "pinned": False},
                    {"video_id": "3", "handle": "a", "created_at": "2026-10-01T10:00:00Z", "views": 7, "pinned": None}]
        merged = {r["video_id"]: r for r in model.upsert_posts(existing, incoming, "t1", "profile")}
        self.assertEqual(merged["1"]["views"], 500)   # never drops
        self.assertEqual(merged["1"]["likes"], 4)
        self.assertEqual(merged["2"]["last_seen"], "t0")  # left the window, kept
        self.assertEqual(merged["3"]["first_seen"], "t1")
        totals = model.campaign_totals(list(merged.values()), CAMP)
        self.assertEqual(totals["a"]["total_views"], 547)
        self.assertEqual(totals["a"]["campaign_posts"], 3)

    def test_post_history_is_light(self):
        """Every run while a video is < 72 h old, then at most every 6 h; only when numbers changed."""
        def post(vid, created, views, likes=1, **hist):
            return {"video_id": vid, "handle": "a", "created_at": created, "views": views, "likes": likes, **hist}
        t0 = "2026-10-05T10:00:00Z"
        posts = [
            post("new", "2026-10-05T08:00:00Z", 10),                                  # no row yet -> row
            post("young", "2026-10-04T10:00:00Z", 50, hist_at="2026-10-05T08:00:00Z", hist_views=40, hist_likes=1),
            post("same", "2026-10-04T10:00:00Z", 40, hist_at="2026-10-05T08:00:00Z", hist_views=40, hist_likes=1),
            post("old_recent", "2026-10-01T10:00:00Z", 99, hist_at="2026-10-05T06:00:00Z", hist_views=90, hist_likes=1),
            post("old_due", "2026-10-01T10:00:00Z", 99, hist_at="2026-10-05T04:00:00Z", hist_views=90, hist_likes=1),
            post("likes_only", "2026-10-04T10:00:00Z", 40, likes=5, hist_at="2026-10-05T08:00:00Z", hist_views=40, hist_likes=1),
            post("before", "2026-09-20T10:00:00Z", 5),                                # not a campaign post
        ]
        rows = model.post_history_rows(posts, t0, CAMP)
        self.assertEqual([r["video_id"] for r in rows], ["new", "young", "old_due", "likes_only"])
        self.assertEqual(set(rows[0]), {"video_id", "handle", "timestamp", "views", "likes"})
        by = {p["video_id"]: p for p in posts}
        self.assertEqual((by["young"]["hist_at"], by["young"]["hist_views"]), (t0, 50))  # marked in posts_latest
        self.assertEqual(by["old_recent"]["hist_at"], "2026-10-05T06:00:00Z")            # untouched
        # Two hours later with the same numbers: only old_recent, whose last row is now 6 h old.
        later = model.post_history_rows(posts, "2026-10-05T12:00:00Z", CAMP)
        self.assertEqual([r["video_id"] for r in later], ["old_recent"])
        self.assertEqual(model.post_history_rows(posts, "2026-10-05T14:00:00Z", CAMP), [])

    def test_parse_post_drops_reposts_and_old(self):
        base = {"post_id": "5", "create_time": "2026-10-01T10:00:00.000Z", "play_count": 9, "digg_count": 1,
                "comment_count": 0, "share_count": "2", "post_type": "video", "account_id": "stu"}
        self.assertEqual(model.parse_post(base, "stu", CAMP)[0]["shares"], 2)
        self.assertEqual(model.parse_post({**base, "account_id": "other"}, "stu", CAMP)[1], "repost")
        self.assertEqual(model.parse_post({**base, "create_time": "2026-09-01T10:00:00Z"}, "stu", CAMP)[1],
                         "outside campaign")
        self.assertEqual(model.parse_post({**base, "hashtags": ["Glu"]}, "stu", CAMP)[0]["hashtags"], "glu")


class RefreshPlanTests(unittest.TestCase):
    def test_plan(self):
        windows = {
            "covers": {"videos_count": 200, "window_count": 16, "window_oldest_nonpinned": "2026-09-20T10:00:00Z"},
            "small": {"videos_count": 5, "window_count": 5, "window_oldest_nonpinned": "2026-09-29T10:00:00Z"},
            "gap": {"videos_count": 40, "window_count": 16, "window_oldest_nonpinned": "2026-10-10T22:30:00Z"},
            "onlypinned": {"videos_count": 40, "window_count": 3, "window_oldest_nonpinned": ""},
        }
        plan, skipped = model.plan_refresh(["covers", "small", "gap", "onlypinned", "new", "priv"],
                                           windows, {"priv"}, CAMP)
        by = {p["handle"]: p for p in plan}
        self.assertEqual(set(by), {"gap", "onlypinned", "new"})
        self.assertEqual(by["gap"]["end_date"], dt.date(2026, 10, 11))  # local Amsterdam date
        self.assertIsNone(by["new"]["end_date"])
        self.assertEqual(skipped["priv"], "private")
        inp = model.posts_input("gap", CAMP, 20, by["gap"]["end_date"])
        self.assertEqual((inp["start_date"], inp["end_date"], inp["num_of_posts"]), ("09-28-2026", "10-11-2026", 20))

    def test_compare_window(self):
        full = [{"video_id": "1", "created_at": "2026-10-01T10:00:00Z", "views": 100},
                {"video_id": "2", "created_at": "2026-10-05T10:00:00Z", "views": 100},
                {"video_id": "3", "created_at": "2026-09-29T10:00:00Z", "views": 100}]
        window = {"window_oldest_nonpinned": "2026-10-01T00:00:00Z"}
        cmp = model.compare_window("a", full, {"1"}, {"1": 90}, window)
        self.assertEqual(cmp["missing"], 2)
        self.assertEqual(cmp["missing_inside_window"], 1)  # video 2 was newer than the window's oldest
        self.assertEqual(cmp["max_views_lag_pct"], 10.0)


class FinaleTests(unittest.TestCase):
    ROW = {"started_at": "2026-10-26T13:00:00Z", "started_by": "x@y.nl", "deadline": "2026-10-26T15:00:00Z",
           "status": "active", "ended_at": "", "ended_by": ""}

    def state(self, row, when):
        return model.finale_state([row], dt.datetime.fromisoformat(when).astimezone(UTC), CFG.finale.max_hours)

    def test_phases(self):
        self.assertIsNone(self.state(self.ROW, "2026-10-26T12:59:00+00:00")["phase"])  # not started yet
        self.assertEqual(self.state(self.ROW, "2026-10-26T14:00:00+00:00")["phase"], "live")
        self.assertEqual(self.state(self.ROW, "2026-10-26T15:00:00+00:00")["phase"], "ended")  # Eindstand
        stopped = {**self.ROW, "status": "stopped", "ended_at": "2026-10-26T14:10:00Z"}
        st = self.state(stopped, "2026-10-26T14:20:00+00:00")
        self.assertEqual((st["phase"], model.iso(st["end"])), ("ended", "2026-10-26T14:10:00Z"))
        self.assertIsNone(self.state({**self.ROW, "status": "cancelled"}, "2026-10-26T14:00:00+00:00"))
        self.assertIsNone(model.finale_state([], dt.datetime(2026, 10, 26, tzinfo=UTC), 8))

    def test_hard_maximum(self):
        """A deadline further than max_hours after the start is cut off at max_hours."""
        row = {**self.ROW, "deadline": "2026-10-27T13:00:00Z"}
        st = self.state(row, "2026-10-26T20:59:00+00:00")
        self.assertEqual(model.iso(st["end"]), "2026-10-26T21:00:00Z")
        self.assertEqual(self.state(row, "2026-10-26T21:00:00+00:00")["phase"], "ended")

    def test_window_key(self):
        self.assertEqual(model.finale_window_key(local(2026, 10, 26, 16, 29), 15), "2026-10-26/finale-1615")
        self.assertEqual(model.finale_window_key(local(2026, 10, 26, 16, 30), 15), "2026-10-26/finale-1630")

    def test_auto_runs_finale_windows_without_the_60_minute_skip(self):
        """During a finale, auto() runs the 15-minute window (never skipped for a recent run) and not the
        2-hourly one; a second firing in the same window does nothing."""
        now = dt.datetime(2026, 10, 26, 14, 5, tzinfo=UTC)  # 15:05 Amsterdam (winter time)
        run_log = [{"timestamp": "2026-10-26T13:50:00Z", "run_type": "profiles", "window": "2026-10-26/finale-1445",
                    "dry_run": False, "snapshot_ids": "sd_a", "status": "ok"}]
        admin = FakeSheet({"run_log": run_log, "accounts": [], "finale": [self.ROW]})
        Collector(CFG, admin, FakeSheet({}), bd=None, now=now).auto()
        row = admin.tabs["run_log"][-1]
        self.assertEqual(row["window"], "2026-10-26/finale-1500")
        self.assertNotIn("SKIPPED", row["notes"])  # 15 min after the last run, but finale runs never skip
        Collector(CFG, admin, FakeSheet({}), bd=None, now=now + dt.timedelta(minutes=5)).auto()
        self.assertEqual(len(admin.tabs["run_log"]), 2)


class OffDayTests(unittest.TestCase):
    def test_weekends_and_herfstvakantie(self):
        off = config.load().off_days
        self.assertTrue(off.contains(dt.date(2026, 10, 3)))    # Saturday
        self.assertTrue(off.contains(dt.date(2026, 10, 19)))   # Herfstvakantie, Monday
        self.assertTrue(off.contains(dt.date(2026, 10, 23)))   # Herfstvakantie, Friday
        self.assertFalse(off.contains(dt.date(2026, 10, 26)))  # Monday after
        self.assertFalse(off.contains(dt.date(2026, 10, 16)))  # Friday before

    def test_fixed_tab_id_matches_the_website(self):
        site = (config.ROOT / "site" / "config.js").read_text(encoding="utf-8")
        self.assertIn(f"outliers: {model.FIXED_SHEET_IDS['outliers']}", site)
        self.assertIn("outliers", model.SCHEMA_DATA)
        self.assertLess(model.FIXED_SHEET_IDS["outliers"], 2 ** 31)  # Sheets tab ids are int32
        from collector import worker_config
        out = worker_config.build(config.load())
        self.assertEqual(out["fixedGids"], {"outliers": model.FIXED_SHEET_IDS["outliers"]})
        self.assertEqual(out["todayCheck"], {"cooldownMinutes": 10})
        self.assertEqual(out["signals"]["minViews"], CFG.signals["min_views"])
        self.assertEqual(set(out["signals"]), {"minViews", "likeRatioFactor", "stepShare", "stepMaxHours", "flatHours",
                                               "flatShare", "zeroEngagementMinViews", "followerJumpMin", "followerJumpFactor"})

    def test_worker_config_and_validation(self):
        from collector import worker_config
        out = worker_config.build(config.load())["offDays"]
        self.assertEqual(out, {"weekends": True, "periods": [
            {"name": "Herfstvakantie", "from": "2026-10-19", "to": "2026-10-23"}]})
        with self.assertRaises(ValueError):
            config._off_days({"periods": [{"name": "x", "from": "2026-10-23", "to": "2026-10-19"}]})
        self.assertEqual(config._off_days(None), config.OffDays())


class FakeSheet:
    """In-memory stand-in for Spreadsheet."""

    def __init__(self, tabs):
        self.tabs = {k: list(v) for k, v in tabs.items()}

    def read(self, tab):
        return [dict(r) for r in self.tabs.get(tab, [])]

    def append(self, tab, rows):
        self.tabs.setdefault(tab, []).extend(rows)

    def rewrite(self, tab, rows):
        self.tabs[tab] = [dict(r) for r in rows]

    def ensure_columns(self, tab, columns):
        pass

    def ensure_tabs(self, schema, sheet_ids=None):
        for tab in schema:
            self.tabs.setdefault(tab, [])


class FakeBrightData:
    """Returns one profile record per requested URL; remembers what was asked."""

    def __init__(self, records):
        self.records = records
        self.asked = []

    def trigger(self, dataset, inputs, **params):
        self.asked.append([i["url"].split("@")[1] for i in inputs])
        return "sd_test"

    def wait(self, snapshot):
        return {"status": "ready", "records": len(self.asked[-1])}

    def download(self, snapshot):
        return [self.records[h] for h in self.asked[-1] if h in self.records]


class TodayCheckTests(unittest.TestCase):
    """Vandaag tab: "Controleer nu" checks only some accounts."""
    NOW = dt.datetime(2026, 10, 7, 12, 0, tzinfo=UTC)

    def setUp(self):
        accounts = [{"student_name": n, "tiktok_handle": h, "active": "ja", "main_account": m}
                    for n, h, m in [("A", "aa", ""), ("B", "bb", ""), ("C", "cc", "bb"), ("D", "dd", "")]]
        self.admin = FakeSheet({"accounts": accounts, "run_log": [], "profile_window": []})
        old = {"is_private": False, "followers": 5, "last_scraped": "2026-10-07T10:00:00Z", "last_status": "ok",
               "status_since": "2026-09-28T06:00:00Z"}
        self.data = FakeSheet({
            "handles": [{"handle": "aa", **old}, {"handle": "bb", **old}, {"handle": "cc", **old},
                        {"handle": "dd", **old, "is_private": True, "last_status": "privé", "status_since": ""}],
            "posts_latest": [], "history": [], "profile_snapshots": [
                {"timestamp": "2026-10-01T10:00:00Z", "handle": "dd", "is_private": False},
                {"timestamp": "2026-10-03T10:00:00Z", "handle": "dd", "is_private": True},
                {"timestamp": "2026-10-05T10:00:00Z", "handle": "dd", "is_private": True}],
        })
        self.bd = FakeBrightData({h: profile_record(h, [(str(700 + i), "2026-10-07T09:00:00.000Z", 40)])
                                  for i, h in enumerate(["aa", "bb", "cc", "dd"])})

    def check(self, handles, dry=False):
        col = Collector(CFG, self.admin, self.data, self.bd, dry_run=dry, now=self.NOW)
        col.run_today_check("2026-10-07/today-1400", handles)
        return self.admin.tabs["run_log"][-1]

    def test_only_requested_accounts_are_fetched_and_updated(self):
        row = self.check(["bb", "dd", "zz", "cc"])  # dd is private, zz is not in accounts
        self.assertEqual(self.bd.asked, [["bb", "cc"]])
        self.assertEqual((row["run_type"], row["status"], row["expected_records"], row["actual_records"]),
                         ("today_check", "ok", 2, 2))
        self.assertIn("@dd, @zz", row["notes"])
        # History rows only for the two fetched accounts; handles keeps every row.
        self.assertEqual(sorted(r["handle"] for r in self.data.tabs["history"]), ["bb", "cc"])
        handles = {r["handle"]: r for r in self.data.tabs["handles"]}
        self.assertEqual(sorted(handles), ["aa", "bb", "cc", "dd"])
        self.assertEqual(handles["aa"]["last_scraped"], "2026-10-07T10:00:00Z")   # untouched
        self.assertEqual(handles["bb"]["last_scraped"], "2026-10-07T12:00:00Z")
        self.assertEqual(handles["bb"]["status_since"], "2026-09-28T06:00:00Z")   # still ok: unchanged
        # The private account was not fetched, but its new status_since column is filled in from the
        # snapshots: private since 3 Oct.
        self.assertEqual(handles["dd"]["status_since"], "2026-10-03T10:00:00Z")
        self.assertEqual({p["handle"] for p in self.data.tabs["posts_latest"]}, {"bb", "cc"})
        self.assertIn("outliers", self.data.tabs)  # public "buiten schaal" tab created on the first run
        # cc is bb's second account: the public handles tab says so (handles only).
        self.assertEqual({h: r["group"] for h, r in handles.items()}, {"aa": "aa", "bb": "bb", "cc": "bb", "dd": "dd"})

    def test_a_check_never_counts_as_a_full_profiles_run(self):
        self.check(["aa"])
        log = self.admin.tabs["run_log"]
        self.assertIsNone(model.last_profiles_run(log))
        # So the next scheduled window still runs (no 60-minute skip).
        col = Collector(CFG, self.admin, self.data, self.bd, now=self.NOW + dt.timedelta(minutes=10))
        col.run_scheduled_profiles("2026-10-07/14u")
        self.assertEqual(self.admin.tabs["run_log"][-1]["status"], "ok")
        self.assertEqual(self.bd.asked[-1], ["aa", "bb", "cc", "dd"])

    def test_dry_run_and_budget(self):
        row = self.check(["aa", "bb"], dry=True)
        self.assertEqual((row["status"], row["expected_records"], self.bd.asked), ("dry-run", 2, []))
        self.assertIn("would check: @aa, @bb", row["notes"])
        # Refused when the month (plus the profile runs still to come) would go over the cap.
        self.admin.tabs["run_log"].append({"timestamp": "2026-10-07T08:00:00Z", "dry_run": False,
                                           "actual_records": CFG.monthly_cap - 100})
        row = self.check(["aa", "bb"])
        self.assertEqual((row["status"], self.bd.asked), ("refused", []))
        self.assertIn("reserved for remaining profile runs", row["notes"])

    def test_status_since_changes_with_the_status(self):
        self.bd.records["cc"] = {"error": "Profile does not exist", "error_code": "dead_page",
                                 "input": {"url": "https://www.tiktok.com/@cc"}}
        self.check(["cc"])
        cc = next(r for r in self.data.tabs["handles"] if r["handle"] == "cc")
        self.assertTrue(cc["last_status"].startswith("fout"))
        self.assertEqual(cc["status_since"], "2026-10-07T12:00:00Z")
        self.assertEqual(model.status_kind("privé"), "privé")
        self.assertEqual(model.private_since([{"timestamp": "t1", "handle": "x", "is_private": "TRUE"}], "x"), "t1")


class ForceRefreshTests(unittest.TestCase):
    NOW = dt.datetime(2026, 10, 1, 10, 0, tzinfo=UTC)

    def run_force(self, run_log):
        admin = FakeSheet({"run_log": run_log, "accounts": []})
        col = Collector(CFG, admin, FakeSheet({}), bd=None, now=self.NOW)
        col.run_force_refresh("2026-10-01/force-1200")
        return admin.tabs["run_log"][-1]

    def test_last_profiles_run_ignores_dry_runs_and_runs_without_a_job(self):
        rows = [
            {"timestamp": "2026-10-01T09:50:00Z", "run_type": "profiles", "dry_run": True, "snapshot_ids": "sd_x"},
            {"timestamp": "2026-10-01T09:55:00Z", "run_type": "force_refresh", "dry_run": False, "snapshot_ids": ""},
            {"timestamp": "2026-10-01T09:58:00Z", "run_type": "posts_refresh", "dry_run": False, "snapshot_ids": "sd_y"},
            {"timestamp": "2026-10-01T09:20:00Z", "run_type": "profiles", "dry_run": False, "snapshot_ids": "sd_z"},
        ]
        self.assertEqual(model.last_profiles_run(rows), dt.datetime(2026, 10, 1, 9, 20, tzinfo=UTC))

    def test_refused_within_cooldown(self):
        row = self.run_force([{"timestamp": "2026-10-01T09:40:00Z", "run_type": "profiles",
                               "dry_run": False, "snapshot_ids": "sd_a", "status": "ok"}])
        self.assertEqual((row["run_type"], row["status"], row["actual_records"]), ("force_refresh", "refused", 0))
        self.assertIn("20 min ago", row["notes"])

    def run_scheduled(self, run_log):
        admin = FakeSheet({"run_log": run_log, "accounts": []})
        col = Collector(CFG, admin, FakeSheet({}), bd=None, now=self.NOW)
        col.run_scheduled_profiles("2026-10-01/avond")
        return admin.tabs["run_log"][-1]

    def test_scheduled_run_skipped_right_after_a_refresh(self):
        self.assertEqual(CFG.skip_recent_minutes, 60)
        row = self.run_scheduled([{"timestamp": "2026-10-01T09:05:00Z", "run_type": "force_refresh",
                                   "dry_run": False, "snapshot_ids": "sd_a", "status": "ok"}])
        self.assertEqual((row["run_type"], row["status"], row["actual_records"]), ("profiles", "skipped", 0))
        self.assertIn("SKIPPED: last profiles run was 55 min ago", row["notes"])
        # A skipped window counts as done, so later cron firings don't run it again.
        done, _ = model.window_state([row])
        self.assertIn("2026-10-01/avond", done)

    def test_scheduled_run_goes_ahead_after_an_hour(self):
        row = self.run_scheduled([{"timestamp": "2026-10-01T08:55:00Z", "run_type": "force_refresh",
                                   "dry_run": False, "snapshot_ids": "sd_a", "status": "ok"}])
        self.assertNotIn("SKIPPED", row["notes"])
        self.assertIn("no active valid handles", row["notes"])

    def test_allowed_after_cooldown(self):
        row = self.run_force([{"timestamp": "2026-10-01T09:25:00Z", "run_type": "force_refresh",
                               "dry_run": False, "snapshot_ids": "sd_a", "status": "ok"}])
        # Past the cooldown it goes on to the normal profiles run (here: no accounts, so skipped).
        self.assertEqual((row["run_type"], row["status"]), ("force_refresh", "skipped"))


if __name__ == "__main__":
    unittest.main()
