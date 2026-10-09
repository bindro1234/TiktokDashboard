"use strict";

// Reads the published CSV tabs of the public sheet and renders standings, charts and growth.
// Everything runs in the browser; there are no keys and no student names anywhere.

const CFG = window.TT_CONFIG;
const TZ = "Europe/Amsterdam";
const MAX_SELECTED = 8; // fixed categorical slots; never generate a 9th colour

const METRICS = {
  views: { label: "Weergaven", key: "total_views" },
  followers: { label: "Volgers", key: "followers" },
  posts: { label: "Posts", key: "campaign_posts" },
  likes: { label: "Likes", key: "campaign_likes" },
};
// Instagram has no views or likes in the data; its ranking is followers gained since the account's
// baseline (its first successful measurement, tab ig_baseline). "gain" is that, per run, in the series.
const IG_METRICS = {
  gain: { label: "Volgers erbij", key: "gain" },
  followers: { label: "Volgers", key: "followers" },
  posts: { label: "Posts", key: "campaign_posts" },
};
const IG_GROWTH_METRICS = { followers: IG_METRICS.followers, posts: IG_METRICS.posts };
// Instagram first: it is where the campaign runs now. The platform switch on Grafiek, Groei and the account pages
// shows these in this order.
const PLATFORMS = {
  instagram: { label: "Instagram", metrics: IG_METRICS, growthMetrics: IG_GROWTH_METRICS, metric: "gain", growthMetric: "followers" },
  tiktok: { label: "TikTok", metrics: METRICS, growthMetrics: METRICS, metric: "views", growthMetric: "views" },
};
const PLATFORM_LABELS = Object.fromEntries(Object.entries(PLATFORMS).map(([k, p]) => [k, p.label]));
// An account measured this long after the first one got its baseline later: marked in the table.
const LATE_BASELINE_MS = 90 * 60 * 1000;
const PERIODS = { day: "Per dag", week: "Per week" };
const RANGES = { all: "Alles", "7d": "7 dagen", "48h": "48 uur" };
const RANGE_MS = { all: null, "7d": 7 * 864e5, "48h": 2 * 864e5 };
const VIDEO_RANGES = { 2: "2 uur", 6: "6 uur", 24: "24 uur" };
const VIDEOS_SHOWN = 25;
const DAY_MS = 864e5;
const BASE_SLACK_MS = 45 * 60 * 1000; // runs start a few minutes apart; "24 h ago" may be 23:15-24:45 ago
const TAG_SORTS = { posts: "Meest gebruikt", views: "Meeste weergaven" };
const TAGS_SHOWN = 30; // rows before "Toon alle"

const PARAMS = new URLSearchParams(location.search);
// Presentation mode (?present): classroom slideshow, see present.js.
const IS_PRESENT = PARAMS.has("present");
// ?nu=2026-10-26T19:30 (Amsterdam time) pretends it is that moment, to check the finale and the
// Eindstand before the day. Only changes what this browser shows.
const CLOCK_OFFSET = (() => {
  const v = PARAMS.get("nu");
  const m = v && v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  return m ? amsMs(m[1], m[2]) - Date.now() : 0;
})();
const now = () => Date.now() + CLOCK_OFFSET;

const state = {
  data: null,            // the dataset of the platform being shown (see useData); all of them are in `all`
  all: { instagram: null, tiktok: null },
  platform: "instagram", // Grafiek, Groei and the account pages show one platform at a time
  view: "stand",
  account: null,
  accountPlatform: "tiktok", // platform of the account page being shown (#account/<handle> = TikTok, #account/ig/<handle>)
  metric: "gain",
  growthMetric: "followers",
  period: "day",
  selected: [],          // handles of the current platform, in the order they were picked
  slotOf: new Map(),     // handle -> colour slot 1..8; colour follows the account, not its rank
  picks: {},             // selected/slotOf of the platforms that are not the current one (see useData)
  dataPlatform: null,    // platform whose selection is in selected/slotOf
  showOthers: false,
  sort: { key: "views", dir: -1 }, // TikTok leaderboard sort; -1 = high to low
  sortIg: { key: "gained", dir: -1 }, // Instagram leaderboard sort
  open: new Set(),       // Stand: students with two accounts whose per-account rows are shown
  accountView: null,     // account page of a student with two accounts: one of them ("" = both)
  tagSort: "posts",
  tagsAll: false,
  tagOpen: null,         // hashtag whose accounts are shown
  range: "all",          // Grafiek: time range
  videoRange: "24",      // Video's: gain over the last 2/6/24 hours
  postHistory: null,     // lazily loaded post_history: { at, byVideo: Map(id -> [{t, views}]) }
  charts: {},
};

// ---------- formatting ----------

const nf = new Intl.NumberFormat("nl-NL");
const compact = new Intl.NumberFormat("nl-NL", { notation: "compact", maximumFractionDigits: 1 });
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const stampFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const shortDayFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: "UTC", day: "numeric", month: "short" });
const postDateFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const fmt = (n) => (n == null ? "–" : nf.format(n));
const signed = (n) => (n == null ? "–" : (n > 0 ? "+" : n < 0 ? "−" : "±") + nf.format(Math.abs(n)));
const localDay = (ms) => dayKeyFmt.format(ms); // YYYY-MM-DD in Amsterdam
const dayMs = (key) => Date.parse(key + "T00:00:00Z");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const toNum = (v) => {
  const n = Number(String(v ?? "").trim().replace(/\s/g, ""));
  return Number.isFinite(n) ? n : null;
};
const isTrue = (v) => ["true", "waar", "1", "ja"].includes(String(v ?? "").trim().toLowerCase());

// Epoch ms of an Amsterdam wall-clock time ("2026-10-26", "20:00"), summer or winter time.
function amsMs(day, hhmm) {
  for (const off of [2, 1, 0]) {
    const t = Date.parse(`${day}T${hhmm}:00Z`) - off * 3600e3;
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
    if (parts === hhmm && new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(t) === day) return t;
  }
  return Date.parse(`${day}T${hhmm}:00Z`);
}

// Finale, started by hand on the private site. The public sheet's `finale` tab holds the current
// one (started_at, deadline, status, ended_at); the private site passes it in directly.
// { start, end } in ms; end = deadline, or the stop time when it was stopped early. null = none.
let FINALE = null;
function finaleFromRows(rows) {
  const r = rows && rows.filter((x) => x.started_at).at(-1);
  if (!r) return null;
  const start = Date.parse(r.started_at), deadline = Date.parse(r.deadline);
  const status = String(r.status || "").trim();
  if (!Number.isFinite(start) || !Number.isFinite(deadline) || !["active", "stopped"].includes(status)) return null;
  const stopped = status === "stopped" && Number.isFinite(Date.parse(r.ended_at)) ? Date.parse(r.ended_at) : Infinity;
  return { start, end: Math.min(deadline, stopped) };
}
// "none" | "before" | "live" | "after" (Eindstand)
function finalePhase(t = now()) {
  if (!FINALE) return "none";
  return t >= FINALE.end ? "after" : t >= FINALE.start ? "live" : "before";
}
function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

function weekOf(dayKey) {
  const idx = Math.floor((dayMs(dayKey) - dayMs(CFG.campaignStart)) / 864e5 / 7);
  return Math.max(0, idx) + 1;
}
function weekLabel(n) {
  const start = dayMs(CFG.campaignStart) + (n - 1) * 7 * 864e5;
  return `Week ${n} (${shortDayFmt.format(start)})`;
}

// ---------- data loading ----------

async function fetchCsv(tab, signal) {
  const base = (CFG.csvUrls && CFG.csvUrls[tab]) || CFG.csvUrl(tab);
  const url = base + (base.includes("?") ? "&" : "?") + "t=" + Date.now();
  const res = await fetch(url, { cache: "no-store", signal });
  if (!res.ok) {
    // Read the error page anyway: an unread body keeps the connection open (a tab that doesn't
    // exist yet, like outliers before its first run, answers 400).
    await res.text().catch(() => {});
    throw new Error(`Tabblad '${tab}' niet te laden (HTTP ${res.status}). Is de sheet gepubliceerd?`);
  }
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error(`Tabblad '${tab}' gaf geen CSV terug. Is de sheet gepubliceerd?`);
  return Papa.parse(text, { header: true, skipEmptyLines: true }).data;
}

// "Buiten schaal" (public tab outliers, handles only): accounts left out of the chart scales.
// Fetched next to the main data but never holding it up: a missing (nobody marked yet) or slow
// tab just means no outliers until it arrives; then the charts are redrawn.
// One set per platform: tab outliers (TikTok) and ig_outliers (Instagram); a handle is only "buiten schaal" on the
// platform where it was switched on (the same handle can exist on both).
let OUTLIERS = { tiktok: new Set(), instagram: new Set() };
const OUTLIER_TABS = { tiktok: "outliers", instagram: "ig_outliers" };
function refreshOutliers() {
  for (const [platform, tab] of Object.entries(OUTLIER_TABS)) {
    if (!(CFG.csvUrls && CFG.csvUrls[tab]) && !(CFG.gids && CFG.gids[tab] != null)) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    fetchCsv(tab, ctrl.signal).then((rows) => {
      const next = outliersFromRows(rows);
      if ([...next].join() === [...OUTLIERS[platform]].join()) return;
      OUTLIERS[platform] = next;
      const d = state.all[platform];
      if (!d) return;
      d.outliers = outlierKeys(d, next);
      if (IS_PRESENT) Present.update(state.all); else render();
    }).catch(() => {}).finally(() => clearTimeout(timer));
  }
}
function outliersFromRows(rows) {
  return new Set((rows || []).filter((r) => isTrue(r.buiten_schaal))
    .map((r) => String(r.handle || "").trim().toLowerCase().replace(/^@/, "")).filter(Boolean));
}

