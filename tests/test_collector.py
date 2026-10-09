"""Unit tests with synthetic data only (no real scraped data in the repo). Run: python -m unittest"""

import datetime as dt
import json
import os
import pathlib
import re
import tempfile
import unittest
from unittest import mock

from collector import config, model
from collector.__main__ import run_today
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
        tiktok = [c for c in cases if c.get("platform", "tiktok") == "tiktok"]
        self.assertGreater(len(tiktok), 10)
        for case in tiktok:
            self.assertEqual(normalize_handle(case["raw"])[0], case["handle"], case["raw"])

    def test_shared_instagram_cases(self):
        """Instagram's own rules; same cases as private/public/lib.js (private/test)."""
        from collector.handles import normalize_instagram_handle
        cases = json.loads((pathlib.Path(__file__).parent / "handle_cases.json").read_text(encoding="utf-8"))
        instagram = [c for c in cases if c.get("platform") == "instagram"]
        self.assertGreater(len(instagram), 20)
        for case in instagram:
            handle, reason = normalize_instagram_handle(case["raw"])
            self.assertEqual(handle, case["handle"], case["raw"])
            self.assertEqual(reason is None, handle is not None, case["raw"])

    def test_instagram_handle_is_not_a_tiktok_handle(self):
        """The platforms have their own rules: 30 characters and double periods differ."""
        from collector.handles import normalize_instagram_handle
        self.assertIsNone(normalize_handle("a" * 30)[0])
        self.assertEqual(normalize_instagram_handle("a" * 30)[0], "a" * 30)
        self.assertEqual(normalize_handle("two..dots")[0], "two..dots")
        self.assertIsNone(normalize_instagram_handle("two..dots")[0])
        self.assertIsNone(normalize_instagram_handle("https://www.tiktok.com/@naam")[0])

    def test_instagram_column_header(self):
        """The column was typed as 'Insta ' (the sheet reader trims header cells): both names are read."""
        from collector.handles import instagram_cell
        self.assertEqual(instagram_cell({"student_name": "A", "Insta": "@one"}), "@one")
        self.assertEqual(instagram_cell({"instagram_handle": "two"}), "two")
        self.assertEqual(instagram_cell({"student_name": "A"}), "")
        self.assertIn("instagram_handle", model.SCHEMA_ADMIN["accounts"])

    def test_instagram_accounts(self):
        """One Instagram account per student, on the student's first row; problems are reported without names."""
        from collector.handles import parse_instagram_accounts
        rows = [
            {"student_name": "Anna", "tiktok_handle": "@anna", "active": "ja", "main_account": "", "Insta": "Anna.Gram"},
            {"student_name": "Anna", "tiktok_handle": "anna.ads", "active": "ja", "main_account": "anna", "Insta": "anna.second"},
            {"student_name": "Bram", "tiktok_handle": "bram", "active": "nee", "Insta": "bram"},            # inactive
            {"student_name": "Cas", "tiktok_handle": "cas", "active": "ja", "Insta": "https://www.instagram.com/cas_ig/"},
            {"student_name": "Dee", "tiktok_handle": "dee", "active": "ja", "Insta": "cas_ig"},              # same account as Cas
            {"student_name": "Eli", "tiktok_handle": "eli", "active": "ja", "Insta": "https://www.instagram.com/p/Xyz"},
            {"student_name": "Fay", "tiktok_handle": "", "active": "ja", "Insta": "fay.only"},               # no TikTok at all
            {"student_name": "Gus", "tiktok_handle": "gus", "active": "ja", "Insta": ""},                    # none yet
            {"student_name": "Hal", "tiktok_handle": "hal", "active": "misschien", "Insta": "hal"},
        ]
        accounts, issues = parse_instagram_accounts(rows)
        self.assertEqual([(a["handle"], a["student"]) for a in accounts],
                         [("anna.gram", "anna"), ("cas_ig", "cas"), ("fay.only", "instagram:fay.only")])
        self.assertEqual(len(issues), 4)
        self.assertEqual([a["row"] for a in accounts], [2, 5, 8])
        text = " ".join(issues)
        self.assertIn("second TikTok account", text)
        self.assertIn("duplicate of row 5", text)
        self.assertFalse(any(n in text for n in ["Anna", "Bram", "Cas", "Dee", "Eli", "Fay", "Hal"]))
        # A student who only has Instagram is not a TikTok problem; a row with nothing at all still is.
        handles, tiktok_issues = parse_accounts(rows[6:7] + [{"student_name": "Zed", "tiktok_handle": "", "active": "ja"}])
        self.assertEqual((handles, len(tiktok_issues)), ([], 1))
        self.assertIn("row 3", tiktok_issues[0])

    def test_rename_header_in_place(self):
        """setup renames the typed 'Insta ' header instead of adding a second, empty column."""
        from collector.sheets import Spreadsheet
        calls = []
        header = ["student_name", "tiktok_handle", "active", "main_account", "Insta "]

        class Sheet(Spreadsheet):
            def _call(self, method, path="", **kw):
                calls.append((method, path, kw.get("json")))
                if method == "PUT":  # like the real sheet: the cell now holds the new name
                    header[4] = kw["json"]["values"][0][0]
                return {"values": [list(header)]}

        sheet = Sheet(None, "x")
        self.assertEqual(sheet.rename_header("accounts", {"insta": "instagram_handle"}), ["Insta -> instagram_handle"])
        put = [c for c in calls if c[0] == "PUT"]
        self.assertEqual(len(put), 1)
        self.assertTrue(put[0][1].endswith("!E1"), put[0][1])
        self.assertEqual(put[0][2], {"values": [["instagram_handle"]]})
        # Already renamed (or both present): nothing to do.
        calls.clear()
        self.assertEqual(sheet.rename_header("accounts", {"insta": "instagram_handle"}), [])
        self.assertEqual([c for c in calls if c[0] == "PUT"], [])

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
        # TikTok every 12 hours (08u, 20u): 20u on the 23rd + 2 on each of the 24th to the 30th = 15 runs;
        # collection stops after 30 Oct.
        self.assertEqual(model.remaining_profile_runs(CFG, now, {"2026-10-23/08u"}), 15)
        # Without the 08u run it is still open (ends 08:59), so it counts too.
        self.assertEqual(model.remaining_profile_runs(CFG, now, set()), 16)
        # Instagram every 4 hours (6 a day): 12u, 16u, 20u on the 23rd + 6 on each of the next 7 days = 45;
        # its windows are keyed ig-08u, so a TikTok 08u run says nothing about them.
        self.assertEqual(model.remaining_profile_runs(CFG, now, {"2026-10-23/08u"}, "instagram"), 46)
        self.assertEqual(model.remaining_profile_runs(CFG, now, {"2026-10-23/ig-08u"}, "instagram"), 45)

    def test_campaign_end_and_cap(self):
        self.assertEqual((CAMP.end, CAMP.collect_until), (dt.date(2026, 10, 30), dt.date(2026, 10, 30)))
        self.assertEqual(CFG.monthly_cap, 23000)
        # 26-30 Oct are normal school days; the Herfstvakantie stays 19-23 Oct.
        self.assertFalse(any(CFG.off_days.contains(dt.date(2026, 10, d)) for d in range(26, 31)))
        self.assertTrue(CFG.off_days.contains(dt.date(2026, 10, 23)))
        # Every window of the last day is still collected (20u for both platforms); none on 31 Oct.
        last = local(2026, 10, 30, 19, 0)
        self.assertEqual(model.remaining_profile_runs(CFG, last, set()), 1)
        self.assertEqual(model.remaining_profile_runs(CFG, last, set(), "instagram"), 1)
        self.assertEqual(model.remaining_profile_runs(CFG, local(2026, 10, 30, 21, 0), set()), 0)  # 20u ended at 20:59
        self.assertEqual(model.remaining_profile_runs(CFG, local(2026, 10, 31, 1, 0), set()), 0)
        self.assertEqual(model.remaining_profile_runs(CFG, local(2026, 10, 31, 1, 0), set(), "instagram"), 0)

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
        # Both platforms run in the finale (here without accounts, so both are skipped and done).
        rows = {r["window"]: r for r in admin.tabs["run_log"][1:]}
        self.assertEqual(set(rows), {"2026-10-26/finale-1500", "2026-10-26/ig-finale-1500"})
        self.assertNotIn("SKIPPED", rows["2026-10-26/finale-1500"]["notes"])  # 15 min after the last run, but finale runs never skip
        self.assertEqual({r["run_type"] for r in rows.values()}, {"profiles", "ig_profiles"})
        Collector(CFG, admin, FakeSheet({}), bd=None, now=now + dt.timedelta(minutes=5)).auto()
        self.assertEqual(len(admin.tabs["run_log"]), 3)


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
        self.assertEqual(set(model.FIXED_SHEET_IDS),
                         {"outliers", "ig_handles", "ig_history", "ig_posts", "ig_baseline", "ig_outliers"})
        for tab, gid in model.FIXED_SHEET_IDS.items():
            self.assertIn(f"{tab}: {gid}", site)   # the site knows these tabs before they exist
            self.assertIn(tab, model.SCHEMA_DATA)
            self.assertLess(gid, 2 ** 31)  # Sheets tab ids are int32
        self.assertEqual(len(set(model.FIXED_SHEET_IDS.values())), len(model.FIXED_SHEET_IDS))
        from collector import worker_config
        out = worker_config.build(config.load())
        self.assertEqual(out["fixedGids"], model.FIXED_SHEET_IDS)
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

    def test_school_hashtags_start_value(self):
        from collector import worker_config
        self.assertEqual(CFG.school_hashtags, ("glu", "grafischlyceumutrecht", "av"))
        self.assertEqual(worker_config.build(CFG)["hashtags"], {"school": ["glu", "grafischlyceumutrecht", "av"]})
        # Written however a teacher likes: '#', capitals, doubles; checked like the Beheer form does.
        self.assertEqual(config._hashtags(["#GLU", " av ", "glu"]), ("glu", "av"))
        self.assertEqual(config._hashtags(None), ())
        with self.assertRaises(ValueError):
            config._hashtags(["twee woorden"])
        with self.assertRaises(ValueError):
            config._hashtags([f"tag{i}" for i in range(config.MAX_SCHOOL_HASHTAGS + 1)])


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


