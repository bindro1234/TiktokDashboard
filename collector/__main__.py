"""Command line entry point: python -m collector <command> [--dry-run]."""

from __future__ import annotations

import argparse
import logging
import sys

from . import config, model
from .brightdata import BrightData
from .runner import Collector, summary
from .sheets import Spreadsheet, session_from_env


def setup(admin: Spreadsheet, data: Spreadsheet, collector: Collector) -> None:
    """Create tabs and headers in both spreadsheets. Safe to run again."""
    tabs = admin.ensure_tabs(model.SCHEMA_ADMIN)
    data_tabs = data.ensure_tabs(model.SCHEMA_DATA)
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="collector", description=__doc__)
    parser.add_argument("command", choices=["auto", "profiles", "force", "refresh", "check", "status", "setup"])
    parser.add_argument("--dry-run", action="store_true", help="plan and log expected records, no scraping")
    parser.add_argument("--handles", default="", help="check: comma separated handles (default: most videos)")
    parser.add_argument("--config", default=str(config.ROOT / "config.yaml"))
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = config.load(args.config)
    session = session_from_env()
    admin = Spreadsheet(session, cfg.admin_sheet_id)
    data = Spreadsheet(session, cfg.data_sheet_id)
    bd = BrightData(cfg.poll_seconds, cfg.timeout_minutes)
    col = Collector(cfg, admin, data, bd, dry_run=args.dry_run)

    manual = f"{col.now_local:%Y-%m-%d}/manual-{col.now_local:%H%M}"
    if args.command == "setup":
        setup(admin, data, col)
    elif args.command == "auto":
        col.auto()
    elif args.command == "profiles":
        col.run_profiles(manual)
    elif args.command == "force":
        col.run_force_refresh(f"{col.now_local:%Y-%m-%d}/force-{col.now_local:%H%M}")
    elif args.command == "refresh":
        col.run_refresh(manual)
    elif args.command == "check":
        chosen = [h.strip().lstrip("@").lower() for h in args.handles.split(",") if h.strip()]
        col.run_window_check(manual, chosen or None)
    elif args.command == "status":
        col.status()
    return 0


if __name__ == "__main__":
    sys.exit(main())