// The small public finale tab; missing (not linked yet, or never started) means no finale.
async function fetchFinale() {
  if (!(CFG.csvUrls && CFG.csvUrls.finale) && !(CFG.gids && CFG.gids.finale != null)) return [];
  try {
    return await fetchCsv("finale");
  } catch {
    return [];
  }
}

function build(handleRows, historyRows, postRows, labels = {}, outliers = new Set()) {
  // After the deadline everything is frozen at the last run before it (Eindstand).
  const final = finalePhase() === "after";
  const cutoff = final ? FINALE.end : Infinity;
  const accountList = handleRows
    .filter((r) => r.handle)
    .map((r) => {
      const handle = String(r.handle).trim();
      const group = String(r.group || "").trim().toLowerCase().replace(/^@/, "") || handle;
      return { handle, group, label: labels[handle] || null, isPrivate: isTrue(r.is_private), status: r.last_status || "" };
    });
  const known = new Set(accountList.map((a) => a.handle));
  const series = new Map(accountList.map((a) => [a.handle, []]));
  let latest = 0;
  for (const r of historyRows) {
    const s = series.get(String(r.handle).trim());
    const t = Date.parse(r.timestamp);
    if (!s || !Number.isFinite(t) || t > cutoff) continue;
    s.push({
      t,
      total_views: toNum(r.total_views) ?? 0,
      followers: toNum(r.followers),
      campaign_posts: toNum(r.campaign_posts) ?? 0,
      campaign_likes: toNum(r.campaign_likes) ?? 0,
    });
    latest = Math.max(latest, t);
  }
  for (const s of series.values()) s.sort((a, b) => a.t - b.t);

  const posts = new Map(accountList.map((a) => [a.handle, []]));
  for (const r of postRows) {
    const h = String(r.handle).trim();
    if (!known.has(h)) continue;
    posts.get(h).push({
      id: String(r.video_id), created: Date.parse(r.created_at), views: toNum(r.views), likes: toNum(r.likes),
      comments: toNum(r.comments), shares: toNum(r.shares), type: r.post_type || "", pinned: isTrue(r.pinned),
      tags: String(r.hashtags || "").toLowerCase().split(/\s+/).filter(Boolean),
    });
  }
  // One entry per student: a student with two accounts (column group in the public handles tab,
  // the handle of their first account) is one row, with the accounts added up. Keyed by that handle.
  const groups = new Map();
  for (const a of accountList) {
    const key = known.has(a.group) ? a.group : a.handle;
    if (!groups.has(key)) groups.set(key, []);
    if (a.handle === key) groups.get(key).unshift(a); else groups.get(key).push(a);
  }
  const accounts = [...groups].map(([key, list]) => ({
    handle: key, handles: list.map((a) => a.handle), multi: list.length > 1,
    label: list.map((a) => a.label).find(Boolean) || null,
    isPrivate: list.some((a) => a.isPrivate), status: list[0].status,
  }));
  const people = new Map(accounts.map((p) => [p.handle, p]));
  const keyOf = new Map(accounts.flatMap((p) => p.handles.map((h) => [h, p.handle])));
  const merged = new Map(accounts.map((p) => [p.handle, p.multi ? mergeSeries(p.handles.map((h) => series.get(h))) : series.get(p.handle)]));
  const data = { platform: "tiktok", accounts, accountList, people, keyOf, series: merged, accountSeries: series, posts, latest, labels, final,
    standings: standings(accounts, merged, latest), tags: hashtagStats(posts) };
  data.outliers = outlierKeys(data, outliers);
  data.accountRows = new Map(accountList.map((a) => [a.handle, standings([a], series, latest)[0]]));
  return data;
}

// An empty cell is "unknown", not 0 (toNum turns "" into 0).
const numOrNull = (v) => (String(v ?? "").trim() === "" ? null : toNum(v));

// The Instagram dataset, shaped like the TikTok one (accounts, series, posts, standings, outliers) so the charts and
// account helpers work on either. Instagram accounts are not grouped (one per student, and the public data has no
// link between a student's two platforms). Series points: followers, following, posts_count, campaign_posts and
// `gain` = followers minus the account's baseline (ig_baseline: its first successful measurement, add-only, so it never shifts).
function buildInstagram(src, labels = {}, outliers = new Set()) {
  const final = finalePhase() === "after";
  const cutoff = final ? FINALE.end : Infinity;
  const accountList = (src.igHandles || []).filter((r) => r.handle).map((r) => {
    const handle = String(r.handle).trim();
    return { handle, group: handle, label: labels[handle] || null, isPrivate: isTrue(r.is_private), status: r.last_status || "",
      followersNow: numOrNull(r.followers) };
  });
  const known = new Set(accountList.map((a) => a.handle));
  const baselines = new Map();
  for (const r of src.igBaseline || []) {
    const h = String(r.handle || "").trim(), t = Date.parse(r.baseline_at), followers = numOrNull(r.baseline_followers);
    if (known.has(h) && Number.isFinite(t) && t <= cutoff && followers != null && !baselines.has(h)) baselines.set(h, { t, followers });
  }
  const firstBaseline = baselines.size ? Math.min(...[...baselines.values()].map((b) => b.t)) : null;
  const series = new Map(accountList.map((a) => [a.handle, []]));
  let latest = 0;
  for (const r of src.igHistory || []) {
    const h = String(r.handle || "").trim(), s = series.get(h), t = Date.parse(r.timestamp);
    if (!s || !Number.isFinite(t) || t > cutoff) continue;
    const followers = numOrNull(r.followers), b = baselines.get(h);
    s.push({ t, followers, following: numOrNull(r.following), posts_count: numOrNull(r.posts_count),
      campaign_posts: numOrNull(r.campaign_posts) ?? 0, gain: followers != null && b ? followers - b.followers : null });
    latest = Math.max(latest, t);
  }
  for (const s of series.values()) s.sort((a, b) => a.t - b.t);
  const posts = new Map(accountList.map((a) => [a.handle, []]));
  for (const r of src.igPosts || []) {
    const h = String(r.handle || "").trim();
    if (!known.has(h) || !String(r.post_id ?? "").trim()) continue;
    posts.get(h).push({ id: String(r.post_id), created: Date.parse(r.created_at), type: r.post_type || "", url: String(r.url || "").trim(),
      tags: String(r.hashtags || "").toLowerCase().split(/\s+/).filter(Boolean) });
  }
  const accounts = accountList.map((a) => ({ handle: a.handle, handles: [a.handle], multi: false, label: a.label, isPrivate: a.isPrivate, status: a.status }));
  const people = new Map(accounts.map((p) => [p.handle, p]));
  const keyOf = new Map(accounts.map((p) => [p.handle, p.handle]));
  const data = { platform: "instagram", accounts, accountList, people, keyOf, series, accountSeries: series, posts, latest, labels, final,
    baselines, firstBaseline, tags: hashtagStats(posts) };
  data.standings = standingsInstagram(accounts, series, latest, baselines, firstBaseline);
  data.outliers = outlierKeys(data, outliers);
  data.accountRows = new Map(data.standings.map((r) => [r.handle, r]));
  return data;
}

// Instagram: ranked on followers gained since the account's baseline, with the total followers next to it. Equal gains
// share a place (listed by followers). An account without a baseline yet (private, not found, not measured) has no
// place and comes last. `gain` is the change in followers over the last ~24 hours (arrows, risers); `late` marks an
// account whose baseline is from a later run than the first accounts' (added later: its gain counts from then).
function standingsInstagram(accounts, series, latest, baselines, firstBaseline) {
  const rows = accounts.map((a) => {
    const measured = series.get(a.handle).filter((p) => p.followers != null);
    const cur = measured.at(-1) || null;
    const base = latest && cur ? baseline(measured, latest) : null;
    const b = baselines.get(a.handle) || null;
    return { ...a, cur, base, baseline: b, baselineAt: b ? b.t : null,
      followers: cur ? cur.followers : a.followersNow ?? null, posts: cur ? cur.campaign_posts : null,
      gained: cur && b ? cur.followers - b.followers : null,
      gain: cur && base ? cur.followers - base.followers : null,
      late: Boolean(b && firstBaseline != null && b.t - firstBaseline > LATE_BASELINE_MS) };
  });
  const ranked = rows.filter((r) => r.gained != null);
  const now = rankBy(ranked, (r) => r.gained, (a, b) => (b.followers ?? 0) - (a.followers ?? 0));
  const before = rankBy(ranked.filter((r) => r.base && r.baseline), (r) => r.base.followers - r.baseline.followers);
  for (const r of rows) {
    r.rank = now.get(r.handle) ?? null;
    r.rankChange = r.rank != null && before.has(r.handle) ? before.get(r.handle) - r.rank : null;
  }
  return rows.sort((a, b) => (a.rank == null) - (b.rank == null) || a.rank - b.rank
    || (b.followers ?? 0) - (a.followers ?? 0) || a.handle.localeCompare(b.handle));
}

// "Buiten schaal" is set per account; a student is out of the scale when one of their accounts is.
function outlierKeys(data, accountSet) {
  return new Set([...accountSet].map((h) => data.keyOf.get(h)).filter(Boolean));
}