# ---------- Instagram ----------

def ig_id(ts: dt.datetime) -> str:
    """An Instagram media id for a moment (the same formula the real ids follow)."""
    from collector import instagram
    return str(((int(ts.timestamp() * 1000) - instagram.IG_EPOCH_MS) << 23) | 4321)


def ig_post(ts, content_type="Image", caption="", tags=None, listed=None):
    return {"caption": caption, "datetime": listed or ts.strftime("%Y-%m-%dT00:00:00.000Z"), "id": ig_id(ts),
            "image_url": "https://example.invalid/x.jpg", "post_hashtags": tags, "content_type": content_type,
            "url": f"https://www.instagram.com/p/C{ig_id(ts)[-8:]}"}


def ig_record(handle, posts, followers=10, following=3, private=False, posts_count=None):
    return {"account": handle, "id": "99", "followers": followers, "following": following,
            "posts_count": posts_count if posts_count is not None else len(posts), "is_private": private,
            "posts": posts, "input": {"url": f"https://www.instagram.com/{handle}/"},
            "discovery_input": {"user_name": handle}}


def ut(y, m, d, hh=12, mm=0):
    return dt.datetime(y, m, d, hh, mm, tzinfo=UTC)


class InstagramParseTests(unittest.TestCase):
    NOW = ut(2026, 10, 12, 12, 0)

    def test_post_time_comes_from_the_id(self):
        from collector import instagram
        moment = dt.datetime(2026, 10, 9, 12, 38, 17, tzinfo=UTC)
        self.assertEqual(instagram.post_time_from_id(ig_id(moment), self.NOW), moment)
        for bad in ["", "abc", "123", None, "9" * 30, "-5"]:
            self.assertIsNone(instagram.post_time_from_id(bad, self.NOW), bad)
        # An id from the future is not plausible.
        self.assertIsNone(instagram.post_time_from_id(ig_id(self.NOW + dt.timedelta(days=3)), self.NOW))

    def test_created_at_is_the_id_time_never_before_the_listed_day(self):
        from collector import instagram
        t = dt.datetime(2026, 10, 9, 12, 38, 17, tzinfo=UTC)
        # Normal post: the listing holds the same day, the id gives the exact time.
        self.assertEqual(instagram.created_at(ig_post(t), self.NOW), t)
        # Listed a day earlier than the id says: the id wins (the list is off by a day for about 1 post in 10).
        self.assertEqual(instagram.created_at(ig_post(t, listed="2026-10-08T00:00:00.000Z"), self.NOW), t)
        # A scheduled post (created before it was published): not earlier than the listed day.
        self.assertEqual(instagram.created_at(ig_post(t, listed="2026-10-10T00:00:00.000Z"), self.NOW), ut(2026, 10, 10, 0))
        # No usable id: the listed date, as it is.
        broken = {**ig_post(t), "id": "x"}
        self.assertEqual(instagram.created_at(broken, self.NOW), ut(2026, 10, 9, 0))
        self.assertIsNone(instagram.created_at({"id": "x"}, self.NOW))

    def test_types_and_hashtags(self):
        from collector import instagram
        self.assertEqual([instagram.post_type(x) for x in ["Image", "Carousel", "Video", "Reel", None]],
                         ["photo", "carousel", "reel", "reel", ""])
        post = {"caption": "Nieuw! #GLU #fotografie📷 #glu #Grafisch_Lyceum, #", "post_hashtags": ["fotografie📷", "AV"]}
        self.assertEqual(instagram.hashtags(post), "fotografie av glu grafisch_lyceum")
        self.assertEqual(instagram.hashtags({"caption": None, "post_hashtags": None}), "")

    def test_only_posts_from_the_instagram_start_day_to_the_campaign_end_count(self):
        from collector import instagram
        camp = CFG.instagram_campaign
        self.assertEqual((camp.start, camp.end), (dt.date(2026, 10, 7), dt.date(2026, 10, 30)))
        before = camp.start_utc - dt.timedelta(minutes=1)   # 23:59 Amsterdam on 6 Oct
        first = camp.start_utc                               # 00:00 Amsterdam on 7 Oct
        last = camp.end_utc_exclusive - dt.timedelta(minutes=1)  # 23:59 Amsterdam on 30 Oct
        after = camp.end_utc_exclusive
        rec = ig_record("stu", [ig_post(t) for t in (before, first, last, after)])
        now = after + dt.timedelta(hours=1)
        out = instagram.parse_profile(rec, "stu", camp, now)
        self.assertEqual(sorted(p["created_at"] for p in out["posts"]), sorted(model.iso(t) for t in (first, last)))
        self.assertEqual(out["array_size"], 4)
        snap = out["snapshot"]
        self.assertEqual((snap["followers"], snap["following"], snap["posts_count"], snap["is_private"]), (10, 3, 4, False))
        # The week before the start (TikTok days) is not an Instagram day.
        self.assertFalse(camp.counts(ut(2026, 10, 1)))

    def test_record_handle_and_errors(self):
        from collector import instagram
        self.assertEqual(instagram.record_handle(ig_record("Stu.IG", [])), "stu.ig")
        err = {"error": "Profile does not exist", "error_code": "dead_page", "input": {"url": "https://www.instagram.com/gone/"}}
        self.assertEqual(instagram.record_handle(err), "gone")
        self.assertTrue(instagram.is_error(err))
        self.assertEqual(instagram.error_reason(err), "dead_page: Profile does not exist")
        self.assertFalse(instagram.is_error(ig_record("stu", [])))
        # An empty record for an account that is gone is a failure too, never a measurement without followers.
        empty = {"input": {"url": "https://www.instagram.com/gone/"}, "followers": None, "posts": None}
        self.assertTrue(instagram.is_error(empty))
        self.assertEqual(instagram.error_reason(empty), "error: no profile data in the record")
        self.assertFalse(instagram.is_error({"input": {"url": "x"}, "followers": 0}))   # zero followers is real data
        self.assertFalse(instagram.is_error(ig_record("stu", [], private=True, followers=3)))

    def test_window_full_warning(self):
        from collector import instagram
        camp = CFG.instagram_campaign
        now = ut(2026, 10, 12)
        times = [now - dt.timedelta(hours=3 * i) for i in range(12)]
        full = instagram.parse_profile(ig_record("stu", [ig_post(t) for t in times]), "stu", camp, now)
        self.assertTrue(instagram.window_full(full, set()))             # first sighting, nearly all inside the campaign
        self.assertFalse(instagram.window_full(full, {full["array_ids"][5]}))  # overlaps with what we stored
        self.assertTrue(instagram.window_full(full, {"1"}))             # stored posts, none in the list
        some = instagram.parse_profile(ig_record("stu", [ig_post(t) for t in times[:11]]), "stu", camp, now)
        self.assertFalse(instagram.window_full(some, set()))            # not full
        # Full, but many posts are older than the campaign (pinned or just an older account): no warning.
        old = [ig_post(ut(2026, 9, 1 + i)) for i in range(5)]
        mixed = instagram.parse_profile(ig_record("stu", old + [ig_post(t) for t in times[:7]]), "stu", camp, now)
        self.assertFalse(instagram.window_full(mixed, set()))

    def test_upsert_keeps_dropped_posts_and_the_first_time(self):
        from collector import instagram
        old = [{"post_id": "1", "handle": "a", "created_at": "2026-10-08T10:00:00Z", "post_type": "photo", "hashtags": "glu",
                "url": "u1", "first_seen": "t0", "last_seen": "t0"},
               {"post_id": "2", "handle": "a", "created_at": "2026-10-09T10:00:00Z", "post_type": "reel", "hashtags": "",
                "url": "u2", "first_seen": "t0", "last_seen": "t0"}]
        new = [{"post_id": "1", "handle": "a", "created_at": "2026-10-08T12:00:00Z", "post_type": "photo", "hashtags": "glu av", "url": "u1"},
               {"post_id": "3", "handle": "a", "created_at": "2026-10-10T10:00:00Z", "post_type": "carousel", "hashtags": "", "url": "u3"}]
        by = {r["post_id"]: r for r in instagram.upsert_posts(old, new, "t1")}
        self.assertEqual(sorted(by), ["1", "2", "3"])                      # post 2 left the list but stays
        self.assertEqual((by["1"]["first_seen"], by["1"]["last_seen"], by["1"]["hashtags"]), ("t0", "t1", "glu av"))
        self.assertEqual(by["1"]["created_at"], "2026-10-08T10:00:00Z")    # as first computed
        self.assertEqual((by["2"]["last_seen"], by["3"]["first_seen"]), ("t0", "t1"))

    def test_baseline_only_ever_grows(self):
        from collector import instagram
        have = [{"handle": "a", "baseline_at": "t0", "baseline_followers": 5}]
        snaps = [{"handle": "a", "followers": 50}, {"handle": "b", "followers": 7}, {"handle": "c", "followers": None}]
        rows = instagram.new_baselines(have, snaps, "t1")
        self.assertEqual(rows, [{"handle": "b", "baseline_at": "t1", "baseline_followers": 7}])
        self.assertEqual(instagram.new_baselines(have + rows, snaps, "t2"), [])


