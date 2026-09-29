"""Write the private Worker's settings from config.yaml, so budget and schedule live in one place.

Run: python -m collector.worker_config private/src/config.json
Only ids, dates and numbers; no secrets.
"""

from __future__ import annotations

import json
import pathlib
import sys

from . import config


def build(cfg: config.Config) -> dict:
    camp = cfg.campaign
    hhmm = lambda t: t.strftime("%H:%M")  # noqa: E731
    return {
        "timezone": str(cfg.tz),
        "campaign": {"start": camp.start.isoformat(), "end": camp.end.isoformat(),
                     "collectUntil": camp.collect_until.isoformat()},
        "sheets": {"adminId": cfg.admin_sheet_id, "dataId": cfg.data_sheet_id},
        "budget": {"monthlyCap": cfg.monthly_cap},
        "schedule": {
            "profileRuns": [{"name": w.name, "start": hhmm(w.start), "end": hhmm(w.end)} for w in cfg.profile_windows],
            "refresh": {"name": cfg.refresh_window.name, "weekday": config.WEEKDAYS[cfg.refresh_window.weekday],
                        "start": hhmm(cfg.refresh_window.start), "end": hhmm(cfg.refresh_window.end)},
            "skipRecentMinutes": cfg.skip_recent_minutes,
            "maxAttemptsPerWindow": cfg.max_attempts_per_window,
        },
        "windowCheckDate": cfg.check_date.isoformat() if cfg.check_date else None,
        "finale": {"everyMinutes": cfg.finale.every_minutes, "maxHours": cfg.finale.max_hours,
                   "remindDaysBeforeEnd": cfg.finale.remind_days_before_end},
        "refreshNumOfPosts": cfg.refresh_num_of_posts,
        "forceMinMinutes": cfg.force_min_minutes,
        "workflows": {"force": "force-refresh.yml", "collect": "collect.yml"},
    }


def main(argv: list[str]) -> int:
    out = pathlib.Path(argv[1] if len(argv) > 1 else config.ROOT / "private" / "src" / "config.json")
    out.write_text(json.dumps(build(config.load()), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