// Several accounts' series as one: at every run time, the sum of each account's latest value up to
// then (a partial "Controleer nu" run only writes rows for some accounts). Same as mergeSeries in
// private/public/lib.js, with the public field names.
function mergeSeries(list) {
  const all = list.filter((s) => s && s.length);
  if (all.length <= 1) return all[0] ? [...all[0]] : [];
  const times = [...new Set(all.flatMap((s) => s.map((p) => p.t)))].sort((a, b) => a - b);
  const idx = all.map(() => -1);
  return times.map((t) => {
    const out = { t, total_views: 0, followers: null, campaign_posts: 0, campaign_likes: 0 };
    all.forEach((s, i) => {
      while (idx[i] + 1 < s.length && s[idx[i] + 1].t <= t) idx[i]++;
      const p = s[idx[i]];
      if (!p) return;
      out.total_views += p.total_views || 0;
      out.campaign_posts += p.campaign_posts || 0;
      out.campaign_likes += p.campaign_likes || 0;
      if (p.followers != null) out.followers = (out.followers || 0) + p.followers;
    });
    return out;
  });
}

// "@a + @b" for a student with two accounts, "@a" otherwise.
function who2(key) {
  const p = state.data && state.data.people.get(key);
  return (p ? p.handles : [key]).map((h) => "@" + h).join(" + ");
}

// Per hashtag: campaign posts using it, accounts, and total views/likes of those posts.
function hashtagStats(posts) {
  const tags = new Map();
  for (const [handle, list] of posts) {
    for (const p of list) {
      for (const tag of new Set(p.tags)) {
        let t = tags.get(tag);
        if (!t) tags.set(tag, (t = { tag, posts: 0, views: 0, likes: 0, accounts: new Map() }));
        t.posts++;
        t.views += p.views || 0;
        t.likes += p.likes || 0;
        t.accounts.set(handle, (t.accounts.get(handle) || 0) + 1);
      }
    }
  }
  return [...tags.values()];
}

// The last point of a series at least ~24 hours before `latest` (the rolling "+ 24 uur" baseline).
function baseline(s, latest) {
  const target = latest - DAY_MS + BASE_SLACK_MS;
  for (let i = s.length - 1; i >= 0; i--) if (s[i].t <= target) return s[i];
  return null;
}

// Rank by a number, high to low; equal numbers share a place. Returns Map(handle -> place).
function rankBy(list, value, tieBreak = () => 0) {
  const sorted = [...list].sort((a, b) => value(b) - value(a) || tieBreak(a, b) || a.handle.localeCompare(b.handle));
  const ranks = new Map();
  sorted.forEach((r, i) => ranks.set(r.handle, i > 0 && value(sorted[i - 1]) === value(r) ? ranks.get(sorted[i - 1].handle) : i + 1));
  return ranks;
}

// Rank by total views; "+ 24 uur" and the rank change compare with the run of ~24 hours earlier
// (rolling, so it doesn't reset at midnight; TikTok runs every 12 hours).
function standings(accounts, series, latest) {
  const rows = accounts.map((a) => {
    const s = series.get(a.handle);
    const cur = s.at(-1) || null;
    const base = latest ? baseline(s, latest) : null;
    return { ...a, cur, base, views: cur ? cur.total_views : 0 };
  });
  const now = rankBy(rows, (r) => r.views);
  const before = rankBy(rows.filter((r) => r.base), (r) => r.base.total_views);
  for (const r of rows) {
    r.rank = now.get(r.handle);
    r.rankChange = before.has(r.handle) ? before.get(r.handle) - r.rank : null;
    r.gain = r.base ? r.views - r.base.total_views : null;
  }
  return rows.sort((a, b) => a.rank - b.rank || a.handle.localeCompare(b.handle));
}

// A tab that may be missing or not published (yet): no rows and ok=false, so the other platform still loads.
async function fetchOptional(tab) {
  if (!(CFG.csvUrls && CFG.csvUrls[tab]) && !(CFG.gids && CFG.gids[tab] != null)) return { rows: [], ok: false };
  try {
    return { rows: await fetchCsv(tab), ok: true };
  } catch {
    return { rows: [], ok: false };
  }
}

// The four public Instagram tabs. ok = all of them could be read (an empty tab is fine: no run yet).
async function fetchInstagram() {
  const got = await Promise.all(["ig_handles", "ig_history", "ig_posts", "ig_baseline"].map(fetchOptional));
  const [igHandles, igHistory, igPosts, igBaseline] = got.map((g) => g.rows);
  return { igHandles, igHistory, igPosts, igBaseline, igOk: got.every((g) => g.ok) };
}

// Makes `platform` the one the shared helpers (who2, points, gains, the chips) work on. The picked accounts
// (Grafiek/Groei) are kept per platform, so switching platform brings back that platform's own picks.
function useData(platform) {
  if (state.dataPlatform !== platform) {
    if (state.dataPlatform) state.picks[state.dataPlatform] = { selected: state.selected, slotOf: state.slotOf };
    const next = state.picks[platform] || { selected: [], slotOf: new Map() };
    state.selected = next.selected;
    state.slotOf = next.slotOf;
    state.dataPlatform = platform;
  }
  state.data = state.all[platform];
  return state.data;
}
// Runs fn with the helpers pointing at `platform`'s data, then puts them back (for the Stand, which shows both).
function on(platform, fn) {
  const prev = state.data;
  state.data = state.all[platform];
  try {
    return fn();
  } finally {
    state.data = prev;
  }
}

async function load() {
  try {
    // The private dashboard supplies its own source (with names as labels); the public site reads the CSVs.
    const src = CFG.source
      ? await CFG.source()
      : await (refreshOutliers(), Promise.all([fetchCsv("handles"), fetchCsv("history"), fetchCsv("posts"), fetchFinale(), fetchInstagram()]))
        .then(([handles, history, posts, finaleRows, ig]) => ({ handles, history, posts, finaleRows, ...ig }));
    FINALE = "finale" in src ? (src.finale ? { start: src.finale.start, end: src.finale.end } : null)
      : finaleFromRows(src.finaleRows);
    if (src.outliers) OUTLIERS.tiktok = new Set(src.outliers);
    if (src.igOutliers) OUTLIERS.instagram = new Set(src.igOutliers);
    state.all.tiktok = build(src.handles, src.history, src.posts, src.labels, OUTLIERS.tiktok);
    state.all.instagram = buildInstagram(src, src.igLabels || {}, OUTLIERS.instagram);
    state.all.instagram.ok = src.igOk !== false;
    state.data = state.all[state.dataPlatform || state.platform];
    if (IS_PRESENT) {
      Present.update(state.all);
      return;
    }
    document.getElementById("error").hidden = true;
    for (const p of Object.keys(PLATFORMS)) {
      useData(p);
      if (!state.selected.length) state.data.standings.filter((r) => p === "tiktok" || r.rank != null).slice(0, 5).forEach((r) => select(r.handle));
    }
    useData(state.platform);
    const latest = Math.max(state.all.tiktok.latest, state.all.instagram.latest);
    const upd = latest ? `Bijgewerkt: ${stampFmt.format(latest)}` : "Nog geen gegevens";
    const n = (d) => d.accountList.length;
    document.getElementById("updated").textContent = `${upd} · ${n(state.all.instagram)} Instagram- en ${n(state.all.tiktok)} TikTok-accounts`;
    render();
  } catch (err) {
    if (IS_PRESENT) {
      Present.error(err.message);
      return;
    }
    const box = document.getElementById("error");
    box.textContent = `Kon de gegevens niet laden: ${err.message}`;
    box.hidden = false;
  }
}

// ---------- per-video history (post_history, loaded only when needed) ----------

const hasPostHistory = () => Boolean(CFG.postHistorySource || (CFG.csvUrls && CFG.csvUrls.post_history)
  || (CFG.gids && CFG.gids.post_history != null));

// post_history can grow to a few MB, so it is fetched only for the Video's tab and account pages,
// and at most once per refresh interval.
function loadPostHistory() {
  const maxAge = (CFG.refreshMinutes || 10) * 60 * 1000;
  if (state.postHistory && Date.now() - state.postHistory.fetched < maxAge) return Promise.resolve(state.postHistory);
  if (state.postHistoryLoading) return state.postHistoryLoading;
  state.postHistoryLoading = (async () => {
    const t0 = performance.now();
    const rows = CFG.postHistorySource ? await CFG.postHistorySource() : await fetchCsv("post_history");
    const cutoff = state.all.tiktok && state.all.tiktok.final ? FINALE.end : Infinity;
    const byVideo = new Map();
    for (const r of rows) {
      const t = Date.parse(r.timestamp);
      if (!Number.isFinite(t) || t > cutoff) continue;
      const id = String(r.video_id);
      if (!byVideo.has(id)) byVideo.set(id, []);
      byVideo.get(id).push({ t, views: toNum(r.views) ?? 0 });
    }
    for (const list of byVideo.values()) list.sort((a, b) => a.t - b.t);
    state.postHistory = { fetched: Date.now(), byVideo, rows: rows.length, ms: Math.round(performance.now() - t0) };
    return state.postHistory;
  })().finally(() => { state.postHistoryLoading = null; });
  return state.postHistoryLoading;
}

// Views a video gained in the `hours` before `ref` (the last run). A video posted inside that
// period counts from 0; otherwise from its last post_history row at or before the start.
function videoGain(post, hist, hours, ref) {
  const from = ref - hours * 3600e3;
  const pts = (hist || []).filter((p) => p.t <= ref);
  const current = Math.max(post.views || 0, pts.length ? pts.at(-1).views : 0);
  if (Number.isFinite(post.created) && post.created >= from) return current;
  let base = null;
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i].t <= from + 15 * 60 * 1000) { base = pts[i]; break; }
  if (!base) base = pts[0];
  return base ? Math.max(0, current - base.views) : 0;
}