class FakeBothBrightData:
    """TikTok and Instagram profile records by dataset; remembers what was asked, per platform."""

    def __init__(self, tiktok=None, ig=None):
        self.tiktok, self.ig = tiktok or {}, ig or {}
        self.asked = {"tiktok": [], "instagram": []}
        self._last = None

    def trigger(self, dataset, inputs, **params):
        if dataset == CFG.instagram_dataset:
            self._last = ("instagram", [i["url"].rstrip("/").rsplit("/", 1)[1] for i in inputs])
        else:
            self._last = ("tiktok", [i["url"].split("@")[1] for i in inputs])
        self.asked[self._last[0]].append(self._last[1])
        return "sd_" + self._last[0]

    def wait(self, snapshot):
        return {"status": "ready", "records": len(self._last[1])}

    def download(self, snapshot):
        platform, handles = self._last
        source = self.ig if platform == "instagram" else self.tiktok
        return [source[h] for h in handles if h in source]


class InstagramRunTests(unittest.TestCase):
    NOW = dt.datetime(2026, 10, 12, 6, 10, tzinfo=UTC)   # 08:10 Amsterdam: TikTok 08u and Instagram ig-08u are open

    def setUp(self):
        accounts = [{"student_name": n, "tiktok_handle": h, "active": a, "main_account": "", "instagram_handle": i}
                    for n, h, a, i in [("A", "aa", "ja", "IG_AA"), ("B", "bb", "ja", "https://www.instagram.com/ig_bb/"),
                                       ("C", "cc", "ja", ""), ("D", "dd", "ja", "ig_dd"), ("E", "ee", "nee", "ig_ee")]]
        self.admin = FakeSheet({"accounts": accounts, "run_log": [], "profile_window": []})
        self.data = FakeSheet({})
        self.posts = {
            "ig_aa": [ig_post(ut(2026, 10, 11, 17, 45), "Video", "Nieuw #GLU #reel📷"), ig_post(ut(2026, 10, 9, 8, 0)),
                      ig_post(ut(2026, 9, 20, 8, 0))],            # the last one is older than the Instagram start day
            "ig_bb": [ig_post(ut(2026, 10, 12, 5, 30), "Carousel", "#av")],
            "ig_dd": [],
        }
        self.recs = {"ig_aa": ig_record("ig_aa", self.posts["ig_aa"], followers=100, following=40),
                     "ig_bb": ig_record("ig_bb", self.posts["ig_bb"], followers=20),
                     "ig_dd": ig_record("ig_dd", [], followers=8, private=True)}
        self.tt = {h: profile_record(h, [(str(800 + i), "2026-10-12T04:00:00.000Z", 40)]) for i, h in enumerate(["aa", "bb", "cc", "dd"])}
        self.bd = FakeBothBrightData(self.tt, self.recs)

    def col(self, now=None, dry=False, bd=True, cfg=CFG):
        return Collector(cfg, self.admin, self.data, self.bd if bd else None, dry_run=dry, now=now or self.NOW)

    def last_row(self):
        return self.admin.tabs["run_log"][-1]

    def test_dry_run_plans_the_cost_and_touches_nothing(self):
        self.col(dry=True).run_ig_profiles("2026-10-12/ig-manual-0810")
        row = self.last_row()
        self.assertEqual((row["run_type"], row["status"], row["dry_run"], row["expected_records"], row["actual_records"]),
                         ("ig_profiles", "dry-run", True, 3, 0))
        self.assertIn("would fetch 3 Instagram profile(s), 1 record each: @ig_aa, @ig_bb, @ig_dd", row["notes"])
        self.assertIn("budget: used this month 0 + this run max 3", row["notes"])
        self.assertEqual(self.bd.asked, {"tiktok": [], "instagram": []})
        self.assertFalse(any(t.startswith("ig_") for t in self.data.tabs), "a dry run creates no tabs")

    def test_real_run_stores_posts_history_baseline_and_status(self):
        self.col().run_ig_profiles("2026-10-12/ig-manual-0810")
        self.assertEqual(self.bd.asked["instagram"], [["ig_aa", "ig_bb", "ig_dd"]])   # one record per account, normalised handles
        row = self.last_row()
        self.assertEqual((row["run_type"], row["status"], row["expected_records"], row["actual_records"], row["errors"]),
                         ("ig_profiles", "ok", 3, 3, 0))
        posts = {r["post_id"]: r for r in self.data.tabs["ig_posts"]}
        self.assertEqual(len(posts), 3)   # the post before the start day is not stored
        reel = next(r for r in posts.values() if r["post_type"] == "reel")
        self.assertEqual((reel["handle"], reel["hashtags"], reel["created_at"]), ("ig_aa", "glu reel", "2026-10-11T17:45:00Z"))
        self.assertTrue(reel["url"].startswith("https://www.instagram.com/p/"))
        self.assertEqual(sorted(r["post_type"] for r in posts.values()), ["carousel", "photo", "reel"])
        self.assertTrue(set(self.data.tabs["ig_posts"][0]) >= {"post_id", "handle", "created_at", "post_type", "hashtags", "url", "first_seen", "last_seen"})
        self.assertFalse(any(k in self.data.tabs["ig_posts"][0] for k in ("likes", "comments", "views")))
        hist = {r["handle"]: r for r in self.data.tabs["ig_history"]}
        self.assertEqual((hist["ig_aa"]["followers"], hist["ig_aa"]["following"], hist["ig_aa"]["posts_count"], hist["ig_aa"]["campaign_posts"]), (100, 40, 3, 2))
        handles = {r["handle"]: r for r in self.data.tabs["ig_handles"]}
        self.assertEqual(sorted(handles), ["ig_aa", "ig_bb", "ig_dd"])
        self.assertEqual((handles["ig_aa"]["last_status"], handles["ig_dd"]["last_status"]), ("ok", "privé"))
        self.assertEqual(handles["ig_dd"]["status_since"], "2026-10-12T06:10:00Z")
        self.assertEqual({r["handle"]: r["baseline_followers"] for r in self.data.tabs["ig_baseline"]}, {"ig_aa": 100, "ig_bb": 20, "ig_dd": 8})
        self.assertIn("ig_outliers", self.data.tabs)   # created with the others (fixed tab ids)
        # No student names and no TikTok handles in any cell of the public Instagram tabs.
        cells = {str(v) for tab, rows in self.data.tabs.items() if tab.startswith("ig_") for row in rows for v in row.values()}
        self.assertEqual(cells & {"A", "B", "C", "D", "aa", "bb", "cc", "dd"}, set())
        self.assertFalse(any("tiktok" in c.lower() for c in cells))

    def test_second_run_adds_history_but_the_baseline_never_shifts(self):
        self.col().run_ig_profiles("2026-10-12/ig-manual-0810")
        self.recs["ig_aa"] = ig_record("ig_aa", self.posts["ig_aa"] + [ig_post(ut(2026, 10, 12, 9, 0), "Image", "#glu")], followers=130)
        self.recs["ig_zz"] = ig_record("ig_zz", [], followers=4)
        later = self.NOW + dt.timedelta(hours=4)
        self.col(now=later).run_ig_profiles("2026-10-12/ig-manual-1210")
        base = {r["handle"]: r for r in self.data.tabs["ig_baseline"]}
        self.assertEqual((base["ig_aa"]["baseline_followers"], base["ig_aa"]["baseline_at"]), (100, "2026-10-12T06:10:00Z"))
        self.assertEqual(len(self.data.tabs["ig_history"]), 6)
        self.assertEqual([r["followers"] for r in self.data.tabs["ig_history"] if r["handle"] == "ig_aa"], [100, 130])
        posts = [r for r in self.data.tabs["ig_posts"] if r["handle"] == "ig_aa"]
        self.assertEqual(len(posts), 3)
        self.assertEqual({r["first_seen"] for r in posts if r["post_type"] != "reel" or True} - {"2026-10-12T06:10:00Z", "2026-10-12T10:10:00Z"}, set())
        # A student added later gets a baseline of their own, at their own first measurement.
        self.admin.tabs["accounts"].append({"student_name": "Z", "tiktok_handle": "zz", "active": "ja", "main_account": "", "instagram_handle": "ig_zz"})
        self.col(now=later + dt.timedelta(hours=4)).run_ig_profiles("2026-10-12/ig-manual-1410")
        base = {r["handle"]: r for r in self.data.tabs["ig_baseline"]}
        self.assertEqual((base["ig_zz"]["baseline_followers"], base["ig_zz"]["baseline_at"]), (4, "2026-10-12T14:10:00Z"))
        self.assertEqual(base["ig_aa"]["baseline_followers"], 100)

    def test_not_found_and_private_get_the_tiktok_statuses(self):
        self.recs["ig_bb"] = {"error": "Profile does not exist", "error_code": "dead_page",
                              "input": {"url": "https://www.instagram.com/ig_bb/"}}
        del self.recs["ig_dd"]   # no record at all
        self.col().run_ig_profiles("2026-10-12/ig-manual-0810")
        row = self.last_row()
        self.assertEqual((row["status"], row["errors"], row["actual_records"]), ("partial", 2, 3))
        self.assertIn("@ig_bb failed: dead_page: Profile does not exist", row["notes"])
        self.assertIn("@ig_dd failed: no record returned", row["notes"])
        handles = {r["handle"]: r for r in self.data.tabs["ig_handles"]}
        self.assertTrue(handles["ig_bb"]["last_status"].startswith("fout"))
        self.assertEqual(model.status_kind(handles["ig_bb"]["last_status"]), "fout")
        self.assertEqual(handles["ig_bb"]["status_since"], "2026-10-12T06:10:00Z")
        # A failed account has no history row and no baseline (not a successful measurement).
        self.assertEqual([r["handle"] for r in self.data.tabs["ig_history"]], ["ig_aa"])
        self.assertEqual([r["handle"] for r in self.data.tabs["ig_baseline"]], ["ig_aa"])

    def test_issues_in_accounts_are_reported_without_names(self):
        self.admin.tabs["accounts"].append({"student_name": "Fay", "tiktok_handle": "ff", "active": "ja", "main_account": "",
                                            "instagram_handle": "https://www.instagram.com/p/xyz"})
        self.col().run_ig_profiles("2026-10-12/ig-manual-0810")
        self.assertIn("Instagram 'https://www.instagram.com/p/xyz' skipped", self.last_row()["notes"])
        self.assertNotIn("Fay", self.last_row()["notes"])

    def test_the_platforms_never_make_each_others_windows_skip(self):
        """08:10: TikTok 08u and Instagram ig-08u both run, once; at 04:10 only Instagram (TikTok runs 08u and 20u)."""
        self.col().auto()
        rows = {r["window"]: r for r in self.admin.tabs["run_log"]}
        self.assertEqual(set(rows), {"2026-10-12/08u", "2026-10-12/ig-08u"})
        self.assertEqual({r["status"] for r in rows.values()}, {"ok"})   # the TikTok run just before did not skip Instagram
        self.assertEqual((self.bd.asked["tiktok"], self.bd.asked["instagram"]), ([["aa", "bb", "cc", "dd"]], [["ig_aa", "ig_bb", "ig_dd"]]))
        self.col(now=self.NOW + dt.timedelta(minutes=20)).auto()          # same windows again: nothing
        self.assertEqual(len(self.admin.tabs["run_log"]), 2)
        self.col(now=dt.datetime(2026, 10, 13, 2, 10, tzinfo=UTC)).auto()   # 04:10 Amsterdam
        self.assertEqual([r["window"] for r in self.admin.tabs["run_log"][2:]], ["2026-10-13/ig-04u"])
        self.col(now=dt.datetime(2026, 10, 13, 8, 10, tzinfo=UTC)).auto()   # 10:10: a pool window, but in nobody's step
        self.assertEqual(len(self.admin.tabs["run_log"]), 3)

    def test_a_platform_set_to_off_has_no_scheduled_runs(self):
        import dataclasses
        cfg = dataclasses.replace(CFG, frequency={"tiktok": "12h", "instagram": "off"})
        self.col(cfg=cfg).auto()
        self.assertEqual([r["window"] for r in self.admin.tabs["run_log"]], ["2026-10-12/08u"])
        self.assertEqual(self.bd.asked["instagram"], [])

    def test_skip_after_a_recent_run_is_per_platform(self):
        def run(ts, run_type, ids="sd_x"):
            return {"timestamp": ts, "run_type": run_type, "window": "w-" + run_type, "dry_run": False, "snapshot_ids": ids, "status": "ok"}
        # A TikTok "Nu verversen" 10 minutes ago does not make the Instagram window skip ...
        self.admin.tabs["run_log"] = [run("2026-10-12T06:00:00Z", "force_refresh")]
        self.col().run_scheduled_ig_profiles("2026-10-12/ig-08u")
        self.assertEqual(self.last_row()["status"], "ok")
        # ... but a recent Instagram run does, while TikTok goes on.
        self.admin.tabs["run_log"] = [run("2026-10-12T05:40:00Z", "ig_force_refresh")]
        self.col().run_scheduled_ig_profiles("2026-10-12/ig-08u")
        row = self.last_row()
        self.assertEqual((row["status"], row["actual_records"]), ("skipped", 0))
        self.assertIn("SKIPPED: last Instagram run was 30 min ago", row["notes"])
        self.col().run_scheduled_profiles("2026-10-12/08u")
        self.assertEqual(self.last_row()["status"], "ok")
        # A partial check never counts as a full run.
        self.admin.tabs["run_log"] = [run("2026-10-12T06:05:00Z", "ig_today_check")]
        self.assertIsNone(model.last_profiles_run(self.admin.tabs["run_log"], model.IG_PROFILE_RUN_TYPES))
        # The finale windows never skip.
        self.admin.tabs["run_log"] = [run("2026-10-12T06:05:00Z", "ig_profiles")]
        self.col().run_scheduled_ig_profiles("2026-10-12/ig-finale-0810")
        self.assertEqual(self.last_row()["status"], "ok")

    def test_both_platforms_share_one_monthly_cap(self):
        used = CFG.monthly_cap - 2   # TikTok runs already used almost all of it
        self.admin.tabs["run_log"] = [{"timestamp": "2026-10-05T10:00:00Z", "run_type": "profiles", "window": "w", "dry_run": False,
                                       "actual_records": used, "status": "ok"}]
        self.col().run_ig_profiles("2026-10-12/ig-manual-0810")   # 3 records: does not fit in the 2 that are left
        row = self.last_row()
        self.assertEqual((row["status"], row["actual_records"]), ("refused", 0))
        self.assertIn("REFUSED: would exceed the monthly cap", row["notes"])
        self.assertEqual(self.bd.asked["instagram"], [])

    def test_force_refresh_has_its_own_cooldown(self):
        self.admin.tabs["run_log"] = [{"timestamp": "2026-10-12T06:00:00Z", "run_type": "ig_profiles", "window": "w", "dry_run": False,
                                       "snapshot_ids": "sd_x", "status": "ok"}]
        self.col().run_ig_force_refresh("2026-10-12/ig-force-0810")
        self.assertEqual(self.last_row()["status"], "refused")
        self.col().run_force_refresh("2026-10-12/force-0810")        # TikTok has not run: goes ahead
        self.assertEqual(self.last_row()["status"], "ok")

    def test_today_check_fetches_only_the_given_instagram_accounts(self):
        self.data.tabs["ig_handles"] = [{"handle": "ig_dd", "is_private": True}]
        self.col().run_ig_today_check("2026-10-12/ig-today-0810", ["ig_bb", "ig_dd", "nobody", "ig_ee"])
        self.assertEqual(self.bd.asked["instagram"], [["ig_bb"]])    # private, unknown and inactive accounts are not fetched
        row = self.last_row()
        self.assertEqual((row["run_type"], row["status"], row["expected_records"]), ("ig_today_check", "ok", 1))
        self.assertIn("not checked (inactive, unknown or private): @ig_dd, @nobody, @ig_ee", row["notes"])
        handles = {r["handle"]: r for r in self.data.tabs["ig_handles"]}
        self.assertEqual(sorted(handles), ["ig_aa", "ig_bb", "ig_dd"])    # every account keeps its row
        self.assertEqual([r["handle"] for r in self.data.tabs["ig_history"]], ["ig_bb"])

    def test_controleer_nu_fetches_both_platforms_in_one_command(self):
        # "Controleer nu" sends one list: TikTok handles bare, Instagram handles with the platform in front.
        run_today(self.col(), "aa, instagram:ig_aa ,@bb,ig:ig_bb,instagram:nobody")
        self.assertEqual(self.bd.asked, {"tiktok": [["aa", "bb"]], "instagram": [["ig_aa", "ig_bb"]]})
        rows = self.admin.tabs["run_log"]
        self.assertEqual([(r["run_type"], r["status"], r["expected_records"], r["actual_records"]) for r in rows],
                         [("today_check", "ok", 2, 2), ("ig_today_check", "ok", 2, 2)])
        self.assertIn("not checked (inactive, unknown or private): @nobody", rows[1]["notes"])
        # Neither counts as a full run: the scheduled runs are not skipped afterwards.
        self.assertIsNone(self.col().minutes_since_profiles())
        self.assertIsNone(self.col().minutes_since_profiles(model.IG_PROFILE_RUN_TYPES))

    def test_controleer_nu_with_only_instagram_accounts_runs_only_instagram(self):
        run_today(self.col(), "instagram:ig_dd")
        self.assertEqual(self.bd.asked, {"tiktok": [], "instagram": [["ig_dd"]]})
        self.assertEqual([r["run_type"] for r in self.admin.tabs["run_log"]], ["ig_today_check"])

    def test_controleer_nu_dry_run_plans_both_and_fetches_nothing(self):
        run_today(self.col(dry=True), "aa,instagram:ig_aa")
        self.assertEqual(self.bd.asked, {"tiktok": [], "instagram": []})
        rows = self.admin.tabs["run_log"]
        self.assertEqual([(r["run_type"], r["status"], r["dry_run"], r["expected_records"]) for r in rows],
                         [("today_check", "dry-run", True, 1), ("ig_today_check", "dry-run", True, 1)])

    def test_controleer_nu_failure_on_one_platform_does_not_stop_the_other(self):
        class TikTokDown(FakeBothBrightData):
            def trigger(self, dataset, inputs, **params):
                if dataset != CFG.instagram_dataset:
                    raise RuntimeError("TikTok profiles dataset is down")
                return super().trigger(dataset, inputs, **params)

        self.bd = TikTokDown(self.tt, self.recs)
        with self.assertRaises(RuntimeError):      # the workflow still ends red
            run_today(self.col(), "aa,instagram:ig_aa")
        rows = self.admin.tabs["run_log"]
        self.assertEqual([(r["run_type"], r["status"]) for r in rows], [("today_check", "failed"), ("ig_today_check", "ok")])
        self.assertIn("TikTok profiles dataset is down", rows[0]["notes"])
        self.assertEqual(self.bd.asked["instagram"], [["ig_aa"]])

    def test_reserve_counts_both_platforms_and_status_shows_them(self):
        by = self.col().reserve_by_platform()
        # From 08:10 on 12 Oct (the 08u windows are still open): TikTok 08u + 20u today and two a day to the 30th;
        # Instagram 08u, 12u, 16u, 20u today and six a day to the 30th.
        self.assertEqual(by["tiktok"][:2], (2 + 2 * 18, 4))
        self.assertEqual(by["instagram"][:2], (4 + 6 * 18, 3))
        self.assertEqual(self.col()._reserve(), (by["tiktok"][0] + by["instagram"][0], by["tiktok"][2] + by["instagram"][2]))
        import contextlib
        import io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.col().status()
        text = out.getvalue()
        self.assertIn("Instagram: 3 active handles, pulled 4h", text)
        self.assertIn("TikTok: 4 active handles, pulled 12h", text)
        self.assertIn("projected month total without refreshes:", text)

    def test_window_full_is_reported(self):
        times = [self.NOW - dt.timedelta(hours=2 * i) for i in range(12)]
        self.recs["ig_aa"] = ig_record("ig_aa", [ig_post(t) for t in times])
        self.col().run_ig_profiles("2026-10-12/ig-manual-0810")
        self.assertIn("post list full (12) without overlap with stored posts, posts may be missing for: @ig_aa", self.last_row()["notes"])


