"""Normalize TikTok handles typed by hand into the accounts tab."""

from __future__ import annotations

import re

# TikTok usernames: letters, digits, underscore and period, at most 24 characters.
HANDLE_RE = re.compile(r"^[a-z0-9_.]{1,24}$")
URL_HANDLE_RE = re.compile(r"tiktok\.com/@([^/?#]+)", re.IGNORECASE)

# Instagram usernames: letters, digits, underscore and period, at most 30 characters; no period at
# the end and no two periods in a row. Typed by hand, so a profile link is accepted as well.
INSTAGRAM_RE = re.compile(r"^[a-z0-9._]{1,30}$")
INSTAGRAM_URL_RE = re.compile(r"(?:instagram\.com|instagr\.am)/([^?#]*)", re.IGNORECASE)
# First path segment of instagram.com links that is not a profile (/p/<code>, /explore, ...).
INSTAGRAM_NOT_PROFILE = {"p", "reel", "reels", "tv", "explore", "accounts", "direct", "about", "web", "legal",
                         "developer", "directory", "challenge", "emails", "session", "oauth", "login", "share"}
INSTAGRAM_COLUMN = "instagram_handle"
INSTAGRAM_LEGACY_COLUMN = "insta"  # the column was first typed as "Insta " (compared lowercase, trimmed)

ACTIVE_YES = {"ja", "j", "yes", "y", "true", "waar", "1", "x", "actief"}
ACTIVE_NO = {"nee", "n", "no", "false", "onwaar", "0", "inactief"}


def normalize_handle(raw) -> tuple[str | None, str | None]:
    """Return (handle, None) on success or (None, reason) when it can't be used."""
    text = re.sub(r"\s+", "", "" if raw is None else str(raw)).lower()
    if not text:
        return None, "empty handle"
    if "tiktok.com" in text or text.startswith("http"):
        match = URL_HANDLE_RE.search(text)
        if not match:
            return None, "URL has no /@handle (short vm.tiktok.com links can't be used)"
        text = match.group(1)
    text = text.lstrip("@")
    if not HANDLE_RE.fullmatch(text) or text.endswith("."):
        return None, "not a valid TikTok handle"
    return text, None


def normalize_instagram_handle(raw) -> tuple[str | None, str | None]:
    """Return (handle, None) on success or (None, reason). Accepts name, @Name, instagram.com/name,
    a profile link with ?igsh=... and /name/reel/... style links; refuses links to a post."""
    text = re.sub(r"\s+", "", "" if raw is None else str(raw)).lower()
    if not text:
        return None, "empty handle"
    if "instagram.com" in text or "instagr.am" in text or text.startswith("http"):
        match = INSTAGRAM_URL_RE.search(text)
        parts = [p for p in (match.group(1) if match else "").split("/") if p]
        if not parts:
            return None, "URL has no /handle"
        first = parts[0]
        if first in INSTAGRAM_NOT_PROFILE:
            return None, "link to a post or page, not to a profile"
        if first in ("_u", "stories"):  # instagram.com/_u/name (app link), instagram.com/stories/name/123
            if len(parts) < 2:
                return None, "URL has no /handle"
            first = parts[1]
        text = first
    text = text.lstrip("@")
    if not INSTAGRAM_RE.fullmatch(text) or text.endswith(".") or ".." in text:
        return None, "not a valid Instagram handle"
    return text, None


def instagram_cell(row: dict):
    """The Instagram handle cell of an accounts row: instagram_handle, or the old 'Insta ' column."""
    for key, value in row.items():
        if str(key).strip().lower() in (INSTAGRAM_COLUMN, INSTAGRAM_LEGACY_COLUMN):
            return value
    return ""


def parse_active(value) -> bool | None:
    """Blank counts as active. Returns None for values we don't understand."""
    text = str(value).strip().lower() if value is not None else ""
    if text == "" or text in ACTIVE_YES:
        return True
    if text in ACTIVE_NO:
        return False
    return None