// Every campaign video with its gain over the last `hours`, fastest first.
function fastestVideos(hours) {
  const ph = state.postHistory;
  const ref = state.data.latest || now();
  const list = [];
  for (const [handle, posts] of state.data.posts) {
    for (const p of posts) list.push({ handle, post: p, gain: videoGain(p, ph.byVideo.get(p.id), hours, ref) });
  }
  return list.sort((a, b) => b.gain - a.gain || (b.post.views || 0) - (a.post.views || 0));
}

function renderVideos() {
  renderSeg("videoRange", VIDEO_RANGES);
  const body = document.getElementById("videos-body");
  const meta = document.getElementById("videos-meta");
  if (!hasPostHistory()) {
    body.innerHTML = `<tr><td colspan="6">De geschiedenis per video is nog niet gekoppeld aan de site.</td></tr>`;
    meta.textContent = "";
    return;
  }
  if (!state.postHistory) {
    body.innerHTML = `<tr><td colspan="6">Geschiedenis per video laden…</td></tr>`;
    loadPostHistory().then(() => state.view === "videos" && on("tiktok", renderVideos)).catch((err) => {
      body.innerHTML = `<tr><td colspan="6">Kon de geschiedenis per video niet laden: ${esc(err.message)}</td></tr>`;
    });
    return;
  }
  const hours = Number(state.videoRange);
  const rows = fastestVideos(hours).filter((x) => x.gain > 0).slice(0, VIDEOS_SHOWN);
  // Bars scale without "buiten schaal" accounts (theirs is capped at full width).
  const scaled = rows.filter((x) => !state.data.outliers.has(state.data.keyOf.get(x.handle)));
  const max = Math.max(1, ...(scaled.length ? scaled : rows).map((x) => x.gain));
  meta.textContent = `Weergaven erbij in de laatste ${VIDEO_RANGES[hours]} tot ${state.data.latest ? stampFmt.format(state.data.latest) : "nu"}`;
  body.innerHTML = rows.map((x, i) => `
    <tr tabindex="0" data-handle="${esc(x.handle)}" data-platform="tiktok">
      <td class="rank num">${i + 1}</td>
      <td class="handle">@${esc(x.handle)}${x.post.type && x.post.type !== "video" ? ` <span class="badge pinned">${esc(x.post.type)}</span>` : ""}</td>
      <td class="num views bar-cell"><span class="cell-bar${x.gain > max ? " out" : ""}" style="--w:${Math.min(1, x.gain / max) * 100}%"></span>${x.gain > max ? `<span class="out-mark" title="Buiten schaal">▲</span> ` : ""}${signed(x.gain)}</td>
      <td class="num opt">${fmt(x.post.views)}</td>
      <td class="opt2">${Number.isFinite(x.post.created) ? postDateFmt.format(x.post.created) : "–"}</td>
      <td><a href="https://www.tiktok.com/@${encodeURIComponent(x.handle)}/video/${esc(x.post.id)}" target="_blank" rel="noopener">open ↗</a></td>
    </tr>`).join("") || `<tr><td colspan="6">Geen video's met nieuwe weergaven in deze periode.</td></tr>`;
}

// Account page: views over time per video, the fastest riser (24 h) highlighted.
// posts: [{ ...post, handle }] of the account(s) shown.
function renderVideoChart(handle, posts) {
  const box = document.getElementById("acc-videos");
  if (!box) return;
  if (!hasPostHistory()) { box.hidden = true; return; }
  if (!state.postHistory) {
    loadPostHistory().then(() => state.view === "account" && state.accountPlatform === "tiktok" && state.account === handle
      && on("tiktok", () => renderVideoChart(handle, posts)))
      .catch(() => { box.hidden = true; });
    return;
  }
  const ref = state.data.latest || now();
  const series = posts.map((p) => ({ p, pts: (state.postHistory.byVideo.get(p.id) || []).filter((x) => x.t <= ref) }))
    .filter((x) => x.pts.length);
  if (!series.length) { box.hidden = true; return; }
  const ranked = posts.map((p) => ({ p, gain: videoGain(p, state.postHistory.byVideo.get(p.id), 24, ref) }))
    .sort((a, b) => b.gain - a.gain);
  const top = ranked[0] && ranked[0].gain > 0 ? ranked[0] : null;
  box.hidden = false;
  document.getElementById("acc-videos-note").innerHTML = top
    ? `🚀 Snelste stijger (24 uur): video van ${postDateFmt.format(top.p.created)}, <strong>${signed(top.gain)}</strong> weergaven. <a href="https://www.tiktok.com/@${encodeURIComponent(top.p.handle)}/video/${esc(top.p.id)}" target="_blank" rel="noopener">open ↗</a>`
    : "Geen nieuwe weergaven in de laatste 24 uur.";
  const other = cssVar("--other"), hot = cssVar("--s2");
  const isTop = (p) => Boolean(top && p.id === top.p.id);
  const datasets = series
    .sort((a, b) => isTop(a.p) - isTop(b.p)) // highlighted one drawn last, on top
    .map(({ p, pts }) => {
      const ds = lineDataset(`Video ${Number.isFinite(p.created) ? postDateFmt.format(p.created) : p.id}`,
        pts.map((x) => ({ x: x.t, y: x.views })), isTop(p) ? hot : other, false);
      ds.borderWidth = isTop(p) ? 3.5 : 1.5;
      return ds;
    });
  drawChart("chart-acc-videos", { type: "line", data: { datasets }, options: timeAxis(baseOptions("Weergaven")) });
}

// ---------- selection with stable colours ----------

function select(handle) {
  if (state.selected.includes(handle)) return true;
  if (state.selected.length >= MAX_SELECTED) return false;
  const used = new Set(state.slotOf.values());
  let slot = 1;
  while (used.has(slot)) slot++;
  state.slotOf.set(handle, slot);
  state.selected.push(handle);
  return true;
}
function deselect(handle) {
  state.selected = state.selected.filter((h) => h !== handle);
  state.slotOf.delete(handle);
}
const colorOf = (handle) => cssVar(`--s${state.slotOf.get(handle)}`);

// Legend above the chart: the selected accounts with their colour (click to remove).
function renderLegend(containerId) {
  const box = document.getElementById(containerId);
  const out = state.data.outliers;
  box.innerHTML = state.selected.map((h) =>
    `<button type="button" class="chip" aria-pressed="true" data-handle="${esc(h)}" title="Klik om te verbergen">` +
    `<span class="dot" style="background:${out.has(h) ? cssVar("--muted") : colorOf(h)}"></span>${esc(who2(h))}` +
    `${out.has(h) ? ` <span class="out-mark" title="Buiten de schaal van de grafiek: staat als ▲ bovenaan met het echte getal">▲ buiten schaal</span>` : ""}</button>`).join("")
    || `<span class="limit">Kies hieronder accounts om te vergelijken.</span>`;
  for (const b of box.querySelectorAll("button")) {
    b.addEventListener("click", () => { deselect(b.dataset.handle); render(); });
  }
}

function renderChips(containerId) {
  renderLegend(containerId.replace("chips", "legend"));
  const box = document.getElementById(containerId);
  box.innerHTML = "";
  for (const r of state.data.standings) {
    const on = state.selected.includes(r.handle);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.setAttribute("aria-pressed", String(on));
    const dot = state.data.outliers.has(r.handle) ? cssVar("--muted") : colorOf(r.handle);
    b.innerHTML = `<span class="dot"${on ? ` style="background:${dot}"` : ""}></span>${esc(who2(r.handle))}`;
    b.addEventListener("click", () => {
      if (on) deselect(r.handle);
      else if (!select(r.handle)) {
        box.querySelector(".limit").textContent = `Maximaal ${MAX_SELECTED} accounts tegelijk: zet er eerst één uit.`;
        return;
      }
      render();
    });
    box.appendChild(b);
  }
  const limit = document.createElement("span");
  limit.className = "limit";
  limit.textContent = `${state.selected.length}/${MAX_SELECTED} gekozen`;
  box.appendChild(limit);
}

function renderSeg(bindKey, options) {
  for (const el of document.querySelectorAll(`.seg[data-bind="${bindKey}"]`)) {
    el.innerHTML = "";
    for (const [value, label] of Object.entries(options)) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = typeof label === "string" ? label : label.label;
      b.setAttribute("aria-pressed", String(state[bindKey] === value));
      b.addEventListener("click", () => { state[bindKey] = value; render(); });
      el.appendChild(b);
    }
  }
}

// ---------- charts ----------