class FakeSheetsSession:
    """In-memory stand-in for the Google Sheets REST API (just the calls collector/sheets.py makes), so the
    real Spreadsheet class runs: tab creation with fixed tab ids, headers, append, rewrite, read."""

    class Resp:
        def __init__(self, data):
            self.status_code, self._data = 200, data
            self.content = b"x" if data else b""
            self.text = ""

        def json(self):
            return self._data

    def __init__(self, tabs=None):
        self.tabs = {title: {"id": 100 + i, "rows": [list(r) for r in rows]} for i, (title, rows) in enumerate((tabs or {}).items())}
        self.frozen = set()

    def request(self, method, url, timeout=None, params=None, json=None):
        import re
        path = re.match(r"^[^/:]+(.*)$", url.split("/spreadsheets/", 1)[1]).group(1).split("?")[0]  # after the id
        if method == "GET" and path == "":
            return self.Resp({"sheets": [{"properties": {"sheetId": t["id"], "title": n}} for n, t in self.tabs.items()]})
        if path == ":batchUpdate":
            for req in json["requests"]:
                if "addSheet" in req:
                    props = req["addSheet"]["properties"]
                    assert props["title"] not in self.tabs
                    ids = {t["id"] for t in self.tabs.values()}
                    new_id = props.get("sheetId", max(ids | {0}) + 1)
                    assert new_id not in ids, "tab id already used"
                    self.tabs[props["title"]] = {"id": new_id, "rows": []}
                elif "updateSheetProperties" in req:
                    props = req["updateSheetProperties"]["properties"]
                    tab = next(n for n, t in self.tabs.items() if t["id"] == props["sheetId"])
                    if "title" in props:
                        self.tabs[props["title"]] = self.tabs.pop(tab)
                    else:
                        self.frozen.add(tab)
            return self.Resp({})
        if method == "GET" and path.endswith("!1:1"):   # the header row
            rows = self.tabs[re.match(r"/values/'([^']+)'", path).group(1)]["rows"]
            return self.Resp({"values": rows[:1]} if rows else {})
        m = re.match(r"/values/'([^']+)'(?:!([A-Z]+)(\d*)(?::[A-Z]+\d*)?)?(:append|:clear)?$", path)
        assert m, path
        tab, col, row, action = m.group(1), m.group(2), m.group(3), m.group(4)
        rows = self.tabs[tab]["rows"]
        if method == "GET":
            return self.Resp({"values": rows} if rows else {})
        if action == ":append":
            rows.extend([list(r) for r in json["values"]])
            return self.Resp({})
        if action == ":clear":
            del rows[int(row) - 1:]
            return self.Resp({})
        start, c0 = int(row) - 1, ord(col[0]) - 65   # PUT
        for i, values in enumerate(json["values"]):
            while len(rows) <= start + i:
                rows.append([])
            target = rows[start + i]
            while len(target) < c0 + len(values):
                target.append("")
            target[c0:c0 + len(values)] = values
        return self.Resp({})


