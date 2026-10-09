"""Instagram profile records (Bright Data "Instagram - Profiles", collect by profile URL).

One record per account: followers, following, post count, private yes/no and the account's newest posts
(at most ARRAY_CAP, pinned posts first) with caption, hashtags, id, url and content type. The record has
no likes, comments or views, and no stories; that is accepted. Pure data logic, like model.py."""

from __future__ import annotations

import datetime as dt
import re

from .config import UTC, Campaign
from .handles import normalize_instagram_handle
from .model import iso, num, parse_ts

ARRAY_CAP = 12            # posts in one profile record (seen on accounts with tens of thousands of posts)
MAX_PINNED = 3            # Instagram lets an account pin up to 3 posts; they come first in the record
IG_EPOCH_MS = 1314220021721  # Instagram media ids: (milliseconds since this moment) << 23 | shard | sequence
HASHTAG_RE = re.compile(r"#(\w+)")
POST_TYPES = {"image": "photo", "carousel": "carousel", "video": "reel"}  # labels the record uses -> ours


def post_time_from_id(post_id, now: dt.datetime) -> dt.datetime | None:
    """The moment a post was made, read from its id; None when the id is not a plausible Instagram id."""
    try:
        n = int(str(post_id).strip())
        ts = dt.datetime.fromtimestamp(((n >> 23) + IG_EPOCH_MS) / 1000, UTC)
    except (ValueError, OverflowError, OSError):
        return None
    # Real ids of the last years are far past the epoch; a small number is not a post id.
    return ts if dt.datetime(2012, 1, 1, tzinfo=UTC) <= ts <= now + dt.timedelta(days=1) else None


def created_at(post: dict, now: dt.datetime) -> dt.datetime | None:
    """When a post was made. The record's own `datetime` is a date only (00:00:00Z) and is a day off for
    roughly one post in ten, but the post id carries the exact creation time. So: the id's time, but never
    earlier than the listed day (a scheduled post is created before it is published). Without a usable id
    the listed date is used."""
    listed = parse_ts(post.get("datetime"))
    from_id = post_time_from_id(post.get("id"), now)
    if from_id is None:
        return listed
    return max(from_id, listed) if listed else from_id


def post_type(content_type) -> str:
    """photo, carousel or reel (the record says Image, Carousel or Video); anything else is kept as it is."""
    text = str(content_type or "").strip().lower()
    return POST_TYPES.get(text, text)


def hashtags(post: dict) -> str:
    """Caption hashtags as one lowercase string without '#', e.g. "glu fotografie". Only the letters, digits
    and underscores of a tag count ("#fotografie📷" is "fotografie"). Hashtags in comments are not visible."""
    tags: list[str] = []
    for tag in list(post.get("post_hashtags") or []) + HASHTAG_RE.findall(str(post.get("caption") or "")):
        match = re.match(r"\w+", str(tag or "").strip().lstrip("#"))
        text = match.group(0).lower() if match else ""
        if text and text not in tags:
            tags.append(text)
    return " ".join(tags)


def record_handle(rec: dict) -> str | None:
    """Which tracked handle a record belongs to: the input first (an error record has nothing else)."""
    for key, fields in (("input", ("url",)), ("discovery_input", ("user_name", "url"))):
        inp = rec.get(key)
        for field in fields:
            if isinstance(inp, dict) and inp.get(field):
                handle, _ = normalize_instagram_handle(inp[field])
                if handle:
                    return handle
    handle, _ = normalize_instagram_handle(rec.get("account")) if rec.get("account") else (None, None)
    return handle


def is_error(rec: dict) -> bool:
    """A record without any profile data: an error record, or an empty one for an account that is gone.
    It must never be stored as a successful measurement (followers would be empty)."""
    return not (rec.get("account") or rec.get("id") or rec.get("followers") is not None)


def error_reason(rec: dict) -> str:
    return f"{rec.get('error_code') or 'error'}: {str(rec.get('error') or 'no profile data in the record')[:120]}"


def parse_profile(rec: dict, handle: str, campaign: Campaign, now: dt.datetime) -> dict:
    """Split one profile record into a snapshot row and the campaign posts.

    posts: only posts made from the Instagram start day up to the campaign end (the id's time decides).
    array_ids / array_size: what the record listed, for the "window full" check."""
    listed = [p for p in rec.get("posts") or [] if isinstance(p, dict)]
    posts, ids = [], []
    for p in listed:
        pid = str(p.get("id") or "").strip()
        if not pid.isdigit():
            continue
        ids.append(pid)
        created = created_at(p, now)
        if not campaign.counts(created):
            continue
        posts.append({"post_id": pid, "handle": handle, "created_at": iso(created),
                      "post_type": post_type(p.get("content_type")), "hashtags": hashtags(p),
                      "url": str(p.get("url") or "").strip()})
    snapshot = {"timestamp": iso(now), "handle": handle, "followers": num(rec.get("followers")),
                "following": num(rec.get("following")), "posts_count": num(rec.get("posts_count")),
                "is_private": bool(rec.get("is_private"))}
    return {"snapshot": snapshot, "posts": posts, "array_ids": ids, "array_size": len(listed)}


def window_full(parsed: dict, known_ids: set[str]) -> bool:
    """True when the record's post list is full and may be hiding posts we never saw.

    With posts already stored for the account: full and none of them in the list (nothing overlaps, so
    posts in between may be missing). First time we see the account: full and nearly all of it inside the
    campaign (at most MAX_PINNED slots go to older pinned posts)."""
    if parsed["array_size"] < ARRAY_CAP:
        return False
    if known_ids:
        return not (known_ids & set(parsed["array_ids"]))
    return len(parsed["posts"]) >= ARRAY_CAP - MAX_PINNED


def upsert_posts(existing: list[dict], incoming: list[dict], now: str) -> list[dict]:
    """Upsert into ig_posts by post_id. A post that drops out of the account's list keeps its row, so a
    deleted post still counts for the day it was made. created_at is kept as first computed."""
    by_id = {str(r["post_id"]): dict(r) for r in existing if str(r.get("post_id", "")).strip()}
    for post in incoming:
        old = by_id.get(post["post_id"])
        if old is None:
            by_id[post["post_id"]] = {**post, "first_seen": now, "last_seen": now}
            continue
        old.update(handle=post["handle"], last_seen=now)
        for key in ("post_type", "hashtags", "url"):
            if post.get(key):
                old[key] = post[key]
        if not str(old.get("created_at") or "").strip():
            old["created_at"] = post["created_at"]
    return sorted(by_id.values(), key=lambda r: (str(r.get("handle")), str(r.get("created_at"))))


def campaign_post_counts(posts: list[dict], campaign: Campaign) -> dict[str, int]:
    """Posts per account that count for the campaign (from ig_posts)."""
    counts: dict[str, int] = {}
    for row in posts:
        if campaign.counts(parse_ts(row.get("created_at"))):
            handle = str(row.get("handle"))
            counts[handle] = counts.get(handle, 0) + 1
    return counts


def new_baselines(existing: list[dict], snapshots: list[dict], now: str) -> list[dict]:
    """ig_baseline rows to add: an account's baseline is its first successful measurement of followers.
    Rows are only ever added, never changed, so the baseline of an account never shifts; an account added
    later simply gets its baseline at its own first measurement."""
    have = {str(r.get("handle")) for r in existing}
    rows = []
    for snap in snapshots:
        if snap["handle"] not in have and snap["followers"] is not None:
            rows.append({"handle": snap["handle"], "baseline_at": now, "baseline_followers": snap["followers"]})
            have.add(snap["handle"])
    return rows
