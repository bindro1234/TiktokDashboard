// Pure logic shared by the private Worker (src/worker.js) and the private page (app.js).
// No DOM, no network. Ported from the Python collector where both must agree
// (handle normalization, accounts parsing, budget); see private/test.

export const TZ = "Europe/Amsterdam";

// ---------- handles (same rules as collector/handles.py) ----------

const HANDLE_RE = /^[a-z0-9_.]{1,24}$/;
const URL_HANDLE_RE = /tiktok\.com\/@([^/?#]+)/i;
const ACTIVE_YES = new Set(["ja", "j", "yes", "y", "true", "waar", "1", "x", "actief"]);
const ACTIVE_NO = new Set(["nee", "n", "no", "false", "onwaar", "0", "inactief"]);

export function normalizeHandle(raw) {
  let text = String(raw ?? "").replace(/\s+/g, "").toLowerCase();
  if (!text) return { handle: null, reason: "lege handle" };
  if (text.includes("tiktok.com") || text.startsWith("http")) {
    const m = text.match(URL_HANDLE_RE);
    if (!m) return { handle: null, reason: "link zonder /@handle (korte vm.tiktok.com-links werken niet)" };
    text = m[1];
  }
  text = text.replace(/^@+/, "");
  if (!HANDLE_RE.test(text) || text.endsWith(".")) return { handle: null, reason: "geen geldige TikTok-handle" };
  return { handle: text, reason: null };
}

/** Blank counts as active. Returns null for values we don't understand. */
export function parseActive(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "" || ACTIVE_YES.has(text)) return true;
  if (ACTIVE_NO.has(text)) return false;
  return null;
}

/**
 * Every filled row of the accounts tab with its sheet row number, normalized handle,
 * active flag and problem (if any). Mirrors collector/handles.py parse_accounts:
 * only rows without a problem and active are tracked.
 */
export function parseAccounts(rows) {
  const out = [];
  const seen = new Map();
  for (const r of rows) {
    const rawHandle = String(r.tiktok_handle ?? "").trim();
    const name = String(r.student_name ?? "").trim();
    const entry = { row: r._row, name, rawHandle, handle: null, active: parseActive(r.active), issue: null, tracked: false };
    if (!rawHandle) {
      if (!name && String(r.active ?? "").trim() === "") continue; // empty row
      entry.issue = "geen handle ingevuld";
      out.push(entry);
      continue;
    }
    const { handle, reason } = normalizeHandle(rawHandle);
    entry.handle = handle;
    if (!handle) entry.issue = reason;
    else if (entry.active === null) entry.issue = `actief='${r.active}' niet begrepen (gebruik ja/nee)`;
    else if (entry.active && seen.has(handle)) entry.issue = `dubbel: staat ook in rij ${seen.get(handle)}`;
    else if (entry.active) {
      seen.set(handle, entry.row);
      entry.tracked = true;
    }
    out.push(entry);
  }
  return out;
}

// ---------- small helpers ----------

export const truthy = (v) => ["true", "1", "ja", "yes", "waar"].includes(String(v ?? "").trim().toLowerCase());
export const toNum = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};
export const parseTs = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** YYYY-MM-DD in Amsterdam. */
export const localDay = (ms) => dayFmt.format(ms);
/** HH:MM in Amsterdam. */
export const localTime = (ms) => timeFmt.format(ms);
export const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
export const dayDiff = (a, b) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 864e5);