class InstagramSheetsEndToEndTests(unittest.TestCase):
    """The first real Instagram run creates the ig_* tabs with their fixed ids; later runs reuse them."""
    NOW = dt.datetime(2026, 10, 12, 6, 10, tzinfo=UTC)

    def test_first_run_creates_the_tabs_with_fixed_ids_and_the_second_run_reuses_them(self):
        from collector.sheets import Spreadsheet
        header = ["student_name", "tiktok_handle", "active", "main_account", "instagram_handle"]
        admin_session = FakeSheetsSession({"accounts": [header, ["A", "aa", "ja", "", "Ig_Aa"], ["B", "bb", "ja", "", ""],
                                                        ["C", "cc", "ja", "", "https://www.instagram.com/ig_cc/"]],
                                           "run_log": [model.SCHEMA_ADMIN["run_log"]], "profile_window": [model.SCHEMA_ADMIN["profile_window"]]})
        data_session = FakeSheetsSession({"handles": [model.SCHEMA_DATA["handles"]]})
        admin, data = Spreadsheet(admin_session, "admin"), Spreadsheet(data_session, "data")
        recs = {"ig_aa": ig_record("ig_aa", [ig_post(ut(2026, 10, 11, 17, 45), "Video", "#glu")], followers=100),
                "ig_cc": ig_record("ig_cc", [], followers=8, private=True)}
        bd = FakeBothBrightData(ig=recs)
        Collector(CFG, admin, data, bd, now=self.NOW).run_ig_profiles("2026-10-12/ig-manual-0810")
        # The tabs exist, with the ids the website knows and the schema's headers, frozen header row.
        for tab in ("ig_handles", "ig_history", "ig_posts", "ig_baseline", "ig_outliers"):
            self.assertEqual(data_session.tabs[tab]["id"], model.FIXED_SHEET_IDS[tab], tab)
            self.assertEqual(data_session.tabs[tab]["rows"][0], model.SCHEMA_DATA[tab], tab)
            self.assertIn(tab, data_session.frozen)
        log = admin_session.tabs["run_log"]["rows"]
        self.assertEqual([log[1][1], log[1][7], log[1][5]], ["ig_profiles", "ok", 2])
        # Post ids stay text (they are 19 digits, more than a spreadsheet number can hold).
        posts = data_session.tabs["ig_posts"]["rows"]
        self.assertEqual(len(posts), 2)
        self.assertIsInstance(posts[1][0], str)
        self.assertEqual(posts[1][0], ig_id(ut(2026, 10, 11, 17, 45)))
        # Second run, 4 hours later: tabs reused (no second creation), history grows, baseline stays.
        recs["ig_aa"]["followers"] = 130
        Collector(CFG, admin, data, bd, now=self.NOW + dt.timedelta(hours=4)).run_ig_profiles("2026-10-12/ig-manual-1210")
        self.assertEqual(len(data_session.tabs["ig_history"]["rows"]), 1 + 4)
        self.assertEqual(len(data_session.tabs["ig_posts"]["rows"]), 2)
        base = {r[0]: r for r in data_session.tabs["ig_baseline"]["rows"][1:]}
        self.assertEqual((base["ig_aa"][2], base["ig_cc"][2]), (100, 8))
        handles = {r[0]: r for r in data_session.tabs["ig_handles"]["rows"][1:]}
        self.assertEqual(handles["ig_aa"][2], 130)
        self.assertEqual(sorted(handles), ["ig_aa", "ig_cc"])
        # The tab ids were created once: a third tab with the same fixed id would have been refused by the API.
        self.assertEqual(len({t["id"] for t in data_session.tabs.values()}), len(data_session.tabs))


