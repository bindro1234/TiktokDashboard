"""Command line entry point: python -m collector <command> [--dry-run]."""

from __future__ import annotations

import argparse
import logging
import sys

from . import config, handles, model
from .brightdata import BrightData
from .runner import Collector, summary
from .sheets import Spreadsheet, session_from_env


def setup(admin: Spreadsheet, data: Spreadsheet, collector: Collector) -> None:
    """Create tabs and headers in both spreadsheets. Safe to run again."""
    # The Instagram column was typed by hand as "Insta ": rename it before ensure_tabs, which would
    # otherwise add a second, empty instagram_handle column next to it.
    if "accounts" in admin.tabs():
        for change in admin.rename_header("accounts", {handles.INSTAGRAM_LEGACY_COLUMN: handles.INSTAGRAM_COLUMN}):
            summary(f"accounts header renamed: {change}")
    tabs = admin.ensure_tabs(model.SCHEMA_ADMIN)
    data_tabs = data.ensure_tabs(model.SCHEMA_DATA, model.FIXED_SHEET_IDS)
    # The website needs the gid of each public tab (site/config.js); tab ids are not secret.
    summary("Public sheet tab ids (gid) for site/config.js: "
            + ", ".join(f"{name}={data_tabs[name]}" for name in model.SCHEMA_DATA))
    # ja/nee dropdown for the active column (other values still work, see handles.py).
    admin.batch_update([{"setDataValidation": {
        "range": {"sheetId": tabs["accounts"], "startRowIndex": 1, "startColumnIndex": 2, "endColumnIndex": 3},
        "rule": {"condition": {"type": "ONE_OF_LIST", "values": [{"userEnteredValue": "ja"},
                                                                  {"userEnteredValue": "nee"}]},
                 "strict": False, "showCustomUi": True}}}])
    print("Tabs ready in both spreadsheets.")


def split_handles(text: str) -> tuple[list[str], list[str]]:
    """The --handles list as (TikTok handles, Instagram handles). Entries are comma separated; the platform
    is written in front (tiktok:name, instagram:name, ig:name), a bare name is a TikTok handle."""
    tiktok, ig = [], []
    for item in text.split(","):
        item = item.strip()
        if not item:
            continue
        platform, _, rest = item.partition(":")
        target = ig if platform.lower() in ("instagram", "ig") and rest else tiktok
        name = rest if rest and platform.lower() in ("instagram", "ig", "tiktok") else item
        target.append(name.strip().lstrip("@").lower())
    return tiktok, ig


def run_today(col: Collector, handles: str) -> None:
    """"Controleer nu": one profiles run for the TikTok accounts in the list and one for its Instagram accounts.
    A failing platform never stops the other one (the teacher presses the button once for both); the first
    error is raised afterwards, so the workflow still shows red. Every run writes its own run_log row."""
    tiktok, ig = split_handles(handles)
    runs = []
    if tiktok or not ig:
        runs.append(lambda: col.run_today_check(f"{col.now_local:%Y-%m-%d}/today-{col.now_local:%H%M}", tiktok))
    if ig:
        runs.append(lambda: col.run_ig_today_check(f"{col.now_local:%Y-%m-%d}/ig-today-{col.now_local:%H%M}", ig))
    failure = None
    for run in runs:
        try:
            run()
        except Exception as exc:  # noqa: BLE001 - already logged in run_log by run_guarded
            logging.exception("today check failed")
            failure = failure or exc
    if failure:
        raise failure


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="collector", description=__doc__)
    parser.add_argument("command", choices=["auto", "profiles", "ig-profiles", "force", "refresh", "check", "today", "status", "setup"])
    parser.add_argument("--dry-run", action="store_true", help="plan and log expected records, no scraping")
    parser.add_argument("--handles", default="", help="check: comma separated handles (default: most videos); today: the handles to check, "
                        "with the platform in front for Instagram (instagram:name; a bare name is TikTok)")
    parser.add_argument("--config", default=str(config.ROOT / "config.yaml"))
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = config.load(args.config)
    session = session_from_env()
    admin = Spreadsheet(session, cfg.admin_sheet_id)
    data = Spreadsheet(session, cfg.data_sheet_id)
    bd = BrightData(cfg.poll_seconds, cfg.timeout_minutes)
    col = Collector(cfg, admin, data, bd, dry_run=args.dry_run)
    if args.command != "setup":
        col.apply_settings()   # the frequency chosen on Beheer (settings tab) over the config.yaml start value

    manual = f"{col.now_local:%Y-%m-%d}/manual-{col.now_local:%H%M}"
    if args.command == "setup":
        setup(admin, data, col)
    elif args.command == "auto":
        col.auto()
    elif args.command == "profiles":
        col.run_profiles(manual)
    elif args.command == "ig-profiles":
        col.run_ig_profiles(f"{col.now_local:%Y-%m-%d}/ig-manual-{col.now_local:%H%M}")
    elif args.command == "force":
        # "Nu verversen": both platforms, each with its own cooldown and its own run_log row.
        col.run_force_refresh(f"{col.now_local:%Y-%m-%d}/force-{col.now_local:%H%M}")
        col.run_ig_force_refresh(f"{col.now_local:%Y-%m-%d}/ig-force-{col.now_local:%H%M}")
    elif args.command == "refresh":
        col.run_refresh(manual)
    elif args.command == "check":
        chosen = [h.strip().lstrip("@").lower() for h in args.handles.split(",") if h.strip()]
        col.run_window_check(manual, chosen or None)
    elif args.command == "today":
        run_today(col, args.handles)
    elif args.command == "status":
        col.status()
    return 0


if __name__ == "__main__":
    sys.exit(main())
