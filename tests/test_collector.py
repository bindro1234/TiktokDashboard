"""Unit tests with synthetic data only (no real scraped data in the repo). Run: python -m unittest"""

import datetime as dt
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


class WindowTests(unittest.TestCase):
    def test_windows_across_dst(self):
        morning = CFG.profile_windows[0]
        # Summer time (UTC+2) and winter time (UTC+1, from 25 Oct 2026): same local window.
        cases = [
            (dt.datetime(2026, 10, 1, 4, 10, tzinfo=UTC), False),   # 06:10 CEST, too early
            (dt.datetime(2026, 10, 1, 4, 30, tzinfo=UTC), True),    # 06:30 CEST
            (dt.datetime(2026, 10, 1, 6, 10, tzinfo=UTC), False),   # 08:10 CEST, too late
            (dt.datetime(2026, 10, 26, 4, 50, tzinfo=UTC), False),  # 05:50 CET, too early
            (dt.datetime(2026, 10, 26, 5, 50, tzinfo=UTC), True),   # 06:50 CET
            (dt.datetime(2026, 10, 26, 6, 50, tzinfo=UTC), True),   # 07:50 CET
        ]
        for when, expected in cases:
            self.assertEqual(morning.contains(when.astimezone(AMS)), expected, when)

    def test_cron_covers_windows(self):
        """Every cron firing minute list must hit each window several times in summer and winter time."""
        crons = {"profiles": ([10, 30, 50], range(4, 7)), "evening": ([10, 30, 50], range(16, 19))}
        for day in [dt.date(2026, 10, 1), dt.date(2026, 10, 26)]:
            for window in CFG.profile_windows:
                hits = 0
                for minutes, hours in crons.values():
                    for h in hours:
                        for m in minutes:
                            t = dt.datetime.combine(day, dt.time(h, m), UTC).astimezone(AMS)
                            hits += window.contains(t)
                self.assertGreaterEqual(hits, 4, (day, window.name))
        refresh = CFG.refresh_window
        for day in [dt.date(2026, 10, 2), dt.date(2026, 10, 30)]:  # Fridays in summer and winter time
            hits = sum(refresh.contains(dt.datetime.combine(day, dt.time(h, m), UTC).astimezone(AMS))
                       for h in range(6, 9) for m in [10, 30, 50])
            self.assertGreaterEqual(hits, 4, day)


class BudgetTests(unittest.TestCase):
    def test_month_usage_ignores_dry_runs_and_other_months(self):
        rows = [
            {"timestamp": "2026-10-01T05:00:00Z", "dry_run": False, "actual_records": 45},
            {"timestamp": "2026-10-01T16:00:00Z", "dry_run": True, "actual_records": 45},
            {"timestamp": "2026-09-30T16:00:00Z", "dry_run": "FALSE", "actual_records": 45},
        ]
        self.assertEqual(model.month_usage(rows, dt.datetime(2026, 10, 2, tzinfo=UTC)), 45)

    def test_remaining_profile_runs(self):
        now = local(2026, 10, 23, 8, 45)  # Friday refresh time; this morning already ran
        done = {"2026-10-23/ochtend"}
        # Evening of 23rd + 24th, 25th, 26th (both) = 7 runs, collection stops after 26 Oct.
        self.assertEqual(model.remaining_profile_runs(CFG, now, done), 7)

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
                            "post_type": "video"} for vid, _, _ in videos],
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

    def test_parse_post_drops_reposts_and_old(self):
        base = {"post_id": "5", "create_time": "2026-10-01T10:00:00.000Z", "play_count": 9, "digg_count": 1,
                "comment_count": 0, "share_count": "2", "post_type": "video", "account_id": "stu"}
        self.assertEqual(model.parse_post(base, "stu", CAMP)[0]["shares"], 2)
        self.assertEqual(model.parse_post({**base, "account_id": "other"}, "stu", CAMP)[1], "repost")
        self.assertEqual(model.parse_post({**base, "create_time": "2026-09-01T10:00:00Z"}, "stu", CAMP)[1],
                         "outside campaign")


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


class FakeSheet:
    """In-memory stand-in for Spreadsheet (read/append only)."""

    def __init__(self, tabs):
        self.tabs = {k: list(v) for k, v in tabs.items()}

    def read(self, tab):
        return list(self.tabs.get(tab, []))

    def append(self, tab, rows):
        self.tabs.setdefault(tab, []).extend(rows)


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

    def test_allowed_after_cooldown(self):
        row = self.run_force([{"timestamp": "2026-10-01T09:25:00Z", "run_type": "force_refresh",
                               "dry_run": False, "snapshot_ids": "sd_a", "status": "ok"}])
        # Past the cooldown it goes on to the normal profiles run (here: no accounts, so skipped).
        self.assertEqual((row["run_type"], row["status"]), ("force_refresh", "skipped"))


if __name__ == "__main__":
    unittest.main()