class FrequencyConfigTests(unittest.TestCase):
    def test_every_step_is_a_set_of_hourly_windows_from_the_pool(self):
        pool = [w.name for w in CFG.profile_windows]
        self.assertEqual(len(pool), 12)
        for step in config.FREQUENCY_STEPS:
            names = [w.name for w in CFG.platform_windows("tiktok", step)]
            self.assertTrue(names and set(names) <= set(pool), step)
            self.assertEqual(names, [n for n in pool if n in names], "in clock order")
            ig = [w.name for w in CFG.platform_windows("instagram", step)]
            self.assertEqual(ig, ["ig-" + n for n in names])
        counts = {s: len(CFG.platform_windows("tiktok", s)) for s in config.FREQUENCY_STEPS}
        self.assertEqual(counts, {"daily": 1, "12h": 2, "6h": 4, "4h": 6, "2h": 12})
        # Each step is evenly spaced, so "every N hours" really is.
        for step, n in (("12h", 12), ("6h", 6), ("4h", 4), ("2h", 2)):
            hours = [w.start.hour for w in CFG.platform_windows("tiktok", step)]
            self.assertEqual({(b - a) % 24 for a, b in zip(hours, hours[1:] + hours[:1])}, {n}, step)
        self.assertEqual(CFG.platform_windows("tiktok", "off"), ())

    def test_start_values_and_window_keys(self):
        self.assertEqual(CFG.frequency, {"tiktok": "12h", "instagram": "4h"})
        day = dt.date(2026, 10, 12)
        self.assertEqual([w.key(day) for w in CFG.platform_windows("tiktok")], ["2026-10-12/08u", "2026-10-12/20u"])   # teachers check in the morning
        self.assertEqual([w.key(day) for w in CFG.platform_windows("instagram")][:2], ["2026-10-12/ig-00u", "2026-10-12/ig-04u"])
        self.assertTrue({w.key(day) for w in CFG.platform_windows("tiktok")}.isdisjoint({w.key(day) for w in CFG.platform_windows("instagram")}))

    def test_the_page_and_worker_get_the_steps_to_work_out_any_choice(self):
        from collector import worker_config
        built = worker_config.build(CFG)
        self.assertEqual(built["frequency"], {"tiktok": "12h", "instagram": "4h"})
        self.assertEqual(list(built["frequencySteps"]), list(config.FREQUENCY_STEPS))
        self.assertEqual(built["frequencySteps"]["12h"], ["08u", "20u"])
        pool = {w["name"] for w in built["schedule"]["profileRuns"]}
        self.assertTrue(all(set(names) <= pool for names in built["frequencySteps"].values()))

    def test_a_typo_in_the_frequency_settings_fails_loudly(self):
        pool = CFG.profile_windows
        good = {"tiktok": "12h", "instagram": "off", "steps": {"12h": ["08u", "20u"]}}
        config._frequency(good, pool)
        for bad in [{**good, "tiktok": "13h"}, {**good, "steps": {"12h": ["08u", "21u"]}},
                    {**good, "steps": {"every-now-and-then": ["08u"]}}, {**good, "steps": {"12h": []}}]:
            with self.assertRaises(ValueError, msg=str(bad)):
                config._frequency(bad, pool)