export function campaignDays(cfg) {
  const days = [];
  for (let d = cfg.campaign.start; d <= cfg.campaign.end; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Rows of a sheet (array of arrays, first row = header) to objects; _row is the sheet row number. */
export function rowsToObjects(values) {
  if (!values || !values.length) return [];
  const header = values[0].map((h) => String(h).trim());
  const out = [];
  values.slice(1).forEach((row, i) => {
    if (!row.some((c) => String(c ?? "").trim() !== "")) return;
    const obj = { _row: i + 2 };
    header.forEach((h, j) => { if (h) obj[h] = row[j] ?? ""; });
    out.push(obj);
  });
  return out;
}

// ---------- run_log and budget (same rules as collector/model.py) ----------

const PROFILE_RUN_TYPES = new Set(["profiles", "force_refresh"]);
const DONE_STATUSES = new Set(["ok", "partial", "refused", "skipped"]);

export function monthUsage(runLog, nowMs) {
  const ym = new Date(nowMs).toISOString().slice(0, 7); // UTC month, like the collector
  let total = 0;
  for (const r of runLog) {
    if (truthy(r.dry_run)) continue;
    const t = parseTs(r.timestamp);
    if (t !== null && new Date(t).toISOString().slice(0, 7) === ym) total += toNum(r.actual_records) || 0;
  }
  return total;
}

/** Time (ms) of the last profiles run that started a Bright Data job, or null. */
export function lastProfilesRun(runLog) {
  let last = null;
  for (const r of runLog) {
    if (!PROFILE_RUN_TYPES.has(r.run_type) || truthy(r.dry_run)) continue;
    if (!String(r.snapshot_ids ?? "").trim()) continue;
    const t = parseTs(r.timestamp);
    if (t !== null && (last === null || t > last)) last = t;
  }
  return last;
}

export function doneWindows(runLog) {
  const done = new Set();
  for (const r of runLog) {
    if (!truthy(r.dry_run) && r.window && DONE_STATUSES.has(String(r.status))) done.add(String(r.window));
  }
  return done;
}

/** Scheduled profile windows still to come this calendar month that have not run yet. */
export function remainingProfileRuns(cfg, nowMs, done) {
  const today = localDay(nowMs);
  const now = localTime(nowMs);
  const month = today.slice(0, 7);
  let count = 0;
  for (let day = today; day <= cfg.campaign.collectUntil; day = addDays(day, 1)) {
    if (day.slice(0, 7) !== month) break;
    if (day < cfg.campaign.start) continue;
    for (const w of cfg.schedule.profileRuns) {
      if (day === today && w.end <= now) continue;
      if (done.has(`${day}/${w.name}`)) continue;
      count++;
    }
  }
  return count;
}

// ---------- collector windows (same rules as Collector.auto in collector/runner.py) ----------

const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" });

/** Window keys ("YYYY-MM-DD/name") that are open right now, Amsterdam time. */
export function openWindows(cfg, nowMs) {
  const day = localDay(nowMs);
  const time = localTime(nowMs);
  if (day < cfg.campaign.start || day > cfg.campaign.collectUntil) return [];
  const inside = (w) => w.start <= time && time <= w.end;
  const open = cfg.schedule.profileRuns.filter(inside).map((w) => `${day}/${w.name}`);
  const r = cfg.schedule.refresh;
  if (weekdayFmt.format(nowMs).toLowerCase() === r.weekday && inside(r)) open.push(`${day}/${r.name}`);
  return open;
}

/**
 * Open windows that still need a collector run: not done, and not failed max-attempts times.
 * On the window-check date, the check is due once the evening window is done (while it is open).
 */
export function dueWindows(cfg, runLog, nowMs) {
  const done = doneWindows(runLog);
  const failures = new Map();
  for (const r of runLog) {
    if (!truthy(r.dry_run) && r.window && String(r.status) === "failed") {
      failures.set(String(r.window), (failures.get(String(r.window)) || 0) + 1);
    }
  }
  const pending = (key) => !done.has(key) && (failures.get(key) || 0) < cfg.schedule.maxAttemptsPerWindow;
  const open = openWindows(cfg, nowMs);
  const due = open.filter(pending);
  const day = localDay(nowMs);
  const evening = cfg.schedule.profileRuns.at(-1);
  if (cfg.windowCheckDate === day && open.includes(`${day}/${evening.name}`) && done.has(`${day}/${evening.name}`)
      && pending(`${day}/window-check`)) {
    due.push(`${day}/window-check`);
  }
  return due;
}

export function budget(cfg, runLog, activeCount, nowMs) {
  const used = monthUsage(runLog, nowMs);
  const runs = remainingProfileRuns(cfg, nowMs, doneWindows(runLog));
  return { used, cap: cfg.budget.monthlyCap, runsLeft: runs, reserved: runs * activeCount, projected: used + runs * activeCount };
}

// ---------- per student statistics ----------

/**
 * Posts of one account (campaign posts from posts_latest) -> calendar and grading numbers.
 * Days are Amsterdam dates. Today is never counted as missed (the day isn't over).
 */
export function studentStats(posts, cfg, nowMs) {
  const days = campaignDays(cfg);
  const today = localDay(nowMs);
  const perDay = new Map(days.map((d) => [d, 0]));
  let views = 0, likes = 0, comments = 0, shares = 0, best = null, last = null, missing = 0;
  const tags = new Map();
  const counted = [];
  for (const p of posts) {
    const t = parseTs(p.created_at);
    if (t === null) continue;
    const day = localDay(t);
    if (!perDay.has(day)) continue;
    counted.push(p);
    perDay.set(day, perDay.get(day) + 1);
    const v = toNum(p.views) || 0;
    views += v;
    likes += toNum(p.likes) || 0;
    comments += toNum(p.comments) || 0;
    shares += toNum(p.shares) || 0;
    if (!best || v > best.views) best = { id: String(p.video_id), views: v, created: t };
    if (last === null || t > last) last = t;
    if (String(p.missing_since ?? "").trim()) missing++;
    for (const tag of new Set(String(p.hashtags ?? "").toLowerCase().split(/\s+/).filter(Boolean))) {
      tags.set(tag, (tags.get(tag) || 0) + 1);
    }
  }
  const past = days.filter((d) => d < today);
  const missed = past.filter((d) => perDay.get(d) === 0);
  // Current streak: consecutive days with a post up to today (or up to yesterday if nothing yet today).
  let streak = 0;
  let d = perDay.get(today) ? today : addDays(today, -1);
  while (perDay.has(d) && perDay.get(d) > 0) { streak++; d = addDays(d, -1); }
  let longest = 0, run = 0;
  for (const day of days) {
    if (day > today) break;
    run = perDay.get(day) > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const lastDay = last !== null ? localDay(last) : null;
  const campaignStarted = today >= cfg.campaign.start;
  return {
    perDay, today,
    posts: counted.length,
    daysPosted: days.filter((x) => x <= today && perDay.get(x) > 0).length,
    missedDays: missed.length, missedList: missed,
    streak, longest,
    views, likes, comments, shares,
    avgViews: counted.length ? Math.round(views / counted.length) : null,
    engagement: views ? (likes + comments + shares) / views : null,
    best, last, lastDay,
    daysSinceLast: !campaignStarted ? null : lastDay ? dayDiff(today, lastDay) : dayDiff(today, cfg.campaign.start),
    missing,
    tags: [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

/** Per hashtag: posts using it, accounts (with counts), total views. */
export function hashtagStats(postsByHandle) {
  const tags = new Map();
  for (const [handle, list] of postsByHandle) {
    for (const p of list) {
      for (const tag of new Set(String(p.hashtags ?? "").toLowerCase().split(/\s+/).filter(Boolean))) {
        let t = tags.get(tag);
        if (!t) tags.set(tag, (t = { tag, posts: 0, views: 0, accounts: new Map() }));
        t.posts++;
        t.views += toNum(p.views) || 0;
        t.accounts.set(handle, (t.accounts.get(handle) || 0) + 1);
      }
    }
  }
  return [...tags.values()];
}

// ---------- CSV ----------

/** CSV text. Excel NL: ';' and decimal comma. Cells that Excel would run as a formula are quoted with '. */
export function toCsv(header, rows, { sep = ",", decimalComma = false } = {}) {
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (typeof v === "number" && decimalComma) s = s.replace(".", ",");
    if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /["\n\r]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(sep)).join("\r\n") + "\r\n";
}