function baseOptions(yTitle) {
  const grid = cssVar("--grid"), text = cssVar("--text-2");
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "nearest", axis: "x", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar("--surface"), titleColor: cssVar("--text"), bodyColor: cssVar("--text"),
        borderColor: cssVar("--border"), borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
        callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` },
      },
    },
    scales: {
      x: { grid: { color: grid }, border: { color: grid }, ticks: { color: text, maxRotation: 0, autoSkipPadding: 16 } },
      y: {
        beginAtZero: true, grid: { color: grid }, border: { display: false },
        ticks: { color: text, precision: 0, callback: (v) => compact.format(v) },
        title: { display: !!yTitle, text: yTitle, color: text },
      },
    },
  };
}

const hourFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

// Linear time axis with ticks on Amsterdam midnights (day labels); over short spans (up to 4 days)
// also every 6 hours, so the 2-hourly detail can be read. min/max limit the visible range.
function timeAxis(opts, min = null, max = null) {
  const x = opts.scales.x;
  x.type = "linear";
  if (min != null) x.min = min;
  if (max != null) x.max = max;
  x.afterBuildTicks = (axis) => {
    const lo = axis.min, hi = axis.max;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
    const short = hi - lo <= 4 * DAY_MS;
    const ticks = [];
    for (let d = localDay(lo); d <= localDay(hi); d = new Date(dayMs(d) + DAY_MS).toISOString().slice(0, 10)) {
      for (const h of short ? ["00:00", "06:00", "12:00", "18:00"] : ["00:00"]) {
        const t = amsMs(d, h);
        if (t >= lo && t <= hi) ticks.push({ value: t });
      }
    }
    axis.ticks = ticks;
  };
  x.ticks.callback = (v) => (hourFmt.format(v) === "00:00" ? shortDayFmt.format(dayMs(localDay(v))) : hourFmt.format(v));
  x.ticks.autoSkip = true;
  opts.plugins.tooltip.callbacks.title = (items) => (items.length ? stampFmt.format(items[0].parsed.x) : "");
  return opts;
}

// Direct labels at the end of each line when few series are shown.
const endLabels = {
  id: "endLabels",
  afterDatasetsDraw(chart) {
    const shown = chart.data.datasets.filter((d) => d.endLabel);
    if (!shown.length || shown.length > 4) return;
    const { ctx } = chart;
    ctx.save();
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = cssVar("--text");
    ctx.textAlign = "right";
    chart.data.datasets.forEach((d, i) => {
      if (!d.endLabel) return;
      const pts = chart.getDatasetMeta(i).data;
      const last = pts[pts.length - 1];
      if (last) ctx.fillText(d.label, last.x - 4, last.y - 8);
    });
    ctx.restore();
  },
};

// "Buiten schaal": a marked account must not stretch the y-axis of a chart with other accounts.
// Its values above the highest value of the others are left out of its line (so the axis scales on
// the rest) and shown as a grey ▲ at the top edge with its handle and real number. Rank, tables and
// the podium are not affected. Datasets carry their handle in `handle`.
function applyOutliers(datasets) {
  const out = state.data.outliers;
  if (!out || !out.size) return datasets;
  const val = (p) => (p && typeof p === "object" ? p.y : p);
  const isOut = (ds) => ds.handle && out.has(ds.handle);
  const cap = Math.max(0, ...datasets.filter((d) => !isOut(d)).flatMap((d) => d.data.map(val).filter((v) => v != null)));
  if (!cap) return datasets; // nothing else on this chart to scale on
  let n = 0;
  for (const ds of datasets.filter(isOut)) {
    let last = null;
    ds.data.forEach((p, i) => { if (val(p) != null) last = { x: p && typeof p === "object" ? p.x : i, v: val(p) }; });
    if (!last || !ds.data.some((p) => val(p) > cap)) continue;
    ds.data = ds.data.map((p) => (val(p) > cap ? (p && typeof p === "object" ? { x: p.x, y: null } : null) : p));
    Object.assign(ds, { outlierMark: { x: last.x, value: last.v, slot: n++ }, endLabel: false, borderDash: [6, 4],
      borderColor: cssVar("--muted"), backgroundColor: cssVar("--muted"), spanGaps: false });
  }
  return datasets;
}

// Room above the plot for the ▲ markers, so they never sit on top of the lines or end labels.
const markSize = () => Math.max(11, Math.round((Chart.defaults.font.size || 12) * 0.95));
function outlierPadding(opts, datasets) {
  const n = datasets.filter((d) => d.outlierMark).length;
  if (n) opts.layout = { ...(opts.layout || {}), padding: { ...((opts.layout || {}).padding || {}), top: n * (markSize() + 8) + 4 } };
  return opts;
}

// Draws the ▲ markers of applyOutliers at the top edge of the chart.
const outlierMarks = {
  id: "outlierMarks",
  afterDatasetsDraw(chart) {
    const marks = chart.data.datasets.filter((d) => d.outlierMark);
    if (!marks.length) return;
    const { ctx, chartArea: a, scales } = chart;
    const size = markSize();
    ctx.save();
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.fillStyle = cssVar("--muted");
    ctx.textBaseline = "middle";
    for (const d of marks) {
      const m = d.outlierMark;
      let x = scales.x.getPixelForValue(m.x);
      if (!Number.isFinite(x)) x = a.right;
      x = Math.min(a.right - 6, Math.max(a.left + 6, x));
      const y = a.top - (marks.length - m.slot) * (size + 8) + size / 2;
      ctx.beginPath();
      ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y + 5); ctx.lineTo(x - 6, y + 5); ctx.closePath();
      ctx.fill();
      const text = `${d.label} ${fmt(m.value)} (buiten schaal)`;
      const w = ctx.measureText(text).width;
      ctx.textAlign = x - 10 - w > a.left ? "right" : "left";
      ctx.fillText(text, ctx.textAlign === "right" ? x - 10 : x + 10, y);
    }
    ctx.restore();
  },
};

function drawChart(id, config) {
  if (state.charts[id]) state.charts[id].destroy();
  const canvas = document.getElementById(id);
  if (!canvas) return;
  state.charts[id] = new Chart(canvas, config);
}

function lineDataset(label, points, color, endLabel) {
  return {
    label, data: points, borderColor: color, backgroundColor: color, borderWidth: 2,
    pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 10, tension: 0.15, endLabel,
    pointHoverBorderColor: cssVar("--surface"), pointHoverBorderWidth: 2,
  };
}

function renderMainChart() {
  const m = PLATFORMS[state.platform].metrics[state.metric];
  const span = RANGE_MS[state.range];
  const min = span && state.data.latest ? state.data.latest - span : null;
  const datasets = [];
  if (state.showOthers) {
    for (const r of state.data.standings) {
      if (state.selected.includes(r.handle)) continue;
      const ds = lineDataset(who2(r.handle), points(r.handle, m.key, min), cssVar("--other"), false);
      ds.borderWidth = 1;
      ds.pointHoverRadius = 0;
      ds.handle = r.handle;
      datasets.push(ds);
    }
  }
  for (const h of state.selected) datasets.push({ ...lineDataset(who2(h), points(h, m.key, min), colorOf(h), true), handle: h });
  applyOutliers(datasets);
  const opts = outlierPadding(timeAxis(baseOptions(m.label), min, state.data.latest || null), datasets);
  if (min != null) opts.scales.y.beginAtZero = false; // zoomed in: show the change, not the zero line
  drawChart("chart-main", { type: "line", data: { datasets }, options: opts, plugins: [endLabels, outlierMarks] });
}

// Points of one account; with `from`, only those in range (plus one before it, so the line starts at the edge).
function points(handle, key, from = null, src = state.data.series) {
  const list = src.get(handle).filter((p) => p[key] != null);
  const i = from == null ? 0 : list.findIndex((p) => p.t >= from);
  const start = i === -1 ? list.length - 1 : Math.max(0, i - 1);
  return list.slice(Math.max(0, start)).map((p) => ({ x: p.t, y: p[key] }));
}

// Gain per period: closing value of each period minus the previous close.
// Campaign counters (views, posts, likes) start at 0; followers skip their first period.
function gains(handle, key, period, src = state.data.series) {
  const closes = new Map();
  for (const p of src.get(handle)) {
    if (p[key] == null) continue;
    const day = localDay(p.t);
    closes.set(period === "day" ? day : weekOf(day), p[key]);
  }
  const out = new Map();
  let prev = key === "followers" ? null : 0;
  for (const [k, v] of closes) {
    if (prev != null) out.set(k, v - prev);
    prev = v;
  }
  return out;
}

function renderGrowth() {
  const m = PLATFORMS[state.platform].growthMetrics[state.growthMetric];
  const perHandle = new Map(state.data.accounts.map((a) => [a.handle, gains(a.handle, m.key, state.period)]));
  const keys = [...new Set([...perHandle.values()].flatMap((g) => [...g.keys()]))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const labels = keys.map((k) => (state.period === "day" ? shortDayFmt.format(dayMs(k)) : weekLabel(k)));
  const isBar = state.period === "week";
  const datasets = state.selected.map((h) => {
    const g = perHandle.get(h);
    const ds = isBar
      ? { label: who2(h), data: keys.map((k) => g.get(k) ?? null), backgroundColor: colorOf(h), borderRadius: 4,
          borderSkipped: "start", borderColor: cssVar("--surface"), borderWidth: 1, maxBarThickness: 36 }
      : lineDataset(who2(h), keys.map((k) => g.get(k) ?? null), colorOf(h), true);
    ds.handle = h;
    return ds;
  });
  applyOutliers(datasets);
  const opts = outlierPadding(baseOptions(`${m.label} erbij`), datasets);
  opts.scales.y.beginAtZero = true;
  if (!isBar) opts.spanGaps = true;
  drawChart("chart-growth", { type: isBar ? "bar" : "line", data: { labels, datasets }, options: opts, plugins: [endLabels, outlierMarks] });

  // Ranked table for the latest period.
  const lastKey = keys.at(-1);
  const periodName = state.period === "day" ? (lastKey ? shortDayFmt.format(dayMs(lastKey)) : "") : (lastKey ? weekLabel(lastKey) : "");
  document.getElementById("growth-title").textContent = `Grootste stijgers op ${PLATFORMS[state.platform].label} · ${periodName}`;
  document.getElementById("growth-col").textContent = `${m.label} erbij`;
  const rows = state.data.standings
    .map((r) => ({ r, gain: perHandle.get(r.handle).get(lastKey) ?? 0, total: r.cur ? r.cur[m.key] : null }))
    .sort((a, b) => b.gain - a.gain || a.r.handle.localeCompare(b.r.handle));
  const body = document.getElementById("growth-body");
  body.innerHTML = rows.map((x, i) => `
    <tr tabindex="0" data-handle="${esc(x.r.handle)}" data-platform="${state.platform}">
      <td class="rank num">${i + 1}</td>
      <td class="handle">${esc(who2(x.r.handle))}${x.r.isPrivate ? privateBadge() : ""}</td>
      <td class="num views">${signed(x.gain)}</td>
      <td class="num opt">${fmt(x.total)}</td>
    </tr>`).join("");
}

// ---------- views ----------

const privateBadge = () => `<span class="badge private" title="Dit account staat op privé en kan niet worden gevolgd">🔒 privé</span>`;

function changeCell(r) {
  if (r.rankChange == null) return `<span class="new">nieuw</span>`;
  if (r.rankChange > 0) return `<span class="up" aria-label="${r.rankChange} plaatsen gestegen in 24 uur">▲ ${r.rankChange}</span>`;
  if (r.rankChange < 0) return `<span class="down" aria-label="${-r.rankChange} plaatsen gedaald in 24 uur">▼ ${-r.rankChange}</span>`;
  return `<span class="same" aria-label="gelijk gebleven">–</span>`;
}

// Sortable columns of the leaderboard; the # column always keeps the real position.
const SORT_VALUE = {
  views: (r) => r.views,
  followers: (r) => (r.cur ? r.cur.followers : null),
  posts: (r) => (r.cur ? r.cur.campaign_posts : null),
  likes: (r) => (r.cur ? r.cur.campaign_likes : null),
};

function sortedStandings() {
  const { key, dir } = state.sort;
  const value = SORT_VALUE[key];
  return [...state.data.standings].sort((a, b) => {
    const va = value(a), vb = value(b);
    if (va == null || vb == null) return (va == null) - (vb == null) || a.rank - b.rank; // unknown always last
    return (va - vb) * dir || a.rank - b.rank;
  });
}

// Marks the sorted column of a leaderboard table (and the phone dropdown). On a phone the extra columns are hidden;
// the column being sorted on stays visible.
function renderSortHeadersOf(tableId, selectId, sort) {
  document.getElementById(tableId).dataset.sorted = sort.key;
  document.getElementById(selectId).value = sort.key;
  for (const th of document.querySelectorAll(`#${tableId} th[data-sort]`)) {
    const on = th.dataset.sort === sort.key;
    if (on) th.setAttribute("aria-sort", sort.dir < 0 ? "descending" : "ascending");
    else th.removeAttribute("aria-sort");
    const btn = th.querySelector("button");
    btn.dataset.arrow = on ? (sort.dir < 0 ? "▼" : "▲") : "";
    btn.title = on ? "Klik om de volgorde om te draaien" : "Klik om hierop te sorteren";
  }
}
const renderSortHeaders = () => renderSortHeadersOf("board", "sort-select", state.sort);