class FakeBilledBrightData(FakeBrightData):
    """Also reports how many rows Bright Data says it billed this month (None = unreadable)."""

    def __init__(self, billed):
        super().__init__({})
        self.billed = billed

    def billed_rows_this_month(self):
        return self.billed


class BillingTests(unittest.TestCase):
    """The cap is enforced on what Bright Data bills, not only on what run_log knows about."""
    NOW = dt.datetime(2026, 10, 9, 14, 0, tzinfo=UTC)

    def collector(self, logged, billed, dry=False):
        rows = [{"timestamp": "2026-10-05T10:00:00Z", "run_type": "profiles", "window": "w1", "dry_run": False,
                 "actual_records": logged, "status": "ok"},
                {"timestamp": "2026-10-05T11:00:00Z", "run_type": "profiles", "window": "w2", "dry_run": True,
                 "actual_records": 999, "status": "dry-run"},                      # dry runs never count
                {"timestamp": "2026-09-30T11:00:00Z", "run_type": "profiles", "window": "w0", "dry_run": False,
                 "actual_records": 999, "status": "ok"}]                           # another month
        self.admin = FakeSheet({"run_log": rows})
        return Collector(CFG, self.admin, FakeSheet({}), FakeBilledBrightData(billed), dry_run=dry, now=self.NOW)

    def test_an_unlogged_job_is_counted_and_booked_once(self):
        col = self.collector(logged=100, billed=130)
        run = RunResultFor()
        self.assertEqual(col.month_used(run), 130)
        row = self.admin.tabs["run_log"][-1]
        self.assertEqual((row["run_type"], row["actual_records"], row["dry_run"]), ("billing_adjustment", 30, False))
        self.assertIn("billed 130 rows", run.notes[0])
        # Everything that adds up run_log (the Worker's checks too) now sees 130, and a second look books nothing.
        self.assertEqual(model.month_usage(self.admin.tabs["run_log"], self.NOW), 130)
        self.assertEqual(col.month_used(), 130)
        self.assertEqual(len(self.admin.tabs["run_log"]), 4)

    def test_never_lowers_the_count(self):
        col = self.collector(logged=100, billed=90)   # run_log counts rows Bright Data did not bill: keep the higher
        self.assertEqual(col.month_used(), 100)
        self.assertEqual(len(self.admin.tabs["run_log"]), 3)

    def test_unreadable_usage_falls_back_to_run_log_and_says_so(self):
        col = self.collector(logged=100, billed=None)
        run = RunResultFor()
        self.assertEqual(col.month_used(run), 100)
        self.assertIn("billing check unavailable", run.notes[0])
        self.assertEqual(len(self.admin.tabs["run_log"]), 3)

    def test_dry_run_and_status_count_it_but_book_nothing(self):
        col = self.collector(logged=100, billed=130, dry=True)
        self.assertEqual(col.month_used(), 130)
        self.assertEqual(len(self.admin.tabs["run_log"]), 3)
        col = self.collector(logged=100, billed=130)
        self.assertEqual(col.month_used(write=False), 130)
        self.assertEqual(len(self.admin.tabs["run_log"]), 3)

    def test_cap_refuses_on_the_billed_figure(self):
        col = self.collector(logged=100, billed=CFG.monthly_cap - 10)
        run = RunResultFor(expected=20)
        self.assertFalse(col.budget_ok(run))
        self.assertEqual(run.status, "refused")
        # The same run fits when Bright Data really billed what run_log says.
        col = self.collector(logged=100, billed=100)
        run = RunResultFor(expected=20)
        self.assertTrue(col.budget_ok(run))

    def test_usage_endpoint_parsing(self):
        from collector.brightdata import BrightData

        class Resp:
            def __init__(self, status, body):
                self.status_code, self._body = status, body

            def json(self):
                if isinstance(self._body, Exception):
                    raise self._body
                return self._body

        class Session:
            headers = {}

            def __init__(self, resp):
                self.resp = resp

            def get(self, url, timeout):
                if isinstance(self.resp, Exception):
                    raise self.resp
                return self.resp

        usage = {"cust": {"from": "x", "sums": {
            "ds_a": {"back_m0": {"rows_initial_billable": 5600, "sets_initial_billable": 100}, "back_m1": {"rows_initial_billable": 7}},
            "ds_b": {"back_m0": {"rows_initial_billable": 125}},
            "ds_c": {"back_d0": {"rows_initial_billable": 3}}}}}                       # no month figure: counts 0
        self.assertEqual(BrightData(session=Session(Resp(200, usage))).billed_rows_this_month(), 5725)
        for bad in [Resp(403, {}), Resp(200, ValueError("not json")), Resp(200, ["unexpected"]),
                    __import__("requests").ConnectionError("down")]:
            self.assertIsNone(BrightData(session=Session(bad)).billed_rows_this_month())


