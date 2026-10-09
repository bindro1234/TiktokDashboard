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

// ---------- Instagram handles (same rules as normalize_instagram_handle in collector/handles.py) ----------

const IG_RE = /^[a-z0-9._]{1,30}$/;
const IG_URL_RE = /(?:instagram\.com|instagr\.am)\/([^?#]*)/i;
// First path segment of instagram.com links that is not a profile (/p/<code>, /explore, ...).
const IG_NOT_PROFILE = new Set(["p", "reel", "reels", "tv", "explore", "accounts", "direct", "about", "web", "legal",
  "developer", "directory", "challenge", "emails", "session", "oauth", "login", "share"]);

/** name, @Name, instagram.com/name, a profile link with ?igsh=..., /name/reel/... links; not a link to a post. */
export function normalizeInstagramHandle(raw) {
  let text = String(raw ?? "").replace(/\s+/g, "").toLowerCase();
  if (!text) return { handle: null, reason: "lege handle" };
  if (text.includes("instagram.com") || text.includes("instagr.am") || text.startsWith("http")) {
    const m = text.match(IG_URL_RE);
    const parts = (m ? m[1] : "").split("/").filter(Boolean);
    if (!parts.length) return { handle: null, reason: "link zonder /handle" };
    let first = parts[0];
    if (IG_NOT_PROFILE.has(first)) return { handle: null, reason: "link naar een post of pagina, niet naar een profiel" };
    if (first === "_u" || first === "stories") { // instagram.com/_u/name (app link), instagram.com/stories/name/123
      if (parts.length < 2) return { handle: null, reason: "link zonder /handle" };
      first = parts[1];
    }
    text = first;
  }
  text = text.replace(/^@+/, "");
  if (!IG_RE.test(text) || text.endsWith(".") || text.includes("..")) return { handle: null, reason: "geen geldige Instagram-handle" };
  return { handle: text, reason: null };
}

/** The Instagram cell of an accounts row: column instagram_handle, or the old "Insta " column. */
export function instagramCell(row) {
  for (const [key, value] of Object.entries(row)) {
    if (["instagram_handle", "insta"].includes(key.trim().toLowerCase())) return value;
  }
  return "";
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
  const seenIg = new Map();
  for (const r of rows) {
    const rawHandle = String(r.tiktok_handle ?? "").trim();
    const name = String(r.student_name ?? "").trim();
    const igRaw = String(instagramCell(r) ?? "").trim();
    const ig = igRaw ? normalizeInstagramHandle(igRaw) : { handle: null, reason: null };
    const entry = { row: r._row, name, rawHandle, handle: null, active: parseActive(r.active), issue: null, tracked: false,
      // Instagram: one account per student, on the student's first row (no main_account).
      instagramRaw: igRaw, instagram: ig.handle, instagramIssue: igRaw && !ig.handle ? ig.reason : null,
      instagramTracked: false, mainRaw: String(r.main_account ?? "").trim() };
    if (!rawHandle) {
      if (!name && !igRaw && String(r.active ?? "").trim() === "") continue; // empty row
      if (!ig.handle) entry.issue = "geen handle ingevuld";
      // A student with only Instagram is no TikTok problem: there is just nothing to follow on TikTok.
      else if (entry.active === null) entry.issue = `actief='${r.active}' niet begrepen (gebruik ja/nee)`;
      markInstagram(entry, seenIg);
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
    const main = String(r.main_account ?? "").trim() ? normalizeHandle(r.main_account).handle : null;
    entry.main = main && main !== handle ? main : null;
    markInstagram(entry, seenIg);
    out.push(entry);
  }
  // Second accounts (main_account = the handle of the student's first account) join that student's
  // group. Same rules as collector/handles.py account_groups: the main account must be tracked and
  // not an extra account itself; otherwise the account counts on its own and gets a note.
  const tracked = new Map(out.filter((e) => e.tracked).map((e) => [e.handle, e]));
  for (const e of out) {
    e.group = e.handle;
    if (!e.tracked || !e.main) continue;
    const m = tracked.get(e.main);
    if (m && !m.main) e.group = m.handle;
    else e.groupIssue = `hoofdaccount @${e.main} is niet actief (of zelf een extra account): telt nu apart`;
  }
  return out;
}

// Same rules as parse_instagram_accounts in collector/handles.py: only active rows count, a handle on a
// second TikTok account's row is ignored (and reported), and two students can't share one handle.
function markInstagram(e, seenIg) {
  if (!e.instagram || e.active !== true) return;
  if (e.mainRaw) {
    e.instagramIssue = "Instagram hoort bij de leerling: zet de handle op de eerste rij van de leerling (deze wordt genegeerd)";
    return;
  }
  if (seenIg.has(e.instagram)) {
    e.instagramIssue = `dubbel: Instagram @${e.instagram} staat ook in rij ${seenIg.get(e.instagram)}`;
    return;
  }
  seenIg.set(e.instagram, e.row);
  e.instagramTracked = true;
}

/** Key of a student with only an Instagram account (no TikTok handle): "instagram:<handle>". */
export const instagramKey = (handle) => `instagram:${handle}`;

/**
 * Tracked accounts per student: Map(group -> { key, name, accounts, instagram, instagramRow, instagramIssue })
 * with the main account first. key = the main account's handle; name = the name on the main account's row;
 * instagram = the student's Instagram handle (from the main account's row), or null.
 * A student with only an Instagram account (active row, no TikTok handle) is a group too: key
 * "instagram:<handle>", accounts empty. Same grouping as collector/handles.py.
 */
export function groupAccounts(accounts) {
  const groups = new Map();
  for (const a of accounts.filter((x) => x.tracked)) {
    if (!groups.has(a.group)) groups.set(a.group, { key: a.group, name: "", accounts: [] });
    const g = groups.get(a.group);
    if (a.handle === a.group) g.accounts.unshift(a); else g.accounts.push(a);
  }
  for (const g of groups.values()) {
    const main = g.accounts[0];
    g.name = main.name || g.accounts.find((a) => a.name)?.name || "";
    g.instagram = main.instagramTracked ? main.instagram : null;
    g.instagramRow = main.row;
    g.instagramIssue = main.instagramIssue || null;
  }
  for (const a of accounts.filter((x) => !x.handle && x.instagramTracked)) {
    const key = instagramKey(a.instagram);
    groups.set(key, { key, name: a.name, accounts: [], instagram: a.instagram, instagramRow: a.row, instagramIssue: null });
  }
  return groups;
}

/** Rows of the public ig_posts tab as posts for studentStats: marked platform "instagram", with the fields
 * the page reads (video_id = post_id, so a post can be found by one key on both platforms). */
export function instagramPosts(rows) {
  return (rows || []).filter((r) => String(r.post_id ?? "").trim())
    .map((r) => ({ ...r, platform: "instagram", video_id: String(r.post_id) }));
}

/**
 * Several accounts' history series (each [{ t, views, followers, posts, likes }], sorted) as one:
 * at every run time, the sum of each account's latest value up to then. Partial runs (Vandaag
 * checks) only write rows for some accounts, so a plain per-timestamp sum would dip.
 */
export function mergeSeries(list) {
  const series = list.filter((s) => s && s.length);
  if (series.length <= 1) return series[0] ? [...series[0]] : [];
  const times = [...new Set(series.flatMap((s) => s.map((p) => p.t)))].sort((a, b) => a - b);
  const idx = series.map(() => -1);
  return times.map((t) => {
    const out = { t, views: 0, followers: null, posts: 0, likes: 0 };
    series.forEach((s, i) => {
      while (idx[i] + 1 < s.length && s[idx[i] + 1].t <= t) idx[i]++;
      const p = s[idx[i]];
      if (!p) return;
      out.views += p.views || 0;
      out.posts += p.posts || 0;
      out.likes += p.likes || 0;
      if (p.followers != null) out.followers = (out.followers || 0) + p.followers;
    });
    return out;
  });
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

// Full profiles runs per platform (same as PROFILE_RUN_TYPES / IG_PROFILE_RUN_TYPES in collector/model.py): a
// TikTok run never makes an Instagram window skip, and the other way round; both count toward the same cap.
const PROFILE_RUN_TYPES = new Set(["profiles", "force_refresh"]);
export const IG_PROFILE_RUN_TYPES = new Set(["ig_profiles", "ig_force_refresh"]);
export const PLATFORMS = ["tiktok", "instagram"];
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

/** Time (ms) of the last profiles run (of these run types: TikTok's by default) that started a Bright Data job, or null. */
export function lastProfilesRun(runLog, types = PROFILE_RUN_TYPES) {
  let last = null;
  for (const r of runLog) {
    if (!types.has(r.run_type) || truthy(r.dry_run)) continue;
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

/**
 * The windows a platform really runs in (config.yaml frequency): a subset of the pool schedule.profileRuns.
 * TikTok windows are keyed 08u, Instagram windows ig-08u (config.json already has the names that way).
 */
export function platformWindows(cfg, platform) {
  return cfg.schedule.windows?.[platform] ?? (platform === "tiktok" ? cfg.schedule.profileRuns : []);
}

/** Scheduled profile windows of a platform still to come this calendar month that have not run yet. */
export function remainingProfileRuns(cfg, nowMs, done, platform = "tiktok") {
  const today = localDay(nowMs);
  const now = localTime(nowMs);
  const month = today.slice(0, 7);
  let count = 0;
  for (let day = today; day <= cfg.campaign.collectUntil; day = addDays(day, 1)) {
    if (day.slice(0, 7) !== month) break;
    if (day < cfg.campaign.start) continue;
    for (const w of platformWindows(cfg, platform)) {
      if (day === today && w.end <= now) continue;
      if (done.has(`${day}/${w.name}`)) continue;
      count++;
    }
  }
  return count;
}

// ---------- collector windows (same rules as Collector.auto in collector/runner.py) ----------

const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" });

// ---------- finale (same rules as finale_state / finale_window_key in collector/model.py) ----------

/**
 * The current finale from the finale tab rows (last row counts), or null.
 * { start, end, deadline, status, phase: "live" | "ended" | null, startedBy? }
 * end = the deadline, never later than start + maxHours, or the stop time for a stopped finale.
 */
export function finaleState(rows, nowMs, maxHours) {
  if (!rows || !rows.length) return null;
  const r = rows[rows.length - 1];
  const start = parseTs(r.started_at), deadline = parseTs(r.deadline);
  const status = String(r.status ?? "").trim();
  if (start === null || deadline === null || !["active", "stopped"].includes(status)) return null;
  let end = Math.min(deadline, start + maxHours * 3600e3);
  if (status === "stopped") end = Math.min(end, parseTs(r.ended_at) ?? end);
  const phase = start <= nowMs && nowMs < end ? "live" : nowMs >= end ? "ended" : null;
  return { start, end, deadline, status, phase, startedBy: r.started_by || null, row: r._row || null };
}

/** Key of the finale run due now: Amsterdam time floored to everyMinutes, e.g. 2026-10-26/finale-1615. */
export function finaleWindowKey(nowMs, everyMinutes) {
  const [h, m] = localTime(nowMs).split(":").map(Number);
  const mm = m - (m % everyMinutes);
  return `${localDay(nowMs)}/finale-${String(h).padStart(2, "0")}${String(mm).padStart(2, "0")}`;
}

/** Epoch ms of an Amsterdam wall-clock time ("2026-10-26", "20:00"), summer or winter time. */
export function amsMs(day, hhmm) {
  for (const off of [2, 1, 0]) {
    const t = Date.parse(`${day}T${hhmm}:00Z`) - off * 3600e3;
    if (localTime(t) === hhmm && localDay(t) === day) return t;
  }
  return Date.parse(`${day}T${hhmm}:00Z`);
}

/** Records a finale costs: runs every everyMinutes until end, one record per active account. */
export function finaleRuns(startMs, endMs, everyMinutes) {
  return Math.max(0, Math.ceil((endMs - startMs) / (everyMinutes * 60e3)));
}

/** Window keys ("YYYY-MM-DD/name") that are open right now, Amsterdam time. */
export function openWindows(cfg, nowMs, finale = null) {
  const day = localDay(nowMs);
  const time = localTime(nowMs);
  const inside = (w) => w.start <= time && time <= w.end;
  // A live finale replaces the normal windows (runs every few minutes, even after campaign.end), for both platforms.
  if (finale && finale.phase === "live") {
    const key = finaleWindowKey(nowMs, cfg.finale.everyMinutes);
    const open = [key, key.replace("/finale-", "/ig-finale-")];
    const r = cfg.schedule.refresh;
    if (weekdayFmt.format(nowMs).toLowerCase() === r.weekday && inside(r)) open.push(`${day}/${r.name}`);
    return open;
  }
  if (day < cfg.campaign.start || day > cfg.campaign.collectUntil) return [];
  const open = PLATFORMS.flatMap((p) => platformWindows(cfg, p)).filter(inside).map((w) => `${day}/${w.name}`);
  const r = cfg.schedule.refresh;
  if (weekdayFmt.format(nowMs).toLowerCase() === r.weekday && inside(r)) open.push(`${day}/${r.name}`);
  return open;
}

/**
 * Open windows that still need a collector run: not done, and not failed max-attempts times.
 * On the window-check date, the check is due once the evening window is done (while it is open).
 */
export function dueWindows(cfg, runLog, nowMs, finale = null) {
  const done = doneWindows(runLog);
  const failures = new Map();
  for (const r of runLog) {
    if (!truthy(r.dry_run) && r.window && String(r.status) === "failed") {
      failures.set(String(r.window), (failures.get(String(r.window)) || 0) + 1);
    }
  }
  const pending = (key) => !done.has(key) && (failures.get(key) || 0) < cfg.schedule.maxAttemptsPerWindow;
  const open = openWindows(cfg, nowMs, finale);
  const due = open.filter(pending);
  const day = localDay(nowMs);
  const evening = platformWindows(cfg, "tiktok").at(-1);
  if (evening && cfg.windowCheckDate === day && open.includes(`${day}/${evening.name}`) && done.has(`${day}/${evening.name}`)
      && pending(`${day}/window-check`)) {
    due.push(`${day}/window-check`);
  }
  return due;
}

/**
 * The month's budget: records used (run_log, both platforms) and what the scheduled runs still to come
 * will use. counts = { tiktok: accounts, instagram: accounts } (a plain number counts as TikTok only).
 * Same numbers as Collector.reserve_by_platform in collector/runner.py.
 */
export function budget(cfg, runLog, counts, nowMs) {
  const used = monthUsage(runLog, nowMs);
  const done = doneWindows(runLog);
  const accounts = typeof counts === "number" ? { tiktok: counts, instagram: 0 } : counts;
  const byPlatform = {};
  let runsLeft = 0, reserved = 0;
  for (const platform of PLATFORMS) {
    const runs = remainingProfileRuns(cfg, nowMs, done, platform);
    const n = accounts[platform] ?? 0;
    byPlatform[platform] = { runsLeft: runs, accounts: n, reserved: runs * n };
    runsLeft += runs;
    reserved += runs * n;
  }
  return { used, cap: cfg.budget.monthlyCap, runsLeft, reserved, projected: used + reserved, byPlatform };
}

// ---------- per student statistics ----------

/**
 * Free day (config.yaml campaign.off_days: weekends and holidays): posting is optional.
 * A post still adds to the streak; no post never breaks it, isn't missed and isn't warned about.
 */
export function isOffDay(cfg, day) {
  const off = cfg.offDays || {};
  if (off.weekends && [0, 6].includes(new Date(day + "T00:00:00Z").getUTCDay())) return true;
  return (off.periods || []).some((p) => day >= p.from && day <= p.to);
}

/** The holiday a day falls in (name), or "weekend", or null. */
export function offDayName(cfg, day) {
  const p = (cfg.offDays?.periods || []).find((x) => day >= x.from && day <= x.to);
  if (p) return p.name;
  return isOffDay(cfg, day) ? "weekend" : null;
}

/** An Instagram post (rows of ig_posts, marked platform: "instagram"); anything else is a TikTok post. */
export const isInstagramPost = (p) => p.platform === "instagram";

/**
 * Posts of one account, or of a student's accounts together (TikTok posts from posts_latest, Instagram posts
 * marked platform: "instagram") -> calendar and grading numbers.
 * A day counts as posted when there is at least one post on ANY platform; the streak, missed days, "geen post"
 * and dagopdrachten all follow from that. Views, likes, comments, shares, engagement and the best video exist
 * for TikTok only (an Instagram record has no likes or views), so those only add up TikTok posts.
 * Days are Amsterdam dates. Today is never counted as missed (the day isn't over), and neither is
 * a free day (isOffDay): a post on it extends the streak, no post simply doesn't count.
 * options.from: first day that can be judged (the Instagram start date for a student with only Instagram:
 * nothing was measured before it). Earlier days count as free: never missed, never a broken streak.
 */
export function studentStats(posts, cfg, nowMs, assignments = [], { from = null } = {}) {
  const days = campaignDays(cfg);
  const today = localDay(nowMs);
  const perDay = new Map(days.map((d) => [d, 0]));
  const byDay = new Map(); // day -> { tiktok, instagram }: which platform the posts of a day were on
  let views = 0, likes = 0, comments = 0, shares = 0, best = null, last = null, lastPlatform = null, missing = 0;
  const tags = new Map();
  const counted = [];
  const tiktok = [];
  for (const p of posts) {
    const t = parseTs(p.created_at);
    if (t === null) continue;
    const day = localDay(t);
    if (!perDay.has(day)) continue;
    counted.push(p);
    perDay.set(day, perDay.get(day) + 1);
    const on = byDay.get(day) || { tiktok: 0, instagram: 0 };
    on[isInstagramPost(p) ? "instagram" : "tiktok"]++;
    byDay.set(day, on);
    if (last === null || t > last) { last = t; lastPlatform = isInstagramPost(p) ? "instagram" : "tiktok"; }
    for (const tag of new Set(String(p.hashtags ?? "").toLowerCase().split(/\s+/).filter(Boolean))) {
      tags.set(tag, (tags.get(tag) || 0) + 1);
    }
    if (isInstagramPost(p)) continue;
    tiktok.push(p);
    const v = toNum(p.views) || 0;
    views += v;
    likes += toNum(p.likes) || 0;
    comments += toNum(p.comments) || 0;
    shares += toNum(p.shares) || 0;
    if (!best || v > best.views) best = { id: String(p.video_id), handle: String(p.handle ?? ""), views: v, created: t };
    if (String(p.missing_since ?? "").trim()) missing++;
  }
  const past = days.filter((d) => d < today);
  const off = (day) => (from !== null && day < from) || isOffDay(cfg, day);
  const offName = (day) => offDayName(cfg, day) || (from !== null && day < from ? "nog niet gevolgd" : null);
  const missed = past.filter((d) => perDay.get(d) === 0 && !off(d));
  // Streak = days with a post, counted back from today (from the last campaign day once it is over).
  // Only a missed day breaks it: nothing yet today and free days without a post are skipped.
  let streak = 0;
  for (let d = today < days.at(-1) ? today : days.at(-1); perDay.has(d); d = addDays(d, -1)) {
    if (perDay.get(d) > 0) streak++;
    else if (d < today && !off(d)) break;
  }
  let longest = 0, run = 0;
  for (const day of days) {
    if (day > today) break;
    if (perDay.get(day) > 0) run++;
    else if (day < today && !off(day)) run = 0;
    longest = Math.max(longest, run);
  }
  const lastDay = last !== null ? localDay(last) : null;
  const campaignStarted = today >= cfg.campaign.start;
  // Days without a post since the last one (or since the start), up to and including today,
  // leaving out free days. Drives the "geen post" warning.
  const quietDays = !campaignStarted ? null
    : days.filter((d) => d <= today && (lastDay ? d > lastDay : true) && !off(d)).length;
  // Dagopdrachten: a minimum number of posts on a day. Only judged once the day is over; never
  // touches the streak or missed days (one post is enough for those).
  const tasks = assignments.filter((a) => perDay.has(a.date)).map((a) => {
    const count = perDay.get(a.date);
    return { ...a, count, status: count >= a.min ? "reached" : a.date < today ? "missed" : "pending" };
  });
  return {
    perDay, byDay, today, isOff: off, offName,
    posts: counted.length, tiktokPosts: tiktok.length, instagramPosts: counted.length - tiktok.length,
    daysPosted: days.filter((x) => x <= today && perDay.get(x) > 0).length,
    missedDays: missed.length, missedList: missed,
    streak, longest,
    views, likes, comments, shares,
    avgViews: tiktok.length ? Math.round(views / tiktok.length) : null,
    // Views of the typical video: unlike the average, one viral video hardly moves it.
    medianViews: tiktok.length ? Math.round(median(tiktok.map((p) => toNum(p.views) || 0))) : null,
    engagement: views ? (likes + comments + shares) / views : null,
    best, last, lastDay, lastPlatform,
    quietDays,
    daysSinceLast: !campaignStarted ? null : lastDay ? dayDiff(today, lastDay) : dayDiff(today, cfg.campaign.start),
    missing,
    tasks, tasksMissed: tasks.filter((t) => t.status === "missed").length,
    tags: [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

// ---------- dagopdrachten, Vandaag, buiten schaal ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Sheet date cell -> "YYYY-MM-DD" (accepts a typed date, an ISO text or a Sheets serial number). */
export function sheetDate(v) {
  if (typeof v === "number" && v > 30000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  const s = String(v ?? "").trim().slice(0, 10);
  return DATE_RE.test(s) ? s : null;
}

/** Active dagopdrachten from the private tab: [{ row, date, min, label }] by date; the last row of a date wins. */
export function parseAssignments(rows) {
  const byDate = new Map();
  for (const r of rows || []) {
    const date = sheetDate(r.date);
    const min = toNum(r.min_posts);
    if (!date || !Number.isInteger(min) || min < 1 || parseActive(r.active) === false) continue;
    byDate.set(date, { row: r._row ?? null, date, min, label: String(r.label ?? "").trim() });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Handles marked "buiten schaal" in the public outliers tab. */
export function parseOutliers(rows) {
  const out = new Set();
  for (const r of rows || []) {
    const { handle } = normalizeHandle(r.handle);
    if (handle && truthy(r.buiten_schaal)) out.add(handle);
  }
  return out;
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Vandaag: per student the campaign posts of today (Amsterdam, all their accounts together, TikTok and
 * Instagram), how many are needed (1, or the dagopdracht minimum) and whether that is reached. Private accounts
 * can't be checked. students: [{ handle, posts, isPrivate, accounts?: [{ handle, isPrivate, platform? }] }].
 * "checkable" lists the TikTok accounts "Controleer nu" can fetch (its Instagram part comes with the
 * frequency settings). Returns { day, task, offDay, rows }.
 */
export function todayStatus(cfg, students, assignments, nowMs) {
  const day = localDay(nowMs);
  const task = (assignments || []).find((a) => a.date === day) || null;
  const required = task ? task.min : 1;
  const rows = students.map((s) => {
    const today = (s.posts || []).map((p) => parseTs(p.created_at)).filter((t) => t !== null && localDay(t) === day).sort((a, b) => a - b);
    const accounts = s.accounts || [{ handle: s.handle, isPrivate: s.isPrivate }];
    return { handle: s.handle, count: today.length, required, done: today.length >= required,
      private: accounts.every((a) => a.isPrivate),
      checkable: accounts.filter((a) => !a.isPrivate && a.platform !== "instagram").map((a) => a.handle),
      first: today[0] ?? null, last: today.at(-1) ?? null };
  });
  return { day, task, offDay: isOffDay(cfg, day), rows };
}

/** Accounts "Controleer nu" fetches: every non-private account of the students not done yet today. */
export function todayTargets(status) {
  return status.rows.filter((r) => !r.done && !r.private).flatMap((r) => r.checkable);
}

/** Start time (ms) of the last Vandaag check: its activity_log entry or its run_log row. */
export function lastTodayCheck(runLog, activity) {
  let last = null;
  for (const r of runLog || []) {
    if (r.run_type !== "today_check" || truthy(r.dry_run)) continue;
    const t = parseTs(r.timestamp);
    if (t !== null && (last === null || t > last)) last = t;
  }
  for (const a of activity || []) {
    if (a.action !== TODAY_CHECK_ACTION) continue;
    const t = parseTs(a.timestamp);
    if (t !== null && (last === null || t > last)) last = t;
  }
  return last;
}
export const TODAY_CHECK_ACTION = "vandaag gecontroleerd";

// ---------- Opvallend (signals worth a look; private site only) ----------

/**
 * Flags per video and account, relative to the class. Never a verdict: each flag carries its numbers.
 * s: signal settings (config.json signals). posts: [{ handle, video_id, views, likes, comments, shares, created_at }].
 * byVideo: Map(video_id -> [{ t, views }]) from post_history. series: Map(handle -> [{ t, views, followers }]) from history.
 */
export function signals(s, posts, byVideo, series) {
  const flags = [];
  const big = posts.filter((p) => (toNum(p.views) || 0) >= s.minViews);
  // 1. Likes per view far from the class median.
  const ratio = (p) => (toNum(p.likes) || 0) / (toNum(p.views) || 1);
  const med = median(big.map(ratio));
  if (med) {
    for (const p of big) {
      const r = ratio(p);
      if (r * s.likeRatioFactor <= med || r >= med * s.likeRatioFactor) {
        flags.push({ kind: "likes", handle: p.handle, video: String(p.video_id), views: toNum(p.views), likes: toNum(p.likes) || 0,
          ratio: r, median: med, high: r > med });
      }
    }
  }
  // 2. Step-shaped growth: one short step brings most of the views, then (nearly) flat.
  for (const p of big) {
    const pts = (byVideo && byVideo.get(String(p.video_id))) || [];
    const total = Math.max(toNum(p.views) || 0, pts.length ? pts.at(-1).views : 0);
    let best = null;
    for (let i = 1; i < pts.length; i++) {
      const step = pts[i].views - pts[i - 1].views;
      if (pts[i].t - pts[i - 1].t > s.stepMaxHours * 3600e3 || step < s.stepShare * total) continue;
      const after = pts.filter((q) => q.t > pts[i].t && q.t <= pts[i].t + s.flatHours * 3600e3);
      if (!after.length || after.at(-1).t - pts[i].t < s.flatHours * 3600e3 * 0.75) continue; // not enough "after" yet
      const growth = after.at(-1).views - pts[i].views;
      if (growth > s.flatShare * step) continue;
      if (!best || step > best.step) best = { step, from: pts[i - 1], to: pts[i], after: growth };
    }
    if (best) flags.push({ kind: "step", handle: p.handle, video: String(p.video_id), views: total, ...best, share: best.step / total });
  }
  // 3. Many views, no comments and no shares at all.
  for (const p of posts) {
    const v = toNum(p.views) || 0;
    if (v >= s.zeroEngagementMinViews && !(toNum(p.comments) || 0) && !(toNum(p.shares) || 0)) {
      flags.push({ kind: "silent", handle: p.handle, video: String(p.video_id), views: v, likes: toNum(p.likes) || 0 });
    }
  }
  // 4. A follower jump between two runs without matching views (relative to the class median of
  //    views per new follower over the whole campaign).
  const vpf = [];
  for (const list of (series || new Map()).values()) {
    const f = list.filter((x) => x.followers != null);
    if (f.length < 2) continue;
    const dF = f.at(-1).followers - f[0].followers, dV = f.at(-1).views - f[0].views;
    if (dF > 0 && dV > 0) vpf.push(dV / dF);
  }
  const medVpf = median(vpf);
  for (const [handle, list] of (series || new Map())) {
    const f = list.filter((x) => x.followers != null);
    let best = null;
    for (let i = 1; i < f.length; i++) {
      const dF = f[i].followers - f[i - 1].followers, dV = Math.max(0, f[i].views - f[i - 1].views);
      if (dF < s.followerJumpMin) continue;
      const per = dV / dF;
      if (medVpf != null && per * s.followerJumpFactor > medVpf) continue;
      if (!best || dF > best.followers) best = { followers: dF, views: dV, per, from: f[i - 1].t, to: f[i].t };
    }
    if (best) flags.push({ kind: "followers", handle, ...best, median: medVpf });
  }
  return flags;
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
