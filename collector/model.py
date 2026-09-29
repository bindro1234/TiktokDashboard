"""Pure data logic: parse Bright Data records, upsert posts, plan refreshes, count budget."""

from __future__ import annotations

import datetime as dt
import re
from collections import defaultdict

from .config import UTC, Campaign, Config
from .handles import normalize_handle

VIDEO_ID_RE = re.compile(r"/(?:video|photo)/(\d+)")
URL_AUTHOR_RE = re.compile(r"tiktok\.com/@([^/?#]+)", re.IGNORECASE)
NO_POSTS_MESSAGE = "no public posts in the profile for the specified period"

SCHEMA_ADMIN = {
    "accounts": ["student_name", "tiktok_handle", "active"],
    "run_log": ["timestamp", "run_type", "window", "dry_run", "expected_records", "actual_records",
                "errors", "status", "snapshot_ids", "notes"],
    "profile_window": ["handle", "checked_at", "videos_count", "window_count", "pinned_in_window",
                       "window_oldest", "window_oldest_nonpinned"],
}
SCHEMA_DATA = {
    "handles": ["handle", "is_private", "followers", "last_scraped", "last_status"],
    "profile_snapshots": ["timestamp", "handle", "followers", "following", "likes", "video_count", "is_private"],
    "posts_latest": ["video_id", "handle", "created_at", "views", "likes", "comments", "shares", "post_type",
                     "pinned", "first_seen", "last_seen", "source"],
    "history": ["timestamp", "handle", "total_views", "followers", "campaign_likes", "campaign_posts"],
}

# run_log statuses that mean "this window is handled, don't run it again".
DONE_STATUSES = {"ok", "partial", "refused", "skipped"}


# ---------- small helpers ----------

def iso(ts: dt.datetime) -> str:
    return ts.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value) -> dt.datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return dt.datetime.fromtimestamp(value, UTC)
    text = str(value).strip().replace("Z", "+00:00")
    try:
        ts = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


def num(value) -> int | None:
    if value in (None, "", "undefined", "null"):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def truthy(value) -> bool:
    return str(value).strip().lower() in {"true", "1", "ja", "yes"}


def bd_date(day: dt.date) -> str:
    """Bright Data date filters use MM-DD-YYYY; the API does not validate them, so format strictly."""
    text = day.strftime("%m-%d-%Y")
    assert re.fullmatch(r"\d{2}-\d{2}-\d{4}", text)
    return text


def is_error(rec: dict) -> bool:
    return bool(rec.get("error") or rec.get("error_code")) and not (rec.get("post_id") or rec.get("account_id"))


def is_no_posts(rec: dict) -> bool:
    return NO_POSTS_MESSAGE in str(rec.get("error", "")).lower()


def record_handle(rec: dict) -> str | None:
    """Which tracked handle a record belongs to: the input URL first (a post URL can name another author)."""
    for key in ("input", "discovery_input"):
        inp = rec.get(key)
        if isinstance(inp, dict) and inp.get("url"):
            handle, _ = normalize_handle(inp["url"])
            if handle:
                return handle
    if rec.get("account_id"):
        handle, _ = normalize_handle(rec["account_id"])
        return handle
    return None


# ---------- profile records ----------

def parse_profile(rec: dict, handle: str, campaign: Campaign, now: str) -> dict:
    """Split one profile record into a snapshot row, campaign videos and window info."""
    pinned_ids = set()
    for pin in rec.get("pinned_posts") or []:
        match = VIDEO_ID_RE.search(str((pin or {}).get("url") or ""))
        if match:
            pinned_ids.add(match.group(1))
    post_info = {}
    for post in rec.get("top_posts_data") or []:
        match = URL_AUTHOR_RE.search(str(post.get("post_url") or ""))
        post_info[str(post.get("post_id") or "")] = (
            match.group(1).lower() if match else None, post.get("post_type"))

    videos, reposts = [], 0
    all_dates, own_nonpinned_dates = [], []
    for item in rec.get("top_videos") or []:
        vid = str(item.get("video_id") or "")
        if not vid.isdigit():
            continue
        created = parse_ts(item.get("create_date"))
        pinned = vid in pinned_ids
        author, post_type = post_info.get(vid, (None, None))
        is_repost = bool(author and author != handle)
        if created:
            all_dates.append(created)
            if not pinned and not is_repost:
                own_nonpinned_dates.append(created)
        if is_repost:
            reposts += 1
            continue
        if not campaign.counts(created):
            continue
        videos.append({
            "video_id": vid, "handle": handle, "created_at": iso(created),
            "views": num(item.get("playcount")), "likes": num(item.get("diggcount")),
            "comments": num(item.get("commentcount")), "shares": num(item.get("share_count")),
            "post_type": post_type or "", "pinned": pinned,
        })

    snapshot = {
        "timestamp": now, "handle": handle, "followers": num(rec.get("followers")),
        "following": num(rec.get("following")), "likes": num(rec.get("likes")),
        "video_count": num(rec.get("videos_count")), "is_private": bool(rec.get("is_private")),
    }
    window = {
        "handle": handle, "checked_at": now, "videos_count": num(rec.get("videos_count")),
        "window_count": len(rec.get("top_videos") or []), "pinned_in_window": len(pinned_ids & {
            str(v.get("video_id")) for v in rec.get("top_videos") or []}),
        "window_oldest": iso(min(all_dates)) if all_dates else "",
        "window_oldest_nonpinned": iso(min(own_nonpinned_dates)) if own_nonpinned_dates else "",
    }
    return {"snapshot": snapshot, "videos": videos, "window": window, "reposts": reposts}