class FrequencySettingTests(unittest.TestCase):
    """The pull frequency chosen on Beheer (private settings tab) over the config.yaml start value."""

    # 10:10 Amsterdam: the TikTok 08u/20u windows and the Instagram 4-hourly windows are all closed.
    MORNING = dt.datetime(2026, 10, 12, 8, 10, tzinfo=UTC)

    def setting(self, tiktok=None, instagram=None, extra=()):
        rows = [{"key": k, "value": v, "updated_at": "", "updated_by": ""} for k, v in
                (("frequency_tiktok", tiktok), ("frequency_instagram", instagram)) if v is not None]
        return [*extra, *rows]

    def collector(self, settings=None, now=None, **tabs):
        admin = FakeSheet({"run_log": [], "accounts": [], **({"settings": settings} if settings is not None else {}), **tabs})
        col = Collector(CFG, admin, FakeSheet({}), bd=None, now=now or self.MORNING)
        col.apply_settings()
        return col, admin

    def windows_run(self, admin):
        return [r["window"] for r in admin.tabs["run_log"]]

    def test_parse(self):
        steps = CFG.frequency_steps
        self.assertEqual(config.parse_frequency_settings(self.setting("6h", "OFF"), steps), ({"tiktok": "6h", "instagram": "off"}, []))
        # Other settings are not ours; the last row of a key counts; nothing set = nothing returned.
        rows = self.setting("2h", extra=[{"key": "school_hashtags", "value": "glu"}, {"key": "frequency_tiktok", "value": "daily"}])
        self.assertEqual(config.parse_frequency_settings(rows, steps)[0], {"tiktok": "2h"})
        self.assertEqual(config.parse_frequency_settings([], steps), ({}, []))
        self.assertEqual(config.parse_frequency_settings(None), ({}, []))
        # A value that is not a known step is reported and ignored (also an empty cell), never raised.
        found, problems = config.parse_frequency_settings(self.setting("13h", ""), steps)
        self.assertEqual(found, {})
        self.assertEqual(len(problems), 2)
        self.assertIn("frequency_tiktok", problems[0])
        # A later bad value does not keep an earlier good one alive: the start value is used instead.
        found, _ = config.parse_frequency_settings([{"key": "frequency_tiktok", "value": "4h"}, {"key": "frequency_tiktok", "value": "often"}], steps)
        self.assertEqual(found, {})
        # A step the config does not define is refused too.
        self.assertEqual(config.parse_frequency_settings(self.setting("6h"), {"12h": ("08u", "20u")})[0], {})

    def test_with_frequency_and_platform_on(self):
        cfg = config.with_frequency(CFG, {"tiktok": "off", "instagram": "2h"})
        self.assertEqual(cfg.frequency, {"tiktok": "off", "instagram": "2h"})
        self.assertEqual((cfg.platform_on("tiktok"), cfg.platform_on("instagram")), (False, True))
        self.assertEqual(cfg.platform_windows("tiktok"), ())
        self.assertEqual(len(cfg.platform_windows("instagram")), 12)
        self.assertEqual(CFG.frequency, {"tiktok": "12h", "instagram": "4h"}, "the loaded config is not changed")
        self.assertEqual(config.with_frequency(CFG, {}).frequency, CFG.frequency)

    def test_apply_settings_replaces_the_start_values_for_the_run(self):
        col, _ = self.collector(self.setting("off", "2h"))
        self.assertEqual(col.cfg.frequency, {"tiktok": "off", "instagram": "2h"})
        # The budget reservation follows the same setting: no TikTok runs left, 8 Instagram windows today
        # (08u is still open at 08:10... here 10u onwards) plus 12 per day until the end of collection.
        by = col.reserve_by_platform()
        self.assertEqual(by["tiktok"][0], 0)
        today_left = len([w for w in col.cfg.platform_windows("instagram") if w.end > col.now_local.time()])
        days_left = (CFG.campaign.collect_until - col.now_local.date()).days
        self.assertEqual(by["instagram"][0], today_left + days_left * 12)

    def test_without_the_tab_or_with_garbage_the_start_values_stay(self):
        col, _ = self.collector(None)
        self.assertEqual(col.cfg.frequency, CFG.frequency)
        col, _ = self.collector(self.setting("sometimes", "whenever"))
        self.assertEqual(col.cfg.frequency, CFG.frequency)
        col, _ = self.collector(self.setting(None, "6h"))
        self.assertEqual(col.cfg.frequency, {"tiktok": "12h", "instagram": "6h"}, "one platform set, the other keeps its start value")

    def test_auto_runs_the_windows_of_the_chosen_step(self):
        # Start values: nothing is open at 10:10. Instagram every 2 hours: its 10u window is.
        col, admin = self.collector(None)
        col.auto()
        self.assertEqual(self.windows_run(admin), [])
        col, admin = self.collector(self.setting(None, "2h"))
        col.auto()
        self.assertEqual(self.windows_run(admin), ["2026-10-12/ig-10u"])
        # TikTok every 2 hours as well: both platforms run their own window, TikTok first.
        col, admin = self.collector(self.setting("2h", "2h"))
        col.auto()
        self.assertEqual(self.windows_run(admin), ["2026-10-12/10u", "2026-10-12/ig-10u"])

    def test_auto_does_nothing_for_a_platform_that_is_off(self):
        at_8 = dt.datetime(2026, 10, 12, 6, 10, tzinfo=UTC)   # 08:10: TikTok 08u and Instagram ig-08u are open at the start values
        col, admin = self.collector(None, now=at_8)
        col.auto()
        self.assertEqual(self.windows_run(admin), ["2026-10-12/08u", "2026-10-12/ig-08u"])
        for tiktok, instagram, expected in (("off", None, ["2026-10-12/ig-08u"]), (None, "off", ["2026-10-12/08u"]), ("off", "off", [])):
            col, admin = self.collector(self.setting(tiktok, instagram), now=at_8)
            col.auto()
            self.assertEqual(self.windows_run(admin), expected, (tiktok, instagram))

    def test_nu_verversen_skips_a_platform_that_is_off_and_says_so(self):
        col, admin = self.collector(self.setting("off", None))
        col.run_force_refresh("2026-10-12/force-1010")
        col.run_ig_force_refresh("2026-10-12/ig-force-1010")
        tiktok, instagram = admin.tabs["run_log"]
        self.assertEqual((tiktok["run_type"], tiktok["status"], tiktok["actual_records"]), ("force_refresh", "skipped", 0))
        self.assertIn("SKIPPED: tiktok is set to off", tiktok["notes"])
        self.assertEqual(instagram["run_type"], "ig_force_refresh")
        self.assertNotIn("set to off", instagram["notes"])        # Instagram is on: it ran (here without accounts)
        col, admin = self.collector(self.setting(None, "off"))
        col.run_ig_force_refresh("2026-10-12/ig-force-1010")
        self.assertEqual((admin.tabs["run_log"][0]["status"], "set to off" in admin.tabs["run_log"][0]["notes"]), ("skipped", True))

    def test_controleer_nu_skips_a_platform_that_is_off(self):
        accounts = [{"student_name": "A", "tiktok_handle": "aa", "active": "ja", "main_account": "", "instagram_handle": "ig_aa"}]
        bd = FakeBothBrightData({"aa": profile_record("aa", [("1", "2026-10-12T04:00:00.000Z", 40)])},
                                {"ig_aa": ig_record("ig_aa", [ig_post(ut(2026, 10, 12, 5, 30))], followers=5)})
        for tiktok, instagram, asked in (("off", None, {"tiktok": [], "instagram": [["ig_aa"]]}),
                                         (None, "off", {"tiktok": [["aa"]], "instagram": []}),
                                         ("off", "off", {"tiktok": [], "instagram": []})):
            bd.asked = {"tiktok": [], "instagram": []}
            admin = FakeSheet({"run_log": [], "accounts": accounts, "profile_window": [], "settings": self.setting(tiktok, instagram)})
            col = Collector(CFG, admin, FakeSheet({}), bd, now=self.MORNING)
            col.apply_settings()
            run_today(col, "aa,instagram:ig_aa")
            self.assertEqual(bd.asked, asked, (tiktok, instagram))
            rows = {r["run_type"]: r for r in admin.tabs["run_log"]}
            self.assertEqual(set(rows), {"today_check", "ig_today_check"}, "each platform leaves its own row")
            for run_type, platform, off in (("today_check", "tiktok", tiktok == "off"), ("ig_today_check", "instagram", instagram == "off")):
                self.assertEqual(rows[run_type]["status"] == "skipped" and f"SKIPPED: {platform} is set to off" in rows[run_type]["notes"], off, run_type)

    def test_weekly_refresh_is_a_tiktok_pull_and_stops_with_tiktok(self):
        friday = dt.datetime(2026, 10, 16, 6, 40, tzinfo=UTC)   # 08:40 Amsterdam: inside the weekrefresh window
        col, admin = self.collector(self.setting("off", None), now=friday)
        col.auto()
        refresh = [r for r in admin.tabs["run_log"] if r["run_type"] == "posts_refresh"]
        self.assertEqual([(r["status"], r["window"]) for r in refresh], [("skipped", "2026-10-16/weekrefresh")])
        self.assertIn("SKIPPED: tiktok is set to off", refresh[0]["notes"])
        # With TikTok on it plans normally (no accounts here, so nothing to refresh: also skipped, but not because of "off").
        col, admin = self.collector(self.setting("12h", None), now=friday)
        col.auto()
        refresh = [r for r in admin.tabs["run_log"] if r["run_type"] == "posts_refresh"]
        self.assertNotIn("set to off", refresh[0]["notes"])

    def test_finale_has_no_runs_for_a_platform_that_is_off(self):
        row = {"started_at": "2026-10-26T13:00:00Z", "started_by": "x@y.nl", "deadline": "2026-10-26T15:00:00Z",
               "status": "active", "ended_at": "", "ended_by": ""}
        now = dt.datetime(2026, 10, 26, 14, 5, tzinfo=UTC)
        for tiktok, instagram, expected in ((None, None, {"2026-10-26/finale-1500", "2026-10-26/ig-finale-1500"}),
                                            ("off", None, {"2026-10-26/ig-finale-1500"}),
                                            (None, "off", {"2026-10-26/finale-1500"}), ("off", "off", set())):
            col, admin = self.collector(self.setting(tiktok, instagram), now=now, finale=[row])
            col.auto()
            self.assertEqual(set(self.windows_run(admin)), expected, (tiktok, instagram))


class JobSummaryTests(unittest.TestCase):
    """Test output stays out of the Collect workflow's job summary; the real run still writes to it."""

    def test_tests_do_not_see_the_job_summary(self):
        # In Actions the variable is set for the whole job; tests/__init__.py removes it before any test runs.
        self.assertNotIn("GITHUB_STEP_SUMMARY", os.environ)

    def test_summary_still_writes_when_actions_sets_it(self):
        from collector.runner import summary
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "summary.md"
            with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(path)}):
                summary("**profiles** ok")
            self.assertEqual(path.read_text(encoding="utf-8"), "**profiles** ok\n\n")


def RunResultFor(expected=0):
    from collector.runner import RunResult
    res = RunResult("profiles", "w", False)
    res.expected = expected
    return res


if __name__ == "__main__":
    unittest.main()
