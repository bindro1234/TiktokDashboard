"""Run types: profiles (twice a day), weekly posts refresh, one-time window check, and the scheduler."""

from __future__ import annotations

import datetime as dt
import logging
import os
from dataclasses import dataclass, field

from . import model
from .brightdata import BrightData
from .config import UTC, Config
from .handles import parse_accounts, profile_url
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

    def budget_ok(self, res: RunResult, reserve: int = 0) -> bool:
        used = model.month_usage(self.admin.read("run_log"), self.now_utc)
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

    def save_posts(self, videos: list[dict], source: str) -> list[dict]:
        merged = model.upsert_posts(self.data.read("posts_latest"), videos, self.stamp, source)
        self.data.rewrite("posts_latest", merged)
        return merged

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

    def _profiles(self, res: RunResult) -> None:
        handles, issues = self.accounts()
        res.notes.extend(issues)
        res.expected = len(handles)
        if not handles:
            res.status = "skipped"
            res.notes.append("no active valid handles in accounts")
            return
        if not self.budget_ok(res):
            return
        if self.dry_run:
            res.status = "dry-run"
            return
        records = self.collect(res, self.cfg.profiles_dataset, [{"url": profile_url(h)} for h in handles])
        if records is None:
            return

        wanted = set(handles)
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
        posts = self.save_posts(videos, "profile")
        self.data.append("profile_snapshots", [p["snapshot"] for p in parsed.values()])

        old_windows = {r["handle"]: r for r in self.admin.read("profile_window")}
        old_windows.update({h: p["window"] for h, p in parsed.items()})
        self.admin.rewrite("profile_window", sorted(old_windows.values(), key=lambda r: str(r["handle"])))

        old_handles = {r["handle"]: r for r in self.data.read("handles")}
        rows = []
        for handle in handles:
            row = dict(old_handles.get(handle, {"handle": handle}))
            if handle in parsed:
                snap = parsed[handle]["snapshot"]
                row.update(is_private=snap["is_private"], followers=snap["followers"], last_scraped=self.stamp,
                           last_status="privé" if snap["is_private"] else "ok")
            else:
                reason = failed[handle]
                if "private" in reason.lower():
                    row["is_private"] = True
                row["last_status"] = f"fout: {reason[:80]}"
            rows.append(row)
        self.data.rewrite("handles", rows)
        self.append_history(handles, posts)

        private = [h for h, p in parsed.items() if p["snapshot"]["is_private"]]
        reposts = sum(p["reposts"] for p in parsed.values())
        pinned = sum(num for p in parsed.values() if (num := p["window"]["pinned_in_window"]))
        res.notes.append(f"{len(parsed)} profiles ok, {len(videos)} campaign videos seen in top_videos, "
                         f"{pinned} pinned in window, {reposts} reposts skipped")
        if private:
            res.notes.append("PRIVATE accounts: " + ", ".join("@" + h for h in private))
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
        posts = self.save_posts(videos, source)
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
        if not (camp.start <= today <= camp.collect_until):
            print(f"{self.now_local:%Y-%m-%d %H:%M} Amsterdam: outside collection period, nothing to do")
            return
        ran = False
        for window in self.cfg.profile_windows:
            if window.contains(self.now_local):
                ran |= self._maybe(window.key(today), self.run_profiles)
        if self.cfg.refresh_window.contains(self.now_local):
            ran |= self._maybe(self.cfg.refresh_window.key(today), self.run_refresh)
        if self.cfg.check_date == today:
            evening = self.cfg.profile_windows[-1]
            done, _ = model.window_state(self.admin.read("run_log"))
            if evening.contains(self.now_local) and evening.key(today) in done:
                ran |= self._maybe(f"{today.isoformat()}/window-check", self.run_window_check)
        if not ran:
            print(f"{self.now_local:%Y-%m-%d %H:%M} Amsterdam: no open window needs a run")

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
        used = model.month_usage(run_log, self.now_utc)
        handles, issues = self.accounts()
        runs, reserve = self._reserve()
        summary(f"Amsterdam time {self.now_local:%Y-%m-%d %H:%M}\n\n"
                f"- active handles: {len(handles)}\n- records used this month: {used} / {self.cfg.monthly_cap}\n"
                f"- profile runs left this month: {runs} (≈{reserve} records)\n"
                f"- projected month total without refreshes: {used + reserve}\n"
                + "".join(f"- issue: {i}\n" for i in issues))