function renderBoard() {
  renderSortHeaders();
  const body = document.getElementById("board-body");
  const medal = { 1: "🥇", 2: "🥈", 3: "🥉" };
  const numbers = (r) => `
      <td class="num views c-views">${fmt(r.views)}</td>
      <td class="num opt gain">${r.gain == null ? "–" : signed(r.gain)}</td>
      <td class="num opt2 c-followers">${fmt(r.cur ? r.cur.followers : null)}</td>
      <td class="num opt2 c-posts">${fmt(r.cur ? r.cur.campaign_posts : null)}</td>
      <td class="num opt2 c-likes">${fmt(r.cur ? r.cur.campaign_likes : null)}</td>`;
  body.innerHTML = sortedStandings().map((r) => `
    <tr tabindex="0" data-handle="${esc(r.handle)}" data-platform="tiktok" class="${r.rank <= 3 && r.views > 0 ? "top3" : ""}">
      <td class="rank num">${r.rank <= 3 && r.views > 0 ? medal[r.rank] : r.rank}</td>
      <td class="chg">${changeCell(r)}</td>
      <td class="handle">${esc(who2(r.handle))}${r.isPrivate ? privateBadge() : ""}${accToggle(r)}</td>${numbers(r)}
    </tr>${r.multi && state.open.has(r.handle) ? r.handles.map((h) => `
    <tr tabindex="0" data-handle="${esc(h)}" data-platform="tiktok" class="sub-row">
      <td></td><td></td>
      <td class="handle"><span class="sub-mark">↳</span> @${esc(h)}</td>${numbers(state.data.accountRows.get(h))}
    </tr>`).join("") : ""}`).join("") || `<tr><td colspan="8">Nog geen accounts.</td></tr>`;
}

// Sortable columns of the Instagram leaderboard; the # column keeps the real place. Accounts without a baseline
// (no place) always come last.
const SORT_VALUE_IG = {
  gained: (r) => r.gained,
  followers: (r) => r.followers,
  posts: (r) => r.posts,
};

function sortedStandingsIg() {
  const { key, dir } = state.sortIg;
  const value = SORT_VALUE_IG[key];
  const place = (r) => (r.rank == null ? Infinity : r.rank);
  return [...state.data.standings].sort((a, b) => {
    const va = value(a), vb = value(b);
    if (va == null || vb == null) return (va == null) - (vb == null) || place(a) - place(b) || a.handle.localeCompare(b.handle);
    return (va - vb) * dir || place(a) - place(b) || a.handle.localeCompare(b.handle);
  });
}

// "vanaf 12 okt": the account was added later; its gain counts from its own first measurement.
const lateBadge = (r) => (r.late
  ? ` <span class="badge late" title="Later toegevoegd: de volgers erbij tellen vanaf de eerste meting van dit account (${esc(stampFmt.format(r.baselineAt))}), niet vanaf de start.">vanaf ${esc(shortDayFmt.format(dayMs(localDay(r.baselineAt))))}</span>` : "");

function renderBoardIg() {
  renderSortHeadersOf("board-ig", "sort-select-ig", state.sortIg);
  const d = state.data;
  const body = document.getElementById("board-ig-body");
  const note = document.getElementById("ig-note");
  const meta = document.getElementById("ig-meta");
  const medal = { 1: "🥇", 2: "🥈", 3: "🥉" };
  const placed = d.standings.filter((r) => r.rank != null).length;
  meta.textContent = d.accountList.length ? `${d.accountList.length} accounts` : "";
  note.hidden = d.ok && d.accountList.length > 0;
  note.textContent = !d.ok ? "De Instagram-gegevens konden niet worden geladen (is het tabblad al gepubliceerd?). TikTok werkt gewoon."
    : "Nog geen Instagram-accounts in de sheet: de eerste Instagram-run moet nog komen.";
  body.innerHTML = sortedStandingsIg().map((r) => `
    <tr tabindex="0" data-handle="${esc(r.handle)}" data-platform="instagram" class="${r.rank != null && r.rank <= 3 && r.gained > 0 ? "top3" : ""}">
      <td class="rank num">${r.rank == null ? "–" : r.rank <= 3 && r.gained > 0 ? medal[r.rank] : r.rank}</td>
      <td class="chg opt">${r.rank == null ? "" : changeCell(r)}</td>
      <td class="handle">${esc(who2(r.handle))}${r.isPrivate ? privateBadge() : ""}</td>
      <td class="num views c-gained">${r.gained == null ? "–" : signed(r.gained)}${lateBadge(r)}</td>
      <td class="num c-followers">${fmt(r.followers)}</td>
      <td class="num opt2 c-posts">${fmt(r.posts)}</td>
    </tr>`).join("") || `<tr><td colspan="6">Nog geen accounts.</td></tr>`;
  if (placed < d.standings.length && placed) {
    meta.textContent += ` · ${d.standings.length - placed} nog zonder meting (privé of nog niet opgehaald)`;
  }
}

// "▸ 2 accounts": one student with two accounts; opens a row per account (Stand).
function accToggle(r) {
  if (!r.multi) return "";
  const open = state.open.has(r.handle);
  return ` <button type="button" class="acc-toggle" data-open="${esc(r.handle)}" aria-expanded="${open}"
    title="Twee accounts van dezelfde deelnemer, opgeteld. Klik voor de cijfers per account.">${open ? "▾" : "▸"} ${r.handles.length} accounts</button>`;
}

