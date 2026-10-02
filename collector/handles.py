"""Normalize TikTok handles typed by hand into the accounts tab."""

from __future__ import annotations

import re

# TikTok usernames: letters, digits, underscore and period, at most 24 characters.
HANDLE_RE = re.compile(r"^[a-z0-9_.]{1,24}$")
URL_HANDLE_RE = re.compile(r"tiktok\.com/@([^/?#]+)", re.IGNORECASE)

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


def profile_url(handle: str) -> str:
    return f"https://www.tiktok.com/@{handle}"