def parse_accounts(rows: list[dict]) -> tuple[list[str], list[str]]:
    """Return (active handles in sheet order, issues). Issues never contain student names."""
    handles: list[str] = []
    seen: dict[str, int] = {}
    issues: list[str] = []
    for index, row in enumerate(rows, start=2):  # row 1 is the header
        raw = row.get("tiktok_handle", "")
        if str(raw).strip() == "":
            if normalize_instagram_handle(instagram_cell(row))[0]:
                continue  # a student with only Instagram: nothing to follow on TikTok
            if any(str(v).strip() for v in row.values()):
                issues.append(f"accounts row {index}: no handle filled in")
            continue
        handle, reason = normalize_handle(raw)
        if handle is None:
            issues.append(f"accounts row {index}: '{str(raw).strip()[:60]}' skipped ({reason})")
            continue
        active = parse_active(row.get("active", ""))
        if active is None:
            issues.append(f"accounts row {index}: active='{row.get('active')}' not understood (use ja/nee), skipped @{handle}")
            continue
        if not active:
            continue
        if handle in seen:
            issues.append(f"accounts row {index}: @{handle} is a duplicate of row {seen[handle]}, skipped")
            continue
        seen[handle] = index
        handles.append(handle)
    return handles, issues


def account_groups(rows: list[dict]) -> tuple[dict[str, str], list[str]]:
    """Students with more than one account (e.g. a brand account and one for ads).

    An extra account has the handle of the student's first account in the optional column
    main_account. Returns ({active handle: group}, issues): the group is the main account's handle,
    or the handle itself. An extra account whose main account isn't active (or is an extra itself)
    counts on its own and is reported. Same rules as parseAccounts in private/public/lib.js.
    """
    handles, _ = parse_accounts(rows)
    active = set(handles)
    mains: dict[str, str | None] = {}
    for row in rows:
        handle, _ = normalize_handle(row.get("tiktok_handle"))
        if handle in active and handle not in mains:
            main, _ = normalize_handle(row.get("main_account")) if str(row.get("main_account") or "").strip() else (None, None)
            mains[handle] = main if main != handle else None
    groups, issues = {}, []
    for handle in handles:
        main = mains.get(handle)
        if main and main in active and not mains.get(main):
            groups[handle] = main
        else:
            groups[handle] = handle
            if main:
                issues.append(f"@{handle}: main_account @{main} is not an active main account, counted on its own")
    return groups, issues


def parse_instagram_accounts(rows: list[dict]) -> tuple[list[dict], list[str]]:
    """The Instagram account of each active student: ([{handle, student, row}], issues).

    One Instagram account per student, written in the instagram_handle column of the student's first
    row (the one without main_account). `student` is that row's TikTok handle, or "instagram:<handle>"
    for a student who only has Instagram. A handle on a second TikTok account's row, an invalid handle
    and a handle used by two students are skipped and reported (no names in the issues).
    Same rules as parseAccounts in private/public/lib.js."""
    accounts: list[dict] = []
    seen: dict[str, int] = {}
    issues: list[str] = []
    for index, row in enumerate(rows, start=2):  # row 1 is the header
        raw = instagram_cell(row)
        if str(raw).strip() == "":
            continue
        handle, reason = normalize_instagram_handle(raw)
        if handle is None:
            issues.append(f"accounts row {index}: Instagram '{str(raw).strip()[:60]}' skipped ({reason})")
            continue
        active = parse_active(row.get("active", ""))
        if active is None:
            issues.append(f"accounts row {index}: active='{row.get('active')}' not understood (use ja/nee), skipped Instagram @{handle}")
            continue
        if not active:
            continue
        if str(row.get("main_account") or "").strip():
            issues.append(f"accounts row {index}: Instagram @{handle} is on a second TikTok account's row and ignored; "
                          "put it on the student's first row")
            continue
        if handle in seen:
            issues.append(f"accounts row {index}: Instagram @{handle} is a duplicate of row {seen[handle]}, skipped")
            continue
        seen[handle] = index
        tiktok, _ = normalize_handle(row.get("tiktok_handle"))
        accounts.append({"handle": handle, "student": tiktok or f"instagram:{handle}", "row": index})
    return accounts, issues


def profile_url(handle: str) -> str:
    return f"https://www.tiktok.com/@{handle}"


def instagram_url(handle: str) -> str:
    return f"https://www.instagram.com/{handle}/"