# ---------- posts records ----------

def parse_post(rec: dict, handle: str, campaign: Campaign) -> tuple[dict | None, str | None]:
    """Return (video, None) or (None, reason it was dropped)."""
    author = str(rec.get("account_id") or "").lower()
    if author and author != handle:
        return None, "repost"
    vid = str(rec.get("post_id") or "")
    if not vid.isdigit():
        match = VIDEO_ID_RE.search(str(rec.get("url") or ""))
        vid = match.group(1) if match else ""
    if not vid:
        return None, "no post id"
    created = parse_ts(rec.get("create_time"))
    if not campaign.counts(created):
        return None, "outside campaign"
    shares = num(rec.get("num_share_count"))
    if shares is None:
        shares = num(rec.get("share_count"))
    return {
        "video_id": vid, "handle": handle, "created_at": iso(created),
        "views": num(rec.get("play_count")), "likes": num(rec.get("digg_count")),
        "comments": num(rec.get("comment_count")), "shares": shares,
        "post_type": rec.get("post_type") or "", "pinned": None,
    }, None


# ---------- posts_latest upsert and totals ----------

def upsert_posts(existing: list[dict], incoming: list[dict], now: str, source: str) -> list[dict]:
    """Upsert by video_id. Views never go down, and videos that leave the window keep their last stats."""
    by_id = {str(r["video_id"]): dict(r) for r in existing if str(r.get("video_id", "")).strip()}
    for video in incoming:
        vid = video["video_id"]
        old = by_id.get(vid)
        if old is None:
            row = {k: video.get(k) for k in SCHEMA_DATA["posts_latest"] if k in video}
            row.update(pinned=bool(video.get("pinned")), first_seen=now, last_seen=now, source=source)
            by_id[vid] = row
            continue
        old_views, new_views = num(old.get("views")), video.get("views")
        if new_views is not None:
            old["views"] = max(old_views or 0, new_views)
        for key in ("likes", "comments", "shares"):
            if video.get(key) is not None:
                old[key] = video[key]
        if video.get("pinned") is not None:
            old["pinned"] = bool(video["pinned"])
        old["post_type"] = video.get("post_type") or old.get("post_type", "")
        old.update(handle=video["handle"], created_at=video["created_at"], last_seen=now, source=source)
    return sorted(by_id.values(), key=lambda r: (str(r.get("handle")), str(r.get("created_at"))))


def campaign_totals(posts: list[dict], campaign: Campaign) -> dict[str, dict]:
    totals: dict[str, dict] = defaultdict(lambda: {"total_views": 0, "campaign_likes": 0, "campaign_posts": 0})
    for row in posts:
        if not campaign.counts(parse_ts(row.get("created_at"))):
            continue
        t = totals[str(row.get("handle"))]
        t["total_views"] += num(row.get("views")) or 0
        t["campaign_likes"] += num(row.get("likes")) or 0
        t["campaign_posts"] += 1
    return totals


# ---------- weekly refresh planning ----------

