"""Write the private Worker's settings from config.yaml, so budget and schedule live in one place.

Run: python -m collector.worker_config private/src/config.json
Only ids, dates and numbers; no secrets.
"""

from __future__ import annotations

import json
import pathlib
import sys

from . import config, model


def _camel(key: str) -> str:
    head, *rest = key.split("_")
    return head + "".join(p.capitalize() for p in rest)


def build(cfg: config.Config) -> dict:
    camp = cfg.campaign
    hhmm = lambda t: t.strftime("%H:%M")  # noqa: E731
    return {
        "timezone": str(cfg.tz),
        "campaign": {"start": camp.start.isoformat(), "end": camp.end.isoformat(),
                     "collectUntil": camp.collect_until.isoformat()},
        "offDays": {"weekends": cfg.off_days.weekends,
                    "periods": [{"name": p.name, "from": p.start.isoformat(), "to": p.end.isoformat()}
                                for p in cfg.off_days.periods]},
        "sheets": {"adminId": cfg.admin_sheet_id, "dataId": cfg.data_sheet_id},
        "budget": {"monthlyCap": cfg.monthly_cap},
        "instagram": {"startDate": cfg.instagram_start.isoformat() if cfg.instagram_start else None},
        # Start value of the school hashtags on the Hashtags tab; teachers change them on Beheer (private sheet).
        "hashtags": {"school": list(cfg.school_hashtags)},
        # How often each platform is pulled (the start values; teachers change them on Beheer, which stores them in the
        # private settings tab) and the windows of that step (Instagram ones are keyed ig-08u).
        # The Worker's timer, the budget and the collector all read the same setting.
        "frequency": dict(cfg.frequency),
        # step -> window names of the pool (a step is a set of hourly windows), so the page and the Worker can work out
        # the windows of any frequency chosen on Beheer; the start values above are what applies until one is saved.
        "frequencySteps": {step: list(names) for step, names in cfg.frequency_steps.items()},
        "schedule": {
            # The pool of hourly windows (the crons must cover every one of them) and the ones in use.
            "profileRuns": [{"name": w.name, "start": hhmm(w.start), "end": hhmm(w.end)} for w in cfg.profile_windows],
            "windows": {platform: [{"name": w.name, "start": hhmm(w.start), "end": hhmm(w.end)}
                                   for w in cfg.platform_windows(platform)] for platform in config.PLATFORMS},
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
        "todayCheck": {"cooldownMinutes": cfg.today_cooldown_minutes},
        # snake_case keys from config.yaml -> camelCase, e.g. min_views -> minViews
        "signals": {_camel(k): v for k, v in cfg.signals.items()},
        "fixedGids": dict(model.FIXED_SHEET_IDS),
        "workflows": {"force": "force-refresh.yml", "collect": "collect.yml"},
    }


def main(argv: list[str]) -> int:
    out = pathlib.Path(argv[1] if len(argv) > 1 else config.ROOT / "private" / "src" / "config.json")
    out.write_text(json.dumps(build(config.load()), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
