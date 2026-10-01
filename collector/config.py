"""Load config.yaml into small typed objects."""

from __future__ import annotations

import datetime as dt
import pathlib
from dataclasses import dataclass, field
from zoneinfo import ZoneInfo

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
UTC = dt.timezone.utc
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _time(value: str) -> dt.time:
    hours, minutes = str(value).split(":")
    return dt.time(int(hours), int(minutes))


def _date(value) -> dt.date | None:
    if value in (None, ""):
        return None
    if isinstance(value, dt.date):
        return value
    return dt.date.fromisoformat(str(value))


@dataclass(frozen=True)
class Window:
    name: str
    start: dt.time
    end: dt.time  # inclusive, minute precision
    weekday: int | None = None  # 0 = Monday; None = every day

    def contains(self, local: dt.datetime) -> bool:
        if self.weekday is not None and local.weekday() != self.weekday:
            return False
        now = local.time().replace(second=0, microsecond=0)
        return self.start <= now <= self.end

    def key(self, day: dt.date) -> str:
        return f"{day.isoformat()}/{self.name}"


@dataclass(frozen=True)
class Campaign:
    start: dt.date
    end: dt.date
    collect_until: dt.date
    tz: ZoneInfo

    @property
    def start_utc(self) -> dt.datetime:
        return dt.datetime.combine(self.start, dt.time(0), self.tz).astimezone(UTC)

    @property
    def end_utc_exclusive(self) -> dt.datetime:
        return dt.datetime.combine(self.end + dt.timedelta(days=1), dt.time(0), self.tz).astimezone(UTC)

    def counts(self, created_utc: dt.datetime | None) -> bool:
        """True if a post created at this moment counts for the campaign."""
        return created_utc is not None and self.start_utc <= created_utc < self.end_utc_exclusive


@dataclass(frozen=True)
class OffPeriod:
    name: str
    start: dt.date
    end: dt.date


@dataclass(frozen=True)
class OffDays:
    """Days on which posting is optional (only used by the private site's streaks and warnings)."""
    weekends: bool = False
    periods: tuple[OffPeriod, ...] = ()

    def contains(self, day: dt.date) -> bool:
        if self.weekends and day.weekday() >= 5:
            return True
        return any(p.start <= day <= p.end for p in self.periods)


def _off_days(raw: dict | None) -> OffDays:
    raw = raw or {}
    periods = []
    for p in raw.get("periods") or []:
        start, end = _date(p["from"]), _date(p["to"])
        if end < start:
            raise ValueError(f"campaign.off_days: {p.get('name')!r} ends before it starts")
        periods.append(OffPeriod(str(p.get("name") or "vrij"), start, end))
    return OffDays(weekends=bool(raw.get("weekends", False)), periods=tuple(periods))


# Opvallend tab thresholds (config.yaml signals); only used by the private site.
SIGNAL_DEFAULTS = {
    "min_views": 1000, "like_ratio_factor": 3, "step_share": 0.6, "step_max_hours": 2.5,
    "flat_hours": 6, "flat_share": 0.1, "zero_engagement_min_views": 5000,
    "follower_jump_min": 100, "follower_jump_factor": 5,
}


@dataclass(frozen=True)
class FinaleSettings:
    """Manual finale (started on the private site): runs every `every_minutes` until the deadline,
    at most `max_hours` long. The state itself lives in the private sheet (tab finale)."""
    every_minutes: int = 15
    max_hours: int = 8
    remind_days_before_end: int = 3


@dataclass(frozen=True)
class Config:
    tz: ZoneInfo
    campaign: Campaign
    admin_sheet_id: str
    data_sheet_id: str
    profiles_dataset: str
    posts_dataset: str
    poll_seconds: int
    timeout_minutes: int
    monthly_cap: int
    max_attempts_per_window: int
    profile_windows: tuple[Window, ...]
    refresh_window: Window
    refresh_num_of_posts: int
    check_date: dt.date | None
    check_accounts: int
    check_num_of_posts: int
    force_min_minutes: int
    skip_recent_minutes: int
    finale: FinaleSettings = FinaleSettings()
    off_days: OffDays = OffDays()
    today_cooldown_minutes: int = 10
    signals: dict = field(default_factory=dict)


def load(path: pathlib.Path | str = ROOT / "config.yaml") -> Config:
    raw = yaml.safe_load(pathlib.Path(path).read_text(encoding="utf-8"))
    tz = ZoneInfo(raw["timezone"])
    camp = raw["campaign"]
    sched = raw["schedule"]
    refresh = sched["posts_refresh"]
    check = raw.get("window_check") or {}
    return Config(
        tz=tz,
        campaign=Campaign(
            start=_date(camp["start_date"]),
            end=_date(camp["end_date"]),
            collect_until=_date(camp.get("collect_until")) or _date(camp["end_date"]),
            tz=tz,
        ),
        admin_sheet_id=raw["sheets"]["admin_id"],
        data_sheet_id=raw["sheets"]["data_id"],
        profiles_dataset=raw["brightdata"]["profiles_dataset"],
        posts_dataset=raw["brightdata"]["posts_dataset"],
        poll_seconds=int(raw["brightdata"].get("poll_seconds", 15)),
        timeout_minutes=int(raw["brightdata"].get("timeout_minutes", 30)),
        monthly_cap=int(raw["budget"]["monthly_cap"]),
        max_attempts_per_window=int(sched.get("max_attempts_per_window", 2)),
        profile_windows=tuple(
            Window(w["name"], _time(w["start"]), _time(w["end"])) for w in sched["profile_runs"]
        ),
        refresh_window=Window(
            refresh["name"],
            _time(refresh["start"]),
            _time(refresh["end"]),
            WEEKDAYS.index(str(refresh["weekday"]).lower()),
        ),
        refresh_num_of_posts=int(raw["posts_refresh"]["num_of_posts"]),
        check_date=_date(check.get("date")),
        check_accounts=int(check.get("accounts", 4)),
        check_num_of_posts=int(check.get("num_of_posts", 40)),
        force_min_minutes=int((raw.get("force_refresh") or {}).get("min_minutes_between", 30)),
        skip_recent_minutes=int(sched.get("skip_if_profiles_ran_within_minutes", 0)),
        finale=FinaleSettings(
            every_minutes=int((raw.get("finale") or {}).get("every_minutes", 15)),
            max_hours=int((raw.get("finale") or {}).get("max_hours", 8)),
            remind_days_before_end=int((raw.get("finale") or {}).get("remind_days_before_end", 3)),
        ),
        off_days=_off_days(camp.get("off_days")),
        today_cooldown_minutes=int((raw.get("today_check") or {}).get("cooldown_minutes", 10)),
        signals={**SIGNAL_DEFAULTS, **(raw.get("signals") or {})},
    )
