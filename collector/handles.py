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


def profile_url(handle: str) -> str:
    return f"https://www.tiktok.com/@{handle}"
