"""Run types: profiles (every 2 hours), the Vandaag check (part of the accounts, on demand), weekly
posts refresh, one-time window check, and the scheduler."""

from __future__ import annotations

import datetime as dt
import logging
import os
from dataclasses import dataclass, field

from . import model
from .brightdata import BrightData
from .config import UTC, Config
from .handles import account_groups, parse_accounts, profile_url
from .sheets import Spreadsheet

log = logging.getLogger(__name__)


@dataclass
class RunResult:
    run_type: str
    window: str
    dry_run: bool
    expected: int = 0
    actual: int = 0
    errors: int = 0
    status: str = "ok"
    snapshot_ids: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def row(self, now: str) -> dict:
        notes = " | ".join(self.notes)
        return {
            "timestamp": now, "run_type": self.run_type, "window": self.window, "dry_run": self.dry_run,
            "expected_records": self.expected, "actual_records": self.actual, "errors": self.errors,
            "status": self.status, "snapshot_ids": ",".join(self.snapshot_ids),
            "notes": notes[:45000],  # a sheet cell holds at most 50k characters
        }


def summary(text: str) -> None:
    """Print to the log and, in GitHub Actions, to the job summary. Only handles and counts, never names."""
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text + "\n\n")


class Collector:
    def __init__(self, cfg: Config, admin: Spreadsheet, data: Spreadsheet, bd: BrightData | None,
                 dry_run: bool = False, now: dt.datetime | None = None):
        self.cfg = cfg
        self.admin = admin
        self.data = data
        self.bd = bd
        self.dry_run = dry_run
        self.now_utc = (now or dt.datetime.now(UTC)).astimezone(UTC)
        self.now_local = self.now_utc.astimezone(cfg.tz)
        self.stamp = model.iso(self.now_utc)

    # ---------- shared helpers ----------

    def accounts(self) -> tuple[list[str], list[str]]:
        return parse_accounts(self.admin.read("accounts"))

    def log_run(self, res: RunResult) -> None:
        self.admin.append("run_log", [res.row(self.stamp)])
        summary(f"**{res.run_type}** `{res.window}` status={res.status} dry_run={res.dry_run} "
                f"expected={res.expected} actual={res.actual} errors={res.errors}"
                + (f"\n\n- " + "\n- ".join(res.notes) if res.notes else ""))

    def month_used(self, res: RunResult | None = None, write: bool = True) -> int:
        """Records used this calendar month (UTC), never lower than what Bright Data bills.

        run_log is the ledger, but a job that never reached it (a crash between the job and its log row,
        a test started by hand) is billed all the same. So the figure is the larger of run_log and the rows
        Bright Data itself reports as billed this month. The difference is booked as a billing_adjustment
        row, so everything that adds up run_log (this cap check, the Worker's finale and Controleer nu
        checks, the budget bar on Beheer) sees it. It only ever raises the count, never lowers it."""
        logged = model.month_usage(self.admin.read("run_log"), self.now_utc)
        probe = getattr(self.bd, "billed_rows_this_month", None)
        if probe is None:
            return logged
        billed = probe()
        if billed is None:
            if res:
                res.notes.append("billing check unavailable (Bright Data usage not readable): counting run_log only")
            return logged
        gap = billed - logged
        if gap <= 0:
            return logged
        note = f"billing: Bright Data billed {billed} rows this month, run_log has {logged}: counting {gap} more"
        if res:
            res.notes.append(note)
        if write and not self.dry_run:
            self.admin.append("run_log", [{
                "timestamp": self.stamp, "run_type": "billing_adjustment",
                "window": f"{self.now_local:%Y-%m-%d}/billing-{self.now_local:%H%M}", "dry_run": False,
                "expected_records": 0, "actual_records": gap, "errors": 0, "status": "ok", "snapshot_ids": "",
                "notes": note}])
        return billed

    def budget_ok(self, res: RunResult, reserve: int = 0) -> bool:
        used = self.month_used(res)
        total = used + res.expected + reserve
        res.notes.append(f"budget: used this month {used} + this run max {res.expected}"
                         + (f" + reserved for remaining profile runs {reserve}" if reserve else "")
                         + f" = {total} / cap {self.cfg.monthly_cap}")
        if total > self.cfg.monthly_cap:
            res.status = "refused"
            res.notes.append("REFUSED: would exceed the monthly cap")
            return False
        return True

    def collect(self, res: RunResult, dataset: str, inputs: list[dict], **params) -> list[dict] | None:
        """Trigger, wait and download. Records used are counted even when the job fails."""
        snapshot = self.bd.trigger(dataset, inputs, **params)
        res.snapshot_ids.append(snapshot)
        prog = self.bd.wait(snapshot)
        res.actual += int(prog.get("records") or 0)
        if prog.get("status") != "ready":
            res.status = "failed"
            res.notes.append(f"snapshot {snapshot} ended with status {prog.get('status')}")
            return None
        return self.bd.download(snapshot)

    def save_posts(self, videos: list[dict], source: str,
                   seen: dict[str, tuple[set[str], str]] | None = None) -> tuple[list[dict], list[str]]:
        """Upsert into posts_latest; with seen (profile runs) also flag videos missing from the window.
        Also appends post_history rows (see model.post_history_rows)."""
        self.data.ensure_columns("posts_latest", model.SCHEMA_DATA["posts_latest"])
        merged = model.upsert_posts(self.data.read("posts_latest"), videos, self.stamp, source)
        missing = model.mark_missing(merged, seen, self.stamp) if seen else []
        history = model.post_history_rows(merged, self.stamp, self.cfg.campaign)
        if history:
            # History first: if posts_latest fails after this, the next run only repeats a row.
            self.data.ensure_tabs({"post_history": model.SCHEMA_DATA["post_history"]})
            self.data.append("post_history", history)
        self.data.rewrite("posts_latest", merged)
        self.post_history_written = len(history)
        return merged, missing

    def append_history(self, handles: list[str], posts: list[dict]) -> None:
        followers = {r["handle"]: r.get("followers") for r in self.data.read("handles")}
        totals = model.campaign_totals(posts, self.cfg.campaign)
        rows = []
        for handle in handles:
            t = totals.get(handle, {"total_views": 0, "campaign_likes": 0, "campaign_posts": 0})
            rows.append({"timestamp": self.stamp, "handle": handle, "followers": followers.get(handle, ""), **t})
        self.data.append("history", rows)

    def run_guarded(self, res: RunResult, body) -> RunResult:
        """Run body(res); always write a run_log row, also when something crashes."""
        try:
            body(res)
        except Exception as exc:  # noqa: BLE001 - log every failure, then re-raise
            res.status = "failed"
            res.notes.append(f"error: {type(exc).__name__}: {str(exc)[:500]}")
            self.log_run(res)
            raise
        self.log_run(res)
        return res

    # ---------- profiles ----------

    def run_profiles(self, window: str) -> RunResult:
        return self.run_guarded(RunResult("profiles", window, self.dry_run), self._profiles)

    def run_force_refresh(self, window: str) -> RunResult:
        return self.run_guarded(RunResult("force_refresh", window, self.dry_run), self._force_refresh)

    def minutes_since_profiles(self) -> float | None:
        last = model.last_profiles_run(self.admin.read("run_log"))
        return None if last is None else (self.now_utc - last).total_seconds() / 60

    def _force_refresh(self, res: RunResult) -> None:
        """On-demand profiles run; refused when a real profiles run happened too recently (double tap)."""
        minutes = self.minutes_since_profiles()
        if minutes is not None and minutes < self.cfg.force_min_minutes:
            res.status = "refused"
            res.notes.append(f"REFUSED: last profiles run was {minutes:.0f} min ago "
                             f"(minimum {self.cfg.force_min_minutes} min between runs)")
            return
        self._profiles(res)

    def run_scheduled_profiles(self, window: str) -> RunResult:
        return self.run_guarded(RunResult("profiles", window, self.dry_run), self._scheduled_profiles)

    def _scheduled_profiles(self, res: RunResult) -> None:
        """Scheduled profiles run; skipped (window done, 0 records) right after a real profiles run,
        e.g. a "Nu verversen" shortly before a window. Later posts come in the next run.
        Finale windows (every 15 min on the last day) never skip."""
        finale = "/finale-" in res.window
        minutes = None if finale else self.minutes_since_profiles()
        if minutes is not None and minutes < self.cfg.skip_recent_minutes:
            res.status = "skipped"
            res.notes.append(f"SKIPPED: last profiles run was {minutes:.0f} min ago "
                             f"(scheduled runs skip within {self.cfg.skip_recent_minutes} min)")
            return
        self._profiles(res)

    def run_today_check(self, window: str, handles: list[str]) -> RunResult:
        """Vandaag tab ("Controleer nu"): a profiles run for only the given accounts, e.g. the ones
        that have not posted yet today. Own run type, so it never counts as a full profiles run."""
        res = RunResult("today_check", window, self.dry_run)
        return self.run_guarded(res, lambda r: self._today_check(r, handles))

    def _today_check(self, res: RunResult, requested: list[str]) -> None:
        active, _ = self.accounts()
        private = {r["handle"] for r in self.data.read("handles") if model.truthy(r.get("is_private"))}
        targets = [h for h in dict.fromkeys(requested) if h in active and h not in private]
        dropped = [h for h in requested if h not in targets]
        if dropped:
            res.notes.append("not checked (inactive, unknown or private): " + ", ".join("@" + h for h in dropped[:20]))
        if not targets:
            res.status = "skipped"
            res.notes.append("no accounts to check")
            return
        # Like a refresh: keep budget for the scheduled profile runs still to come this month.
        _, reserve = self._reserve()
        self._profiles(res, only=targets, reserve=reserve)

    def _profiles(self, res: RunResult, only: list[str] | None = None, reserve: int = 0) -> None:
        """Profiles run for all active accounts, or (only=...) for some of them. A partial run
        updates just the accounts it fetched: their posts, snapshots, status and history rows."""
        handles, issues = self.accounts()
        if only is None:
            res.notes.extend(issues)
        targets = handles if only is None else [h for h in only if h in handles]
        res.expected = len(targets)
        if not targets:
            res.status = "skipped"
            res.notes.append("no active valid handles in accounts")
            return
        if not self.budget_ok(res, reserve):
            return
        if self.dry_run:
            res.status = "dry-run"
            if only is not None:
                res.notes.append("would check: " + ", ".join("@" + h for h in targets))
            return
        records = self.collect(res, self.cfg.profiles_dataset, [{"url": profile_url(h)} for h in targets])
        if records is None:
            return

        wanted = set(targets)
        parsed, failed = {}, {}
        for rec in records:
            handle = model.record_handle(rec)
            if handle not in wanted:
                res.notes.append(f"ignored record for unexpected handle {handle!r}")
                continue
            if model.is_error(rec):
                failed[handle] = f"{rec.get('error_code')}: {str(rec.get('error'))[:120]}"
                continue
            parsed[handle] = model.parse_profile(rec, handle, self.cfg.campaign, self.stamp)
        for handle in wanted - parsed.keys() - failed.keys():
            failed[handle] = "no record returned"
        res.errors = len(failed)

        videos = [v for p in parsed.values() for v in p["videos"]]
        seen = {h: (p["seen_ids"], p["window"]["window_oldest_nonpinned"]) for h, p in parsed.items()
                if not p["snapshot"]["is_private"]}
        posts, missing = self.save_posts(videos, "profile", seen)
        self.data.append("profile_snapshots", [p["snapshot"] for p in parsed.values()])

        old_windows = {r["handle"]: r for r in self.admin.read("profile_window")}
        old_windows.update({h: p["window"] for h, p in parsed.items()})
        self.admin.rewrite("profile_window", sorted(old_windows.values(), key=lambda r: str(r["handle"])))

        self.data.ensure_columns("handles", model.SCHEMA_DATA["handles"])
        old_handles = {r["handle"]: r for r in self.data.read("handles")}
        groups, group_issues = account_groups(self.admin.read("accounts"))
        if only is None:
            res.notes.extend(group_issues)
        snapshots = None
        rows = []
        for handle in handles:  # every active account keeps its row; only the fetched ones change
            row = dict(old_handles.get(handle, {"handle": handle}))
            before = model.status_kind(row.get("last_status"))
            if handle in parsed:
                snap = parsed[handle]["snapshot"]
                row.update(is_private=snap["is_private"], followers=snap["followers"], last_scraped=self.stamp,
                           last_status="privé" if snap["is_private"] else "ok")
            elif handle in failed:
                reason = failed[handle]
                if "private" in reason.lower():
                    row["is_private"] = True
                row["last_status"] = f"fout: {reason[:80]}"
            now_kind = model.status_kind(row.get("last_status"))
            if now_kind and (now_kind != before or not str(row.get("status_since") or "").strip()):
                since = self.stamp
                if now_kind == before == "privé":  # column is new: look up when it went private
                    if snapshots is None:
                        snapshots = self.data.read("profile_snapshots")
                    since = model.private_since(snapshots, handle) or self.stamp
                row["status_since"] = since
            row["group"] = groups.get(handle, handle)
            rows.append(row)
        self.data.rewrite("handles", rows)
        if "outliers" not in self.sheet_tabs(self.data):  # created once, with its fixed tab id (site/config.js)
            self.data.ensure_tabs({"outliers": model.SCHEMA_DATA["outliers"]}, model.FIXED_SHEET_IDS)
        # A partial run writes history rows only for the accounts it fetched (no stale rows for the rest).
        self.append_history(handles if only is None else [h for h in targets if h in parsed], posts)

        private = [h for h, p in parsed.items() if p["snapshot"]["is_private"]]
        reposts = sum(p["reposts"] for p in parsed.values())
        pinned = sum(num for p in parsed.values() if (num := p["window"]["pinned_in_window"]))
        res.notes.append(f"{len(parsed)} profiles ok{'' if only is None else f' of {len(targets)} checked'}, "
                         f"{len(videos)} campaign videos seen in top_videos, "
                         f"{pinned} pinned in window, {reposts} reposts skipped, "
                         f"{getattr(self, 'post_history_written', 0)} post_history rows")
        if private:
            res.notes.append("PRIVATE accounts: " + ", ".join("@" + h for h in private))
        if missing:
            res.notes.append(f"{len(missing)} video(s) no longer in their account's window (deleted or hidden?): "
                             + ", ".join(missing[:20]))
        for handle, reason in sorted(failed.items()):
            res.notes.append(f"@{handle} failed: {reason}")
        res.status = "partial" if failed else "ok"

    # ---------- posts (weekly refresh and one-time window check) ----------

    def _reserve(self) -> tuple[int, int]:
        handles, _ = self.accounts()
        done, _ = model.window_state(self.admin.read("run_log"))
        runs = model.remaining_profile_runs(self.cfg, self.now_local, done)
        return runs, runs * len(handles)

    def run_refresh(self, window: str) -> RunResult:
        return self.run_guarded(RunResult("posts_refresh", window, self.dry_run), self._refresh)

    def _refresh(self, res: RunResult) -> None:
        handles, issues = self.accounts()
        res.notes.extend(issues)
        windows = {r["handle"]: r for r in self.admin.read("profile_window")}
        private = {r["handle"] for r in self.data.read("handles") if model.truthy(r.get("is_private"))}
        plan, skipped = model.plan_refresh(handles, windows, private, self.cfg.campaign)
        n = self.cfg.refresh_num_of_posts
        res.expected = len(plan) * n
        res.notes.append(f"{len(plan)} account(s) need older posts (max {n} each), {len(skipped)} skipped")
        for reason in sorted(set(skipped.values())):
            res.notes.append(f"skipped ({reason}): {sum(1 for r in skipped.values() if r == reason)}")
        if not plan:
            res.status = "skipped"
            return
        runs, reserve = self._reserve()
        if not self.budget_ok(res, reserve):
            return
        inputs = [model.posts_input(p["handle"], self.cfg.campaign, n, p["end_date"]) for p in plan]
        if self.dry_run:
            res.status = "dry-run"
            res.notes.extend(f"@{i['url'].split('@')[1]} {i['start_date']}..{i['end_date'] or 'now'}" for i in inputs)
            return
        self._collect_posts(res, inputs, n, [p["handle"] for p in plan], "posts")

    def _collect_posts(self, res: RunResult, inputs: list[dict], limit: int, handles: list[str],
                       source: str) -> tuple[dict[str, list[dict]], list[dict]] | None:
        records = self.collect(res, self.cfg.posts_dataset, inputs, type="discover_new",
                               discover_by="profile_url", limit_per_input=limit)
        if records is None:
            return None
        wanted = set(handles)
        found: dict[str, list[dict]] = {h: [] for h in handles}
        dropped: dict[str, int] = {}
        for rec in records:
            handle = model.record_handle(rec)
            if handle not in wanted:
                res.notes.append(f"ignored record for unexpected handle {handle!r}")
                continue
            if model.is_error(rec):
                if not model.is_no_posts(rec):
                    res.errors += 1
                    res.notes.append(f"@{handle} failed: {rec.get('error_code')}: {str(rec.get('error'))[:120]}")
                continue
            video, reason = model.parse_post(rec, handle, self.cfg.campaign)
            if video:
                found[handle].append(video)
            else:
                dropped[reason] = dropped.get(reason, 0) + 1
        videos = [v for vs in found.values() for v in vs]
        posts, _ = self.save_posts(videos, source)
        all_handles, _ = self.accounts()
        self.append_history(all_handles, posts)
        res.notes.append(f"{len(videos)} campaign posts upserted"
                         + "".join(f", {c} dropped ({r})" for r, c in sorted(dropped.items())))
        res.status = "partial" if res.errors else "ok"
        return found, posts

    def run_window_check(self, window: str, handles: list[str] | None = None) -> RunResult:
        res = RunResult("window_check", window, self.dry_run)
        return self.run_guarded(res, lambda r: self._window_check(r, handles))

    def _window_check(self, res: RunResult, chosen: list[str] | None) -> None:
        active, issues = self.accounts()
        windows = {r["handle"]: r for r in self.admin.read("profile_window")}
        private = {r["handle"] for r in self.data.read("handles") if model.truthy(r.get("is_private"))}
        if chosen:
            targets = [h for h in chosen if h in active]
        else:
            ranked = sorted((h for h in active if h not in private),
                            key=lambda h: model.num(windows.get(h, {}).get("videos_count")) or 0, reverse=True)
            targets = ranked[: self.cfg.check_accounts]
        n = self.cfg.check_num_of_posts
        res.expected = len(targets) * n
        res.notes.append("accounts: " + ", ".join("@" + h for h in targets))
        if not targets:
            res.status = "skipped"
            return
        runs, reserve = self._reserve()
        if not self.budget_ok(res, reserve):
            return
        if self.dry_run:
            res.status = "dry-run"
            return
        before = self.data.read("posts_latest")
        inputs = [model.posts_input(h, self.cfg.campaign, n, None) for h in targets]
        out = self._collect_posts(res, inputs, n, targets, "check")
        if out is None:
            return
        found, _ = out
        lines = ["| account | full pull | we had | missing | missing inside window | only ours | max views lag |",
                 "|---|---|---|---|---|---|---|"]
        gaps = 0
        for handle in targets:
            mine = [r for r in before if r.get("handle") == handle
                    and self.cfg.campaign.counts(model.parse_ts(r.get("created_at")))]
            cmp = model.compare_window(
                handle, found[handle], {str(r["video_id"]) for r in mine},
                {str(r["video_id"]): model.num(r.get("views")) for r in mine}, windows.get(handle))
            gaps += cmp["missing"]
            if cmp["missing"]:
                res.notes.append(f"GAP @{handle}: {cmp['missing']} missing ({cmp['missing_inside_window']} inside "
                                 f"window) ids {','.join(cmp['missing_ids'])}")
            lines.append(f"| @{handle} | {cmp['full_pull']} | {cmp['known']} | {cmp['missing']} | "
                         f"{cmp['missing_inside_window']} | {cmp['only_ours']} | {cmp['max_views_lag_pct']}% |")
        res.notes.append(f"window check: {gaps} gap(s) found" + ("" if gaps else " - top_videos + posts_latest were complete"))
        summary("### Window check\n\n" + "\n".join(lines))

    # ---------- scheduler ----------

    def auto(self) -> None:
        """Called by every cron firing: run whatever window is open and not yet done."""
        today = self.now_local.date()
        camp = self.cfg.campaign
        finale = self.finale()
        ran = False
        if finale and finale["phase"] == "live":
            # Finale: a run every few minutes instead of the 2-hourly windows (double-checked here,
            # whoever started this workflow). Budget cap and run-once-per-window still apply.
            key = model.finale_window_key(self.now_local, self.cfg.finale.every_minutes)
            ran |= self._maybe(key, self.run_scheduled_profiles)
        elif not (camp.start <= today <= camp.collect_until):
            print(f"{self.now_local:%Y-%m-%d %H:%M} Amsterdam: outside collection period, nothing to do")
            return
        else:
            for window in self.cfg.profile_windows:
                if window.contains(self.now_local):
                    ran |= self._maybe(window.key(today), self.run_scheduled_profiles)
        if self.cfg.refresh_window.contains(self.now_local):
            ran |= self._maybe(self.cfg.refresh_window.key(today), self.run_refresh)
        if self.cfg.check_date == today:
            evening = self.cfg.profile_windows[-1]
            done, _ = model.window_state(self.admin.read("run_log"))
            if evening.contains(self.now_local) and evening.key(today) in done:
                ran |= self._maybe(f"{today.isoformat()}/window-check", self.run_window_check)
        if not ran:
            print(f"{self.now_local:%Y-%m-%d %H:%M} Amsterdam: no open window needs a run")

    def finale(self) -> dict | None:
        """Current finale from the private sheet; None when there is no finale tab or row."""
        if "finale" not in self.admin_tabs():
            return None
        return model.finale_state(self.admin.read("finale"), self.now_utc, self.cfg.finale.max_hours)

    def admin_tabs(self) -> set[str]:
        return self.sheet_tabs(self.admin)

    @staticmethod
    def sheet_tabs(sheet) -> set[str]:
        tabs = getattr(sheet, "tabs", None)
        if callable(tabs):
            return set(tabs())
        return set(tabs or {})  # FakeSheet in tests

    def _maybe(self, key: str, fn) -> bool:
        done, failures = model.window_state(self.admin.read("run_log"))
        if key in done:
            print(f"{key}: already done")
            return False
        if failures.get(key, 0) >= self.cfg.max_attempts_per_window:
            print(f"{key}: failed {failures[key]} times, giving up for this window")
            return False
        fn(key)
        return True

    # ---------- status ----------

    def status(self) -> None:
        run_log = self.admin.read("run_log")
        logged = model.month_usage(run_log, self.now_utc)
        used = self.month_used(write=False)  # read-only: status never books an adjustment
        handles, issues = self.accounts()
        runs, reserve = self._reserve()
        summary(f"Amsterdam time {self.now_local:%Y-%m-%d %H:%M}\n\n"
                f"- active handles: {len(handles)}\n- records used this month: {used} / {self.cfg.monthly_cap}"
                + (f" (run_log has {logged}; Bright Data bills {used})" if used != logged else "") + "\n"
                f"- profile runs left this month: {runs} (≈{reserve} records)\n"
                f"- projected month total without refreshes: {used + reserve}\n"
                + "".join(f"- issue: {i}\n" for i in issues))