def plan_refresh(handles: list[str], windows: dict[str, dict], private: set[str],
                 campaign: Campaign) -> tuple[list[dict], dict[str, str]]:
    """Decide per account whether the weekly refresh must fetch posts older than the top_videos window.

    Returns (plan, skipped). Each plan item has handle and end_date (None = up to now).
    Pinned videos and reposts are ignored when finding the oldest date in the window.
    """
    plan, skipped = [], {}
    for handle in handles:
        if handle in private:
            skipped[handle] = "private"
            continue
        win = windows.get(handle)
        if not win:
            plan.append({"handle": handle, "end_date": None, "reason": "no profile data yet"})
            continue
        videos_count = num(win.get("videos_count"))
        window_count = num(win.get("window_count")) or 0
        oldest = parse_ts(win.get("window_oldest_nonpinned"))
        if videos_count is not None and videos_count <= window_count:
            skipped[handle] = "window holds every video"
        elif oldest is not None and oldest < campaign.start_utc:
            skipped[handle] = "window reaches back before the campaign start"
        elif oldest is None:
            plan.append({"handle": handle, "end_date": None, "reason": "no own non-pinned video in window"})
        else:
            end = min(oldest.astimezone(campaign.tz).date(), campaign.end)  # inclusive overlap of one day
            plan.append({"handle": handle, "end_date": end, "reason": "older campaign posts outside window"})
    return plan, skipped


def posts_input(handle: str, campaign: Campaign, num_of_posts: int, end_date: dt.date | None) -> dict:
    return {
        "url": f"https://www.tiktok.com/@{handle}",
        "num_of_posts": num_of_posts,
        "start_date": bd_date(campaign.start),
        "end_date": bd_date(end_date) if end_date else "",
    }


# ---------- one-time window check ----------

def compare_window(handle: str, full: list[dict], known_ids: set[str], known_views: dict[str, int],
                   window: dict | None) -> dict:
    """Compare a full campaign pull with what top_videos + posts_latest already had for one account."""
    oldest = parse_ts((window or {}).get("window_oldest_nonpinned"))
    full_ids = {v["video_id"] for v in full}
    missing = [v for v in full if v["video_id"] not in known_ids]
    inside = [v for v in missing if oldest is not None and parse_ts(v["created_at"]) >= oldest]
    lags = []
    for v in full:
        ours = known_views.get(v["video_id"])
        if ours is not None and v.get("views"):
            lags.append((v["views"] - ours) / v["views"])
    return {
        "handle": handle,
        "full_pull": len(full_ids),
        "known": len(known_ids),
        "missing": len(missing),
        "missing_inside_window": len(inside),  # > 0 means top_videos was NOT simply the newest videos
        "missing_ids": [v["video_id"] for v in missing][:10],
        "only_ours": len(known_ids - full_ids),  # deleted videos, reposts, or pull capped
        "max_views_lag_pct": round(100 * max(lags), 1) if lags else 0.0,
    }


# ---------- run_log / budget ----------

def month_usage(run_log: list[dict], now_utc: dt.datetime) -> int:
    total = 0
    for row in run_log:
        if truthy(row.get("dry_run")):
            continue
        ts = parse_ts(row.get("timestamp"))
        if ts and ts.year == now_utc.year and ts.month == now_utc.month:
            total += num(row.get("actual_records")) or 0
    return total


def window_state(run_log: list[dict]) -> tuple[set[str], dict[str, int]]:
    done, failures = set(), defaultdict(int)
    for row in run_log:
        key, status = str(row.get("window", "")), str(row.get("status", ""))
        if truthy(row.get("dry_run")) or not key:
            continue
        if status in DONE_STATUSES:
            done.add(key)
        elif status == "failed":
            failures[key] += 1
    return done, failures


PROFILE_RUN_TYPES = {"profiles", "force_refresh"}


def last_profiles_run(run_log: list[dict]) -> dt.datetime | None:
    """Time of the last profiles run that actually started a Bright Data job (so it may have cost records)."""
    last = None
    for row in run_log:
        if row.get("run_type") not in PROFILE_RUN_TYPES or truthy(row.get("dry_run")):
            continue
        if not str(row.get("snapshot_ids", "")).strip():
            continue
        ts = parse_ts(row.get("timestamp"))
        if ts and (last is None or ts > last):
            last = ts
    return last


def remaining_profile_runs(cfg: Config, now_local: dt.datetime, done: set[str]) -> int:
    """Scheduled profile windows still to come in this calendar month (UTC), not yet run."""
    now_utc = now_local.astimezone(UTC)
    count = 0
    day = now_local.date()
    while day <= cfg.campaign.collect_until:
        for window in cfg.profile_windows:
            end_local = dt.datetime.combine(day, window.end, cfg.tz)
            end_utc = end_local.astimezone(UTC)
            if end_local <= now_local or window.key(day) in done:
                continue
            if (end_utc.year, end_utc.month) == (now_utc.year, now_utc.month) and day >= cfg.campaign.start:
                count += 1
        day += dt.timedelta(days=1)
    return count