function renderHashtags() {
  renderSeg("tagSort", TAG_SORTS);
  const by = state.tagSort;
  const rows = [...state.data.tags].sort((a, b) =>
    b[by] - a[by] || (by === "posts" ? b.views - a.views : b.posts - a.posts) || a.tag.localeCompare(b.tag));
  const shown = state.tagsAll ? rows : rows.slice(0, TAGS_SHOWN);
  const max = Math.max(1, ...rows.map((t) => t[by]));
  const totalPosts = [...state.data.posts.values()].reduce((n, list) => n + list.length, 0);
  const tagged = [...state.data.posts.values()].reduce((n, list) => n + list.filter((p) => p.tags.length).length, 0);
  document.getElementById("tags-meta").textContent =
    `${rows.length} verschillende hashtags · ${tagged} van ${totalPosts} campagneposts hebben er één of meer`;
  const bar = (v) => `<span class="cell-bar" style="--w:${(v / max) * 100}%"></span>`;
  document.getElementById("tags-body").innerHTML = shown.map((t, i) => {
    const open = state.tagOpen === t.tag;
    const accounts = [...t.accounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return `
    <tr tabindex="0" data-tag="${esc(t.tag)}" aria-expanded="${open}">
      <td class="rank num">${i + 1}</td>
      <td class="handle">#${esc(t.tag)}</td>
      <td class="num${by === "posts" ? " views bar-cell" : ""}">${by === "posts" ? bar(t.posts) : ""}${fmt(t.posts)}</td>
      <td class="num opt">${fmt(t.accounts.size)}</td>
      <td class="num${by === "views" ? " views bar-cell" : ""}">${by === "views" ? bar(t.views) : ""}${fmt(t.views)}</td>
      <td class="num opt2">${fmt(Math.round(t.views / t.posts))}</td>
    </tr>${open ? `
    <tr class="tag-detail"><td></td><td colspan="5">${accounts.map(([h, n]) =>
      `<a class="chip" href="#account/${encodeURIComponent(h)}">@${esc(h)}<span class="chip-n">${n}×</span></a>`).join("")}</td></tr>` : ""}`;
  }).join("") || `<tr><td colspan="6">Nog geen hashtags gevonden.</td></tr>`;
  const more = document.getElementById("tags-more");
  more.hidden = rows.length <= TAGS_SHOWN;
  more.textContent = state.tagsAll ? `Toon alleen de top ${TAGS_SHOWN}` : `Toon alle ${rows.length} hashtags`;
}

// The same handle on the other platform (handles are the only link the public data has between the two): a switch.
function platformSwitch(handle, platform) {
  const other = platform === "instagram" ? "tiktok" : "instagram";
  if (!state.all[other] || !state.all[other].keyOf.has(handle)) return "";
  return `<div class="seg account-platform" role="group" aria-label="Platform">${["instagram", "tiktok"].map((p) =>
    p === platform ? `<button type="button" aria-pressed="true" disabled>${PLATFORMS[p].label}</button>`
      : `<a class="seg-link" href="#${accountHash(p, handle)}">${PLATFORMS[p].label}</a>`).join("")}</div>`;
}
const platformBadge = (platform) => `<span class="badge platform">${PLATFORMS[platform].label}</span>`;

function renderAccountPage(handle) {
  if (state.accountPlatform === "instagram") renderAccountIg(handle);
  else renderAccount(handle);
}

const instagramUrl = (handle, post = null) =>
  post && /^https:\/\/(www\.)?instagram\.com\//i.test(post.url) ? post.url : `https://www.instagram.com/${encodeURIComponent(handle)}/`;
const postTypeNl = { photo: "foto", carousel: "carrousel", reel: "reel" };

function renderAccountIg(handle) {
  const el = document.getElementById("view-account");
  const r = state.data.standings.find((x) => x.handle === handle);
  if (!r) {
    el.innerHTML = `<a class="back" href="#stand">← Terug naar de stand</a><p>Instagram-account @${esc(handle)} niet gevonden.</p>`;
    return;
  }
  const posts = (state.data.posts.get(handle) || []).sort((a, b) => b.created - a.created);
  const tile = (label, value, sub = "") => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const since = r.baselineAt ? `sinds ${stampFmt.format(r.baselineAt)}${r.late ? " (later toegevoegd)" : ""}` : "nog geen eerste meting";
  el.innerHTML = `
    <a class="back" href="#stand">← Terug naar de stand</a>
    <div class="detail-head">
      <h2>${esc(who2(handle))}</h2>${platformBadge("instagram")}${r.isPrivate ? privateBadge() : ""}
      <a href="${instagramUrl(handle)}" target="_blank" rel="noopener">Bekijk op Instagram ↗</a>
    </div>
    ${platformSwitch(handle, "instagram")}
    ${r.isPrivate ? `<p class="notice">Dit account staat op privé. Zet het op openbaar, anders zijn de posts niet te zien.</p>` : ""}
    <div class="tiles">
      ${tile("Positie", r.rank == null ? "–" : r.rank, r.rank == null ? "" : changeCell(r))}
      ${tile("Volgers erbij", r.gained == null ? "–" : signed(r.gained), since)}
      ${tile("Volgers", fmt(r.followers))}
      ${tile("Posts", fmt(r.posts), "sinds de start op Instagram")}
    </div>
    <div class="grid2">
      <div><h3>Volgers erbij over tijd</h3><div class="chart-card short"><canvas id="chart-acc-gain"></canvas></div></div>
      <div><h3>Volgers over tijd</h3><div class="chart-card short"><canvas id="chart-acc-followers"></canvas></div></div>
    </div>
    ${accountTags(posts)}
    <h3 style="margin:18px 0 8px">Volgers erbij per dag</h3>
    <div class="chart-card short"><canvas id="chart-acc-daily"></canvas></div>
    <h2>Posts in de campagne (${posts.length})</h2>
    <div class="board-wrap">
      <table class="board small">
        <thead><tr><th>Geplaatst</th><th>Soort</th><th class="opt">Hashtags</th><th></th></tr></thead>
        <tbody>${posts.map((p) => `
          <tr>
            <td>${Number.isFinite(p.created) ? postDateFmt.format(p.created) : "–"}</td>
            <td>${esc(postTypeNl[p.type] || p.type || "–")}</td>
            <td class="opt">${p.tags.map((t) => "#" + esc(t)).join(" ") || "–"}</td>
            <td><a href="${esc(instagramUrl(handle, p))}" target="_blank" rel="noopener">open ↗</a></td>
          </tr>`).join("") || `<tr><td colspan="4">Nog geen posts gezien.</td></tr>`}
        </tbody>
      </table>
    </div>`;
  const accent = cssVar("--s1");
  const single = (chartId, key, label) =>
    drawChart(chartId, { type: "line", data: { datasets: [lineDataset(label, points(handle, key, null, state.data.series), accent, false)] }, options: timeAxis(baseOptions()) });
  single("chart-acc-gain", "gain", "Volgers erbij");
  single("chart-acc-followers", "followers", "Volgers");
  const g = gains(handle, "followers", "day", state.data.series);
  const keys = [...g.keys()];
  drawChart("chart-acc-daily", {
    type: "bar",
    data: {
      labels: keys.map((k) => shortDayFmt.format(dayMs(k))),
      datasets: [{ label: "Volgers erbij", data: keys.map((k) => g.get(k)), backgroundColor: accent,
                   borderRadius: 4, borderSkipped: "start", maxBarThickness: 28 }],
    },
    options: baseOptions(),
  });
}

function renderAccount(handle) {
  const el = document.getElementById("view-account");
  const key = state.data.keyOf.get(handle);
  const r = key && state.data.standings.find((x) => x.handle === key);
  if (!r) {
    el.innerHTML = `<a class="back" href="#stand">← Terug naar de stand</a><p>Account @${esc(handle)} niet gevonden.</p>`;
    return;
  }
  // Two accounts of one participant: both together (default), or one of them (dropdown). A link to
  // the second account's own handle (Video's, Hashtags, a row per account) opens that one.
  if (r.multi && handle !== key && state.accountView === null) state.accountView = handle;
  const one = r.multi && r.handles.includes(state.accountView) ? state.accountView : null;
  const v = one ? state.data.accountRows.get(one) : r;
  const src = one ? state.data.accountSeries : state.data.series;
  const id = one || key;
  const c = v.cur || {};
  const posts = (one ? [one] : r.handles).flatMap((h) => (state.data.posts.get(h) || []).map((p) => ({ ...p, handle: h })))
    .sort((a, b) => b.created - a.created);
  const tile = (label, value, sub = "") => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  el.innerHTML = `
    <a class="back" href="#stand">← Terug naar de stand</a>
    <div class="detail-head">
      <h2>${esc(who2(key))}</h2>${platformBadge("tiktok")}${r.isPrivate ? privateBadge() : ""}
      ${r.handles.map((h) => `<a href="https://www.tiktok.com/@${encodeURIComponent(h)}" target="_blank" rel="noopener">${r.multi ? `@${esc(h)} op ` : "Bekijk op "}TikTok ↗</a>`).join("")}
    </div>
    ${platformSwitch(handle, "tiktok")}
    ${r.multi ? `<div class="controls"><label class="check">Cijfers van <select id="acc-view">
      <option value="">beide accounts samen</option>${r.handles.map((h) => `<option value="${esc(h)}"${h === one ? " selected" : ""}>alleen @${esc(h)}</option>`).join("")}
    </select></label><span class="hint">Twee accounts van dezelfde deelnemer; in de stand tellen ze samen.</span></div>` : ""}
    ${r.isPrivate ? `<p class="notice">${r.multi ? "Een van deze accounts" : "Dit account"} staat op privé. Zet het op openbaar, anders tellen nieuwe weergaven niet mee.</p>` : ""}
    <div class="tiles">
      ${tile("Positie", r.rank, changeCell(r))}
      ${tile("Weergaven", fmt(v.views), v.gain == null ? "" : `${signed(v.gain)} in 24 uur`)}
      ${tile("Volgers", fmt(c.followers))}
      ${tile("Posts", fmt(c.campaign_posts), "sinds start campagne")}
      ${tile("Likes", fmt(c.campaign_likes), "op campagneposts")}
      ${tile("Gem. weergaven/post", c.campaign_posts ? fmt(Math.round(v.views / c.campaign_posts)) : "–")}
    </div>
    <div class="grid2">
      <div><h3>Weergaven over tijd</h3><div class="chart-card short"><canvas id="chart-acc-views"></canvas></div></div>
      <div><h3>Volgers over tijd</h3><div class="chart-card short"><canvas id="chart-acc-followers"></canvas></div></div>
    </div>
    ${accountTags(posts)}
    <div id="acc-videos" hidden>
      <h3 style="margin:18px 0 4px">Weergaven per video</h3>
      <p class="hint" id="acc-videos-note" style="margin:0 0 8px"></p>
      <div class="chart-card short"><canvas id="chart-acc-videos" aria-label="Weergaven per video over tijd"></canvas></div>
    </div>
    <h3 style="margin:18px 0 8px">Weergaven erbij per dag</h3>
    <div class="chart-card short"><canvas id="chart-acc-daily"></canvas></div>
    <h2>Posts in de campagne (${posts.length})</h2>
    <div class="board-wrap">
      <table class="board small">
        <thead><tr><th>Geplaatst</th><th class="num">Weergaven</th><th class="num opt">Likes</th><th class="num opt2">Reacties</th><th class="num opt2">Gedeeld</th><th></th></tr></thead>
        <tbody>${posts.map((p) => `
          <tr>
            <td>${Number.isFinite(p.created) ? postDateFmt.format(p.created) : "–"}${p.type && p.type !== "video" ? ` <span class="badge pinned">${esc(p.type)}</span>` : ""}${p.pinned ? ` <span class="badge pinned">📌 vastgezet</span>` : ""}</td>
            <td class="num views">${fmt(p.views)}</td>
            <td class="num opt">${fmt(p.likes)}</td>
            <td class="num opt2">${fmt(p.comments)}</td>
            <td class="num opt2">${fmt(p.shares)}</td>
            <td>${r.multi && !one ? `<span class="meta">@${esc(p.handle)}</span> ` : ""}<a href="https://www.tiktok.com/@${encodeURIComponent(p.handle)}/video/${esc(p.id)}" target="_blank" rel="noopener">open ↗</a></td>
          </tr>`).join("") || `<tr><td colspan="6">Nog geen posts gezien.</td></tr>`}
        </tbody>
      </table>
    </div>`;

  const accent = cssVar("--s1");
  const single = (chartId, key, label) =>
    drawChart(chartId, { type: "line", data: { datasets: [lineDataset(label, points(id, key, null, src), accent, false)] }, options: timeAxis(baseOptions()) });
  single("chart-acc-views", "total_views", "Weergaven");
  single("chart-acc-followers", "followers", "Volgers");
  const g = gains(id, "total_views", "day", src);
  const keys = [...g.keys()];
  const opts = baseOptions();
  drawChart("chart-acc-daily", {
    type: "bar",
    data: {
      labels: keys.map((k) => shortDayFmt.format(dayMs(k))),
      datasets: [{ label: "Weergaven erbij", data: keys.map((k) => g.get(k)), backgroundColor: accent,
                   borderRadius: 4, borderSkipped: "start", maxBarThickness: 28 }],
    },
    options: opts,
  });
  renderVideoChart(handle, posts);
}

// The account's own hashtags, most used first.
function accountTags(posts) {
  const count = new Map();
  for (const p of posts) for (const t of new Set(p.tags)) count.set(t, (count.get(t) || 0) + 1);
  if (!count.size) return "";
  const list = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return `<h3 style="margin:18px 0 8px">Hashtags</h3><div class="chips">${list.map(([t, n]) =>
    `<span class="chip static">#${esc(t)}<span class="chip-n">${n}×</span></span>`).join("")}</div>`;
}

// Finale banner (live countdown) and the Eindstand heading.
function renderFinale() {
  const banner = document.getElementById("finale");
  const phase = finalePhase();
  const title = document.getElementById("final-title");
  const final = Boolean(state.data && state.data.final);
  if (title) {
    title.hidden = !final;
    if (final) {
      title.textContent = `🏁 Eindstand · ${stampFmt.format(FINALE.end)}`
        + (state.data.latest ? ` · laatste meting ${hourFmt.format(state.data.latest)}` : "");
    }
  }
  if (!banner) return;
  if (phase === "live") {
    banner.innerHTML = `<span class="live">LIVE</span> Finale · nog <strong>${countdown(FINALE.end - now())}</strong> tot de deadline (${hourFmt.format(FINALE.end)})`;
  } else if (phase === "after") {
    banner.innerHTML = `🏁 <strong>Eindstand</strong> · de finale is afgelopen (${stampFmt.format(FINALE.end)})`;
  }
  banner.hidden = !(phase === "live" || phase === "after");
}

// The metric buttons depend on the platform; keep the chosen ones valid when the platform is switched.
function normalizeMetrics() {
  const p = PLATFORMS[state.platform];
  if (!p.metrics[state.metric]) state.metric = p.metric;
  if (!p.growthMetrics[state.growthMetric]) state.growthMetric = p.growthMetric;
}

function render() {
  if (!state.all.tiktok) return;
  for (const a of document.querySelectorAll(".tabs a")) {
    const active = a.dataset.view === state.view || (state.view === "account" && a.dataset.view === "stand");
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${state.view}`;
  // Stand shows both platforms (Instagram first); Grafiek and Groei one at a time (the platform switch); Video's and
  // Hashtags are TikTok only; an account page is the platform of its link.
  if (state.view === "stand") {
    on("tiktok", renderBoard);
    on("instagram", renderBoardIg);
    document.getElementById("tt-meta").textContent = `${state.all.tiktok.accountList.length} accounts`;
  }
  if (state.view === "grafiek") {
    normalizeMetrics();
    useData(state.platform);
    renderSeg("platform", PLATFORM_LABELS);
    renderSeg("metric", PLATFORMS[state.platform].metrics);
    renderSeg("range", RANGES);
    renderChips("chips-grafiek");
    renderMainChart();
  }
  if (state.view === "groei") {
    normalizeMetrics();
    useData(state.platform);
    renderSeg("platform", PLATFORM_LABELS);
    renderSeg("growthMetric", PLATFORMS[state.platform].growthMetrics);
    renderSeg("period", PERIODS);
    renderChips("chips-groei");
    renderGrowth();
  }
  if (state.view === "hashtags") on("tiktok", renderHashtags);
  if (state.view === "videos") on("tiktok", renderVideos);
  if (state.view === "account") on(state.accountPlatform, () => renderAccountPage(state.account));
  renderFinale();
}

// #account/<handle> is a TikTok account, #account/ig/<handle> an Instagram account (the same handle can exist on both).
const accountHash = (platform, handle) => (platform === "instagram" ? "account/ig/" : "account/") + encodeURIComponent(handle);

function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (hash.startsWith("account/")) {
    state.view = "account";
    state.accountPlatform = hash.startsWith("account/ig/") ? "instagram" : "tiktok";
    state.account = hash.slice(state.accountPlatform === "instagram" ? 11 : 8);
    state.accountView = null; // both accounts together, or the account in the link
    window.scrollTo(0, 0);
  } else {
    state.view = ["stand", "grafiek", "groei", "videos", "hashtags"].includes(hash) ? hash : "stand";
  }
  render();
}

function openAccount(ev) {
  if (ev.type === "keydown" && ev.key !== "Enter") return;
  const toggle = ev.target.closest("button[data-open]");
  if (toggle) {
    if (ev.type === "click") {
      const key = toggle.dataset.open;
      if (state.open.has(key)) state.open.delete(key); else state.open.add(key);
      on("tiktok", renderBoard);
    }
    return;
  }
  const tr = ev.target.closest("tr[data-handle]");
  if (tr) location.hash = accountHash(tr.dataset.platform || "tiktok", tr.dataset.handle);
}

document.getElementById("show-others").addEventListener("change", (e) => { state.showOthers = e.target.checked; render(); });
document.getElementById("view-account").addEventListener("change", (e) => {
  if (e.target.id !== "acc-view") return;
  state.accountView = e.target.value; // "" = both together
  on("tiktok", () => renderAccount(state.account));
});
for (const id of ["board-body", "board-ig-body", "growth-body", "videos-body"]) {
  document.getElementById(id).addEventListener("click", openAccount);
  document.getElementById(id).addEventListener("keydown", openAccount);
}
document.querySelector("#board thead").addEventListener("click", (ev) => {
  const th = ev.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : -1 };
  on("tiktok", renderBoard);
});
document.getElementById("sort-select").addEventListener("change", (ev) => {
  state.sort = { key: ev.target.value, dir: -1 };
  on("tiktok", renderBoard);
});
document.querySelector("#board-ig thead").addEventListener("click", (ev) => {
  const th = ev.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  state.sortIg = { key, dir: state.sortIg.key === key ? -state.sortIg.dir : -1 };
  on("instagram", renderBoardIg);
});
document.getElementById("sort-select-ig").addEventListener("change", (ev) => {
  state.sortIg = { key: ev.target.value, dir: -1 };
  on("instagram", renderBoardIg);
});
function toggleTag(ev) {
  if (ev.type === "keydown" && ev.key !== "Enter") return;
  const tr = ev.target.closest("tr[data-tag]");
  if (!tr) return;
  state.tagOpen = state.tagOpen === tr.dataset.tag ? null : tr.dataset.tag;
  on("tiktok", renderHashtags);
  document.querySelector(`#tags-body tr[data-tag="${CSS.escape(tr.dataset.tag)}"]`)?.focus();
}
document.getElementById("tags-body").addEventListener("click", toggleTag);
document.getElementById("tags-body").addEventListener("keydown", toggleTag);
document.getElementById("tags-more").addEventListener("click", () => { state.tagsAll = !state.tagsAll; on("tiktok", renderHashtags); });
window.addEventListener("hashchange", route);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

// Start once every script (including present.js) has run.
document.addEventListener("DOMContentLoaded", () => {
  if (IS_PRESENT) Present.start();
  else route();
  load();
  scheduleLoad();
});

// Reload every refreshMinutes; every 2 minutes during the finale.
function scheduleLoad() {
  const minutes = finalePhase() === "live" ? 2 : CFG.refreshMinutes || 10;
  setTimeout(() => { load(); scheduleLoad(); }, minutes * 60 * 1000);
}

// Finale: tick the countdown every second; at the deadline switch to the Eindstand.
if (!IS_PRESENT) {
  let phase = finalePhase();
  setInterval(() => {
    if (!state.data) return;
    const next = finalePhase();
    if (next !== phase) {
      phase = next;
      if (next === "after") load(); else renderFinale();
    } else if (next === "live") renderFinale();
  }, 1000);
}
