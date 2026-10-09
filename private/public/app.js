// Private dashboard page. All data comes from the Worker API (/api/*) behind Cloudflare Access.
import * as lib from "./lib.js";

const WARN_DAYS = 2; // "no post for 2+ days" (free days don't count)
const WEEKDAYS_NL = { monday: "maandag", tuesday: "dinsdag", wednesday: "woensdag", thursday: "donderdag",
  friday: "vrijdag", saturday: "zaterdag", sunday: "zondag" };
const nf = new Intl.NumberFormat("nl-NL");
const pct = new Intl.NumberFormat("nl-NL", { style: "percent", maximumFractionDigits: 1 });
const stampFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: lib.TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const shortDate = new Intl.DateTimeFormat("nl-NL", { timeZone: "UTC", day: "numeric", month: "short" });
const fmt = (n) => (n == null ? "–" : nf.format(n));
const signed = (n) => (n == null ? "–" : (n > 0 ? "+" : n < 0 ? "−" : "±") + nf.format(Math.abs(n)));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PLATFORM_NL = { tiktok: "TikTok", instagram: "Instagram" };
const FREQ_NL = { off: "uit", daily: "1× per dag", "12h": "elke 12 uur", "6h": "elke 6 uur", "4h": "elke 4 uur", "2h": "elke 2 uur" };
const dayLabel = (d) => dateFmt.format(Date.parse(d + "T00:00:00Z"));
const instagram = (h) => `https://www.instagram.com/${encodeURIComponent(h)}/`;
// Link to an Instagram post: the post's own url when it is an instagram.com link, else the profile.
const instagramPost = (p) => (/^https:\/\/(www\.)?instagram\.com\//i.test(String(p.url ?? "").trim()) ? String(p.url).trim() : instagram(p.handle));
const IG_TYPE_NL = { photo: "foto", reel: "reel", carousel: "carrousel" };
const tiktok = (h, id) => `https://www.tiktok.com/@${encodeURIComponent(h)}${id ? `/video/${encodeURIComponent(id)}` : ""}`;
const $ = (id) => document.getElementById(id);

const state = {
  raw: null, view: "overzicht", detail: null,
  sort: { key: "rank", dir: 1 }, search: "", onlyWarn: false,
  tagSort: "posts", tagOpen: null, accSearch: "", format: "nl",
  videoRange: 24, postHistory: null, finaleCardKey: null,
  warnOpen: null,        // Overzicht: handle whose warning details are shown
  open: new Set(),       // students with two accounts whose per-account rows are shown (Overzicht, Leerlingen)
  account: null,         // student page: one account of a student with two ("" or null = both together)
  hideOutliers: null,    // Stijgers/Hashtags "zonder buiten schaal"; null = on when any account is marked
  taskEdit: null,        // Beheer: dagopdracht being edited (row)
  todayRun: null,        // Vandaag: { startedAt, count } while a "Controleer nu" run is on its way
  addFor: null,          // Beheer: account row with the "+ account" form open
  igFor: null,           // Beheer: accounts row whose Instagram-handle form is open
  igDraft: new Map(),    // Beheer: Instagram handles being typed in the "zonder Instagram" list (row -> text)
};
const hourFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: lib.TZ, hour: "2-digit", minute: "2-digit" });
const longDate = new Intl.DateTimeFormat("nl-NL", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
const DAY_MS = 864e5;
const countdown = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
};

// ---------- API ----------

async function api(path, body) {
  const init = body === undefined ? { cache: "no-store" } : {
    method: "POST", cache: "no-store",
    headers: { "content-type": "application/json", "x-requested-with": "tiktok-beheer" },
    body: JSON.stringify(body),
  };
  const res = await fetch(path, { credentials: "same-origin", ...init });
  let data = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status === 403) throw new Error("Geen toegang (meer). Laad de pagina opnieuw om opnieuw in te loggen.");
  if (!res.ok) throw new Error(data.error || `Server gaf HTTP ${res.status}`);
  return data;
}

// ---------- model ----------

function build(raw) {
  const cfg = raw.config;
  const now = raw.serverTime;
  // After a finale everything is frozen at the last run before its end (Eindstand).
  const final = Boolean(raw.finale && Date.now() >= raw.finale.end);
  const cutoff = final ? raw.finale.end : Infinity;
  const handleInfo = new Map(raw.handles.map((h) => [String(h.handle), h]));
  const history = new Map();
  let latest = 0;
  for (const r of raw.history) {
    const t = lib.parseTs(r.timestamp);
    if (t === null || t > cutoff) continue;
    const h = String(r.handle);
    if (!history.has(h)) history.set(h, []);
    history.get(h).push({ t, views: lib.toNum(r.total_views) ?? 0, followers: lib.toNum(r.followers),
      posts: lib.toNum(r.campaign_posts) ?? 0, likes: lib.toNum(r.campaign_likes) ?? 0 });
    latest = Math.max(latest, t);
  }
  for (const s of history.values()) s.sort((a, b) => a.t - b.t);
  const tasks = raw.tasks || [];
  const outliers = new Set(raw.outliers || []);
  const posts = new Map();
  for (const p of raw.posts) {
    const h = String(p.handle);
    if (!posts.has(h)) posts.set(h, []);
    posts.get(h).push(p);
  }
  // Instagram: profile status (ig_handles), follower history, posts (marked platform "instagram") and the baseline.
  const igInfo = new Map((raw.igHandles || []).map((h) => [String(h.handle), h]));
  const igSeries = new Map();
  let latestIg = 0;
  for (const r of raw.igHistory || []) {
    const t = lib.parseTs(r.timestamp);
    if (t === null || t > cutoff) continue;
    const h = String(r.handle);
    if (!igSeries.has(h)) igSeries.set(h, []);
    igSeries.get(h).push({ t, followers: lib.toNum(r.followers), following: lib.toNum(r.following), posts: lib.toNum(r.campaign_posts) ?? 0 });
    latestIg = Math.max(latestIg, t);
  }
  for (const list of igSeries.values()) list.sort((a, b) => a.t - b.t);
  const igBaseline = new Map((raw.igBaseline || []).map((r) => [String(r.handle),
    { t: lib.parseTs(r.baseline_at), followers: lib.toNum(r.baseline_followers) }]));
  const igPosts = new Map();
  for (const p of lib.instagramPosts(raw.igPosts)) {
    const h = String(p.handle);
    if (!igPosts.has(h)) igPosts.set(h, []);
    igPosts.get(h).push(p);
  }
  // "+ 24 uur": compared with the run of ~24 hours earlier (rolling, runs are every 2 hours).
  const target = latest - DAY_MS + 45 * 60 * 1000;
  // Numbers of one series (an account, or a student's accounts added up).
  const numbers = (series, postList) => {
    const cur = series.at(-1) || null;
    let base = null;
    for (let i = series.length - 1; i >= 0; i--) if (series[i].t <= target) { base = series[i]; break; }
    return { series, cur, views: cur ? cur.views : 0, gain: cur && base ? cur.views - base.views : null,
      followers: cur ? cur.followers : null, posts: postList, stats: lib.studentStats(postList, cfg, now, tasks) };
  };
  // Instagram was not followed before its start date: for the Instagram account alone, and for a student without
  // TikTok, those days are neither missed nor part of the streak.
  const igFrom = cfg.instagram?.startDate || null;
  // The Instagram account of a student, shaped like a TikTok account (stats, posts, info, series) plus its followers.
  const igAccount = (handle) => {
    const info = igInfo.get(handle) || null;
    const series = igSeries.get(handle) || [];
    const cur = series.at(-1) || null;
    const base = igBaseline.get(handle) || null;
    const list = igPosts.get(handle) || [];
    const followers = cur && cur.followers != null ? cur.followers : lib.toNum(info?.followers);
    return { handle, key: lib.instagramKey(handle), platform: "instagram", info, series, cur, posts: list, followers,
      baseline: base && base.t !== null ? base : null,
      gained: base && followers != null && base.followers != null ? followers - base.followers : null,
      views: 0, gain: null, isPrivate: info ? lib.truthy(info.is_private) : false, isOutlier: false,
      stats: lib.studentStats(list, cfg, now, tasks, { from: igFrom }) };
  };
  // One row per student; a student with two accounts (main_account) gets both added up. Every
  // student keeps `accounts` (the TikTok accounts): the numbers per account, for the "per account" dropdowns.
  // A student can also have one Instagram account (`ig`) or only that (no TikTok accounts).
  const students = [...lib.groupAccounts(raw.accounts).values()].map((g) => {
    const accounts = g.accounts.map((a) => {
      const info = handleInfo.get(a.handle) || null;
      return { ...a, key: a.handle, info, ...numbers(history.get(a.handle) || [], posts.get(a.handle) || []),
        isPrivate: info ? lib.truthy(info.is_private) : false, isOutlier: outliers.has(a.handle) };
    });
    const ig = g.instagram ? igAccount(g.instagram) : null;
    const multi = accounts.length > 1;
    const main = accounts[0] || { row: g.instagramRow, instagram: g.instagram, instagramRaw: g.instagram || "", ...numbers([], []) };
    const parts = [...accounts, ...(ig ? [ig] : [])];
    const s = {
      ...main, name: g.name, handle: g.key, handles: accounts.map((a) => a.handle), accounts, multi, ig, parts,
      split: parts.length > 1,
      ...(multi ? numbers(lib.mergeSeries(accounts.map((a) => a.series)), accounts.flatMap((a) => a.posts)) : {}),
      isPrivate: parts.some((a) => a.isPrivate), isOutlier: accounts.some((a) => a.isOutlier),
      // The student's one Instagram account (tracked), the first row it is typed on, and what that cell holds now.
      instagram: g.instagram, instagramRow: g.instagramRow, instagramIssue: g.instagramIssue,
      igCurrent: main.instagram, igRaw: main.instagramRaw,
    };
    // `posts` stays the TikTok posts (views, tables, "verdwenen"); `allPosts` and `stats` (calendar, streak, missed days,
    // "geen post", dagopdrachten) count a post on either platform.
    s.allPosts = ig ? [...s.posts, ...ig.posts] : s.posts;
    if (ig) s.stats = lib.studentStats(s.allPosts, cfg, now, tasks, { from: accounts.length ? null : igFrom });
    s.warnings = warnings(s, cfg, now, igInfo.size > 0);
    return s;
  });
  const sorted = [...students].sort((x, y) => y.views - x.views || x.handle.localeCompare(y.handle));
  sorted.forEach((s, i) => { s.rank = i > 0 && sorted[i - 1].views === s.views ? sorted[i - 1].rank : i + 1; });
  // Every account handle leads to its student (Stijgers, Hashtags and Opvallend work per account), and so does
  // "instagram:<handle>" (the Instagram account's own row).
  const byHandle = new Map(students.flatMap((s) => [...s.handles.map((h) => [h, s]), ...(s.ig ? [[s.ig.key, s]] : []), [s.handle, s]]));
  return { cfg, now, latest, latestIg, igFetched: igInfo.size > 0, final, students, posts, tags: lib.hashtagStats(posts), tasks, outliers, series: history,
    taskByDay: new Map(tasks.map((t) => [t.date, t])), byHandle };
}

// "@a + @b" for a student with two TikTok accounts; "· IG @c" adds the Instagram account.
const handlesText = (s) => [s.handles.map((h) => "@" + h).join(" + "), s.ig ? `IG @${s.ig.handle}` : ""].filter(Boolean).join(" · ");

// Warnings per student. `detail` (HTML) is what a click on the badge shows: which video, since when.
function warnings(s, cfg, now, igFetched = true) {
  const out = [];
  // Status per account; with two accounts (or TikTok and Instagram) the badge says which one.
  for (const a of s.accounts) {
    const which = s.multi ? ` (@${a.handle})` : s.ig ? " (TikTok)" : "";
    const status = String(a.info?.last_status ?? "");
    const sinceTs = lib.parseTs(a.info?.status_since);
    const since = sinceTs ? `sinds ${stampFmt.format(sinceTs)}` : "sinds onbekend (vóór deze versie niet bijgehouden)";
    if (a.isPrivate) {
      out.push({ cls: "bad", kind: "private", text: "privé" + which,
        detail: `${s.multi ? `@${esc(a.handle)} staat` : "Staat"} op privé ${since}. Nieuwe weergaven tellen pas weer mee als het account openbaar is.` });
    }
    if (status.startsWith("fout")) {
      out.push({ cls: "bad", kind: "notfound", text: "niet gevonden" + which, title: status,
        detail: `${s.multi ? `@${esc(a.handle)}: n` : "N"}iet gevonden ${since}. Melding: <code>${esc(status.replace(/^fout:\s*/, ""))}</code>. Klopt de handle nog?` });
    }
    if (!a.info) out.push({ cls: "info", kind: "new", text: "nog niet opgehaald" + which, detail: "Wordt opgehaald bij de volgende profielrun." });
  }
  if (s.ig) {
    const a = s.ig;
    const status = String(a.info?.last_status ?? "");
    const sinceTs = lib.parseTs(a.info?.status_since);
    const since = sinceTs ? `sinds ${stampFmt.format(sinceTs)}` : "sinds onbekend";
    if (a.isPrivate) {
      out.push({ cls: "bad", kind: "private", text: "privé (Instagram)",
        detail: `Instagram @${esc(a.handle)} staat op privé ${since}. Posts van een privé-account zijn niet te zien; zodra het account openbaar is, worden de nieuwste posts alsnog opgehaald.` });
    }
    if (status.startsWith("fout")) {
      out.push({ cls: "bad", kind: "notfound", text: "niet gevonden (Instagram)", title: status,
        detail: `Instagram @${esc(a.handle)} niet gevonden ${since}. Melding: <code>${esc(status.replace(/^fout:\s*/, ""))}</code>. Klopt de handle nog?` });
    }
    // Before the very first Instagram run every student would get this badge; Overzicht shows one note instead.
    if (!a.info && igFetched) out.push({ cls: "info", kind: "new", text: "nog niet opgehaald (Instagram)", detail: "Wordt opgehaald bij de volgende Instagram-run." });
  }
  const anyInfo = s.accounts.some((a) => a.info) || Boolean(s.ig?.info);
  const today = lib.localDay(now);
  // Counted in days on which posting is expected: weekends and holidays (off_days) are left out.
  if (anyInfo && today <= cfg.campaign.end && s.stats.quietDays !== null && s.stats.quietDays >= WARN_DAYS) {
    out.push({ cls: "warn", kind: "quiet", text: s.stats.lastDay ? `${s.stats.quietDays} dagen geen post` : "nog geen post",
      title: s.ig ? "Weekenden en vakantiedagen tellen niet mee; TikTok en Instagram tellen allebei" : "Weekenden en vakantiedagen tellen niet mee",
      detail: s.stats.lastDay ? `Laatste post: ${stampFmt.format(s.stats.last)}${s.ig ? ` op ${PLATFORM_NL[s.stats.lastPlatform]}` : ""}. Weekenden en vakantiedagen tellen niet mee. Een post op TikTok of Instagram telt.`
        : "Nog geen enkele campagnepost gezien." });
  }
  if (s.stats.missing) {
    const gone = s.posts.filter((p) => String(p.missing_since || "").trim())
      .sort((a, b) => String(a.missing_since).localeCompare(String(b.missing_since)));
    out.push({ cls: "warn", kind: "missing", text: `${s.stats.missing} video${s.stats.missing > 1 ? "'s" : ""} verdwenen`,
      title: "Stond eerder in het profiel maar nu niet meer: verwijderd of verborgen?",
      detail: `Stond eerder in het profiel maar nu niet meer (verwijderd of verborgen?). De laatst bekende cijfers tellen mee.<ul>${gone.map((p) => {
        const c = lib.parseTs(p.created_at), m = lib.parseTs(p.missing_since);
        return `<li>Video van ${c ? stampFmt.format(c) : "?"}${s.multi ? ` (@${esc(p.handle)})` : ""}, ${fmt(lib.toNum(p.views))} weergaven: verdwenen sinds ${m ? stampFmt.format(m) : esc(p.missing_since)}.
          <a href="${tiktok(p.handle, p.video_id)}" target="_blank" rel="noopener">open ↗</a></li>`;
      }).join("")}</ul>` });
  }
  for (const t of s.stats.tasks.filter((x) => x.status === "missed")) {
    out.push({ cls: "warn", kind: "task", text: `opdracht ${shortDay(t.date)}: ${t.count}/${t.min}`,
      detail: `Dagopdracht ${dayLabel(t.date)}${t.label ? ` (${esc(t.label)})` : ""}: minimaal ${t.min} posts, gepost: ${t.count}.` });
  }
  return out;
}

// Alphabetical by name (Dutch rules); students without a name ("onbekend") go last.
const byName = (a, b) => (!a.name - !b.name) || (a.name || "").localeCompare(b.name || "", "nl") || a.handle.localeCompare(b.handle);
const nameCell = (s) => (s.name ? esc(s.name) : `<mark class="unknown">onbekend</mark>`);
const badges = (list) => list.map((w) => `<span class="badge ${w.cls}"${w.title ? ` title="${esc(w.title)}"` : ""}>${esc(w.text)}</span>`).join("");
// Clickable badges (Overzicht): a click shows the details under the row.
const warnButtons = (s) => s.warnings.map((w) => `<button type="button" class="badge ${w.cls}" data-warn="${esc(s.handle)}"
  aria-expanded="${state.warnOpen === s.handle}" title="${esc(w.title || "Klik voor details")}">${esc(w.text)}</button>`).join("");
const warnDetails = (s) => `<ul class="warn-list">${s.warnings.filter((w) => w.detail)
  .map((w) => `<li><span class="badge ${w.cls}">${esc(w.text)}</span> ${w.detail}</li>`).join("")}</ul>`;
const shortDay = (d) => shortDate.format(Date.parse(d + "T00:00:00Z"));
const studentLink = (s, extra = "") => `<a class="chip" href="#leerlingen/${encodeURIComponent(s.handle)}">${s.name ? esc(s.name) : "onbekend"}
  <span class="chip-handle">${esc(handlesText(s))}</span>${extra}</a>`;

// ---------- Overzicht ----------

const SORTS = {
  rank: (s) => s.rank, name: (s) => (s.name || "").toLowerCase() || null, handle: (s) => s.handle,
  views: (s) => s.views, gain: (s) => s.gain, followers: (s) => s.followers, posts: (s) => s.stats.posts,
  likes: (s) => s.stats.likes, last: (s) => s.stats.last, warnings: (s) => s.warnings.length,
};
const DEFAULT_DIR = { rank: 1, name: 1, handle: 1 }; // others start high -> low

function renderOverview(m) {
  const all = m.students;
  const withWarn = all.filter((s) => s.warnings.length).length;
  const tile = (label, value, sub = "") => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  $("ov-tiles").innerHTML =
    tile("Leerlingen gevolgd", fmt(all.length), `${m.cfg.campaign.start} t/m ${m.cfg.campaign.end}`)
    + tile("Weergaven", fmt(all.reduce((n, s) => n + s.views, 0)),
      all.length ? `mediaan per leerling: <strong>${fmt(Math.round(lib.median(all.map((s) => s.views))))}</strong>` : "")
    + tile("Posts", fmt(all.reduce((n, s) => n + s.stats.posts, 0)),
      all.some((s) => s.ig) ? `TikTok ${fmt(all.reduce((n, s) => n + s.stats.tiktokPosts, 0))} · Instagram ${fmt(all.reduce((n, s) => n + s.stats.instagramPosts, 0))}` : "")
    + tile("Met waarschuwing", fmt(withWarn), withWarn ? "zie kolom Let op" : "alles in orde");

  const q = state.search.trim().toLowerCase().replace(/^@/, "");
  let rows = all.filter((s) => (!state.onlyWarn || s.warnings.length)
    && (!q || s.handles.some((h) => h.includes(q)) || (s.ig && s.ig.handle.toLowerCase().includes(q)) || (s.name || "onbekend").toLowerCase().includes(q)));
  const { key, dir } = state.sort;
  const val = SORTS[key];
  rows = rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null || vb == null) return (va == null) - (vb == null) || a.rank - b.rank;
    const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return c * dir || a.rank - b.rank;
  });
  for (const th of document.querySelectorAll("#ov-table th[data-sort]")) {
    const on = th.dataset.sort === key;
    if (on) th.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending"); else th.removeAttribute("aria-sort");
    th.querySelector("button").dataset.arrow = on ? (dir > 0 ? "▲" : "▼") : "";
  }
  renderActions(m);
  $("ov-ig-note").hidden = m.igFetched || !all.some((s) => s.ig);
  $("ov-body").innerHTML = rows.map((s) => `
    <tr class="link" tabindex="0" data-handle="${esc(s.handle)}">
      <td class="num strong">${s.rank}</td>
      <td>${nameCell(s)}${s.isOutlier ? ` <span class="badge info" title="Buiten de schaal van de grafieken; plaats en cijfers tellen gewoon">buiten schaal</span>` : ""}<span class="phone-only meta">${esc(handlesText(s))}</span>${accToggle(s, "phone-only")}<span class="phone-only">${warnButtons(s)}</span></td>
      <td class="handle wide-only">${esc(handlesText(s))}${accToggle(s)}</td>
      <td class="num strong">${fmt(s.views)}</td>
      <td class="num opt">${signed(s.gain)}</td>
      <td class="num opt">${fmt(s.followers)}</td>
      <td class="num">${fmt(s.stats.posts)}</td>
      <td class="num opt">${fmt(s.stats.likes)}</td>
      <td class="opt">${s.stats.lastDay ? dayLabel(s.stats.lastDay) : "–"}</td>
      <td class="wide-only">${warnButtons(s)}</td>
    </tr>${state.open.has(s.handle) ? s.parts.map((a) => `
    <tr class="link sub-row" tabindex="0" data-handle="${esc(a.key)}">
      <td></td>
      <td><span class="sub-mark">↳</span> <span class="meta">${partLabel(s, a)}</span><span class="phone-only meta">@${esc(a.handle)}</span></td>
      <td class="handle wide-only">@${esc(a.handle)}</td>
      <td class="num">${a.platform === "instagram" ? "–" : fmt(a.views)}</td>
      <td class="num opt">${a.platform === "instagram" ? "–" : signed(a.gain)}</td>
      <td class="num opt">${a.platform === "instagram" ? "–" : fmt(a.followers)}</td>
      <td class="num">${fmt(a.stats.posts)}</td>
      <td class="num opt">${a.platform === "instagram" ? "–" : fmt(a.stats.likes)}</td>
      <td class="opt">${a.stats.lastDay ? dayLabel(a.stats.lastDay) : "–"}</td>
      <td class="wide-only">${accountBadges(a)}</td>
    </tr>`).join("") : ""}${state.warnOpen === s.handle && s.warnings.length ? `<tr class="warn-detail"><td colspan="10">${warnDetails(s)}</td></tr>` : ""}`).join("")
    || `<tr><td colspan="10">Geen leerlingen gevonden.</td></tr>`;
}

// "▸ 2 accounts": shows or hides the per-account rows of a student with more than one account (two on TikTok, or TikTok and Instagram).
const accToggle = (s, cls = "") => (s.split ? `<button type="button" class="acc-toggle ${cls}" data-open="${esc(s.handle)}"
  aria-expanded="${state.open.has(s.handle)}" title="Cijfers per account">${state.open.has(s.handle) ? "▾" : "▸"} ${s.parts.length} accounts</button>` : "");
// What a per-account row calls the account.
const partLabel = (s, a) => (a.platform === "instagram" ? "Instagram" : s.multi ? (a.handle === s.handle ? "eerste account" : "tweede account") : "TikTok");
// Status of one account (per-account rows).
const accountBadges = (a) => [a.isPrivate ? `<span class="badge bad">privé</span>` : "",
  String(a.info?.last_status ?? "").startsWith("fout") ? `<span class="badge bad" title="${esc(a.info.last_status)}">niet gevonden</span>` : "",
  !a.info ? `<span class="badge info">nog niet opgehaald</span>` : ""].join("");

// Vandaag (Amsterdam) for every tracked student: posts today, required (1 or the dagopdracht), done.
function todayOf(m) {
  const st = lib.todayStatus(m.cfg, m.students.map((s) => ({ handle: s.handle, posts: s.allPosts,
    accounts: s.parts.map((a) => ({ handle: a.handle, isPrivate: a.isPrivate, platform: a.platform || "tiktok" })) })),
    m.tasks, m.now);
  st.byHandle = new Map(st.rows.map((r) => [r.handle, r]));
  st.inCampaign = st.day >= m.cfg.campaign.start && st.day <= m.cfg.campaign.end && !m.final;
  return st;
}

// "Actie nodig": what the teacher should look at now, each line linking to the student.
function renderActions(m) {
  const box = $("ov-actions");
  const groups = [];
  const today = todayOf(m);
  if (today.inCampaign && (!today.offDay || today.task)) {
    const todo = m.students.filter((s) => { const r = today.byHandle.get(s.handle); return r && !r.done && !r.private; }).sort(byName);
    if (todo.length) {
      groups.push({ title: today.task ? `Dagopdracht vandaag nog niet gehaald (minimaal ${today.task.min})` : "Nog niet gepost vandaag",
        more: `<a href="#vandaag">Naar Vandaag →</a>`,
        items: todo.map((s) => studentLink(s, today.task ? ` <span class="chip-n">${today.byHandle.get(s.handle).count}/${today.task.min}</span>` : "")) });
    }
  }
  const pick = (kind) => m.students.filter((s) => s.warnings.some((w) => w.kind === kind)).sort(byName);
  for (const [kind, title] of [["private", "Privé"], ["notfound", "Niet gevonden"]]) {
    const list = pick(kind);
    if (list.length) groups.push({ title, items: list.map((s) => studentLink(s)) });
  }
  const missedTasks = m.students.filter((s) => s.stats.tasksMissed).sort(byName);
  if (missedTasks.length) {
    groups.push({ title: "Dagopdracht niet gehaald", items: missedTasks.map((s) => studentLink(s,
      ` <span class="chip-n">${s.stats.tasks.filter((t) => t.status === "missed").map((t) => `${shortDay(t.date)}: ${t.count}/${t.min}`).join(", ")}</span>`)) });
  }
  box.innerHTML = groups.length
    ? `<h2>Actie nodig</h2>${groups.map((g) => `<div class="action-group"><h3>${esc(g.title)} <span class="meta">(${g.items.length})</span>${g.more ? ` <span class="meta">${g.more}</span>` : ""}</h3>
        <div class="chips">${g.items.join("")}</div></div>`).join("")}`
    : `<h2>Actie nodig</h2><p class="meta">Niets: iedereen is bij. 🎉</p>`;
}

// ---------- Leerlingen ----------

const heatClass = (n) => (n >= 3 ? "p3" : n === 2 ? "p2" : n === 1 ? "p1" : "");

function dayCellClass(s, day, today, cfg) {
  const n = s.stats.perDay.get(day) || 0;
  const off = s.stats.isOff(day);
  const task = s.stats.tasks.find((t) => t.date === day);
  const taskCls = task ? (task.status === "missed" ? " task task-miss" : " task") : "";
  if (day > today) return (off ? "future off" : "future") + taskCls;
  return [n ? heatClass(n) : off ? "off" : day < today ? "miss" : "", day === today ? "today" : ""].filter(Boolean).join(" ") + taskCls;
}

// Cell text: number of posts (2+), or "posts/minimum" on a dagopdracht day.
function dayCellText(s, day, today, always = false) {
  const n = s.stats.perDay.get(day) || 0;
  const task = s.stats.tasks.find((t) => t.date === day);
  if (task) return day > today ? `/${task.min}` : `${n}/${task.min}`;
  return day > today ? "" : always || n > 1 ? String(n) : "";
}

// Title text of a calendar cell: date, number of posts (with the platforms when the student has Instagram too),
// a dagopdracht and, on a free day, why it is free.
function dayTitle(cfg, day, n, task = null, on = null, stats = null) {
  const free = stats ? stats.offName(day) : lib.offDayName(cfg, day);
  const split = on && n ? ` (${[on.tiktok && `${on.tiktok} op TikTok`, on.instagram && `${on.instagram} op Instagram`].filter(Boolean).join(", ")})` : "";
  return `${dayLabel(day)}: ${n} post${n === 1 ? "" : "s"}${split}${free ? ` (vrij: ${free})` : ""}`
    + (task ? ` · dagopdracht: minimaal ${task.min}${task.label ? ` (${task.label})` : ""}` : "");
}

// "Vrij: weekenden, Herfstvakantie 19 okt – 23 okt" for the legend.
function offDaysText(cfg) {
  const parts = [];
  if (cfg.offDays?.weekends) parts.push("weekenden");
  for (const p of cfg.offDays?.periods || []) {
    const d = (x) => shortDate.format(Date.parse(x + "T00:00:00Z"));
    parts.push(p.from === p.to ? `${esc(p.name)} ${d(p.from)}` : `${esc(p.name)} ${d(p.from)} – ${d(p.to)}`);
  }
  return parts.join(", ");
}

function renderStudents(m) {
  if (state.detail) return renderStudent(m, state.detail);
  const days = lib.campaignDays(m.cfg);
  const today = lib.localDay(m.now);
  const list = [...m.students].sort(byName);
  const head = days.map((d, i) => {
    const date = new Date(d + "T00:00:00Z");
    const monday = date.getUTCDay() === 1;
    return `<th class="${monday && i ? "wk" : ""}" title="${dayLabel(d)}">${date.getUTCDate()}</th>`;
  }).join("");
  $("ll-content").innerHTML = `
    <div class="legend-row">
      <span><span class="sw p1"></span>1 post</span><span><span class="sw p2"></span>2</span><span><span class="sw p3"></span>3+</span>
      <span><span class="sw miss"></span>gemist</span><span><span class="sw off"></span>vrij</span><span><span class="sw future"></span>nog niet</span>
      <span>Een post op TikTok of Instagram telt. Stories worden niet meegeteld.</span>
      ${m.tasks.length ? `<span><span class="sw task-miss"></span>dagopdracht niet gehaald (posts/minimum)</span>` : ""}
      <span>Dagen volgens Nederlandse tijd. Vandaag telt nog niet als gemist.</span>
      ${offDaysText(m.cfg) ? `<span>Vrij (posten mag, hoeft niet; telt wel mee voor de reeks, overslaan breekt de reeks niet): ${offDaysText(m.cfg)}.</span>` : ""}
    </div>
    <div class="table-wrap">
      <table class="heat">
        <thead><tr><th class="name">Leerling</th>${head}<th class="num" title="Huidige reeks dagen achter elkaar">Reeks</th><th class="num">Gemist</th>
          ${m.tasks.length ? `<th class="num" title="Dagopdrachten niet gehaald">Opdr. niet gehaald</th>` : ""}<th class="num">Posts</th></tr></thead>
        <tbody>${list.map((s) => {
          // A student with two accounts: one row (a post on either account counts), plus a row per account when opened.
          const row = (x, sub) => `
          <tr class="link${sub ? " sub-row" : ""}" tabindex="0" data-handle="${esc(sub ? x.key : x.handle)}">
            <td class="name">${sub ? `<span class="sub-mark">↳</span> <span class="meta">${x.platform === "instagram" ? "Instagram " : ""}@${esc(x.handle)}</span>`
              : `${nameCell(s)}${accToggle(s)} <span class="meta" title="${esc(handlesText(s))}">${esc(handlesText(s))}</span>`}</td>
            ${days.map((d) => {
              const n = x.stats.perDay.get(d) || 0;
              return `<td class="day ${dayCellClass(x, d, today, m.cfg)}" title="${esc(dayTitle(m.cfg, d, n, m.taskByDay.get(d), !sub && x.ig ? x.stats.byDay.get(d) : null, x.stats))}">${dayCellText(x, d, today)}</td>`;
            }).join("")}
            <td class="num">${sub ? x.stats.streak : `<strong>${x.stats.streak}</strong>`}</td>
            <td class="num">${x.stats.missedDays}</td>
            ${m.tasks.length ? `<td class="num">${x.stats.tasksMissed}</td>` : ""}
            <td class="num">${x.stats.posts}</td>
          </tr>`;
          return row(s, false) + (state.open.has(s.handle) ? s.parts.map((a) => row(a, true)).join("") : "");
        }).join("")}
        </tbody>
      </table>
    </div>
    <p class="hint">Klik op een leerling voor de details. Weekgrenzen (maandag) hebben een lijntje.
      Meer dan één account (twee op TikTok, of TikTok en Instagram): een dag is blauw en telt voor de reeks als op één van de accounts gepost is; met <em>▸ 2 accounts</em> zie je ze apart.</p>`;
}

function renderStudent(m, handle) {
  const s = m.byHandle.get(handle);
  const box = $("ll-content");
  if (!s) {
    box.innerHTML = `<a class="back" href="#leerlingen">← Alle leerlingen</a><p>@${esc(handle)} wordt niet (meer) gevolgd.</p>`;
    return;
  }
  // Several accounts (two on TikTok, or TikTok and Instagram): all together (default), or one of them (dropdown;
  // opening the page via an account's own row selects that account).
  if (s.split && handle !== s.handle && state.account === null) state.account = handle;
  const v = (s.split && s.parts.find((a) => a.key === state.account)) || s;
  const st = v.stats;
  const ig = s.ig;
  const onIg = v.platform === "instagram";                      // the page shows the Instagram account alone
  const showTT = !onIg && (v !== s || s.accounts.length > 0);   // TikTok numbers exist for what is shown
  const showIg = Boolean(ig) && (onIg || v === s);
  const tt = (label) => (ig ? `${label} (TikTok)` : label);
  const today = lib.localDay(m.now);
  const tile = (label, value, sub = "") => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  // Week calendar (Mon-Sun) over the campaign.
  const days = lib.campaignDays(m.cfg);
  const lead = (new Date(days[0] + "T00:00:00Z").getUTCDay() + 6) % 7;
  const cells = [...Array(lead).fill(`<div class="d out"></div>`), ...days.map((d) => {
    const n = st.perDay.get(d) || 0;
    return `<div class="d ${dayCellClass(v, d, today, m.cfg)}" title="${esc(dayTitle(m.cfg, d, n, m.taskByDay.get(d), v === s && ig ? st.byDay.get(d) : null, st))}">${shortDate.format(Date.parse(d + "T00:00:00Z"))}<b>${dayCellText(v, d, today, true)}</b></div>`;
  })];
  const newest = (a, b) => (lib.parseTs(b.created_at) || 0) - (lib.parseTs(a.created_at) || 0);
  const posts = showTT ? [...v.posts].sort(newest) : [];
  const igList = showIg ? [...ig.posts].sort(newest) : [];
  const postsLine = `op ${st.daysPosted} dag${st.daysPosted === 1 ? "" : "en"}${v === s && ig && s.accounts.length ? ` · TikTok ${st.tiktokPosts}, Instagram ${st.instagramPosts}` : ""}`;
  const igSince = ig && ig.baseline && ig.gained != null ? `${signed(ig.gained)} sinds ${shortDay(lib.localDay(ig.baseline.t))}` : "";
  const partName = (a) => (a.platform === "instagram" ? `Instagram @${esc(a.handle)}` : `${ig ? "TikTok " : ""}@${esc(a.handle)}`);
  box.innerHTML = `
    <a class="back" href="#leerlingen">← Alle leerlingen</a>
    <div class="detail-head">
      <h2>${nameCell(s)}</h2>
      ${s.handles.map((h) => `<a href="${tiktok(h)}" target="_blank" rel="noopener">@${esc(h)} op TikTok ↗</a>`).join("")}
      ${s.instagram ? `<a href="${instagram(s.instagram)}" target="_blank" rel="noopener">@${esc(s.instagram)} op Instagram ↗</a>` : ""}
      ${badges(s.warnings)}
    </div>
    ${s.split ? `<div class="controls"><label class="acc-select">Cijfers van <select id="st-account">
      <option value="">${ig ? "alle accounts samen (TikTok en Instagram)" : "beide accounts samen"}</option>${s.parts.map((a) => `<option value="${esc(a.key)}"${v === a ? " selected" : ""}>alleen ${partName(a)}</option>`).join("")}
    </select></label>${v !== s ? `<span class="meta">Positie en waarschuwingen gelden voor de leerling (alle accounts samen).</span>` : ""}</div>` : ""}
    ${s.warnings.some((w) => w.detail) ? warnDetails(s) : ""}
    <div class="tiles">
      ${showTT ? tile("Positie", s.rank, `van ${m.students.length}`) : ""}
      ${showTT ? tile(tt("Weergaven"), fmt(v.views), v.gain == null ? "" : `${signed(v.gain)} in 24 uur`) : ""}
      ${tile("Posts", fmt(st.posts), postsLine)}
      ${tile("Gemiste dagen", fmt(st.missedDays), "tot en met gisteren, zonder vrije dagen")}
      ${tile("Reeks", fmt(st.streak), `langste: ${st.longest}`)}
      ${st.tasks.length ? tile("Dagopdrachten", `${st.tasks.filter((t) => t.status === "reached").length}/${st.tasks.filter((t) => t.status !== "pending").length}`,
        st.tasksMissed ? `niet gehaald: ${st.tasks.filter((t) => t.status === "missed").map((t) => `${shortDay(t.date)} (${t.count}/${t.min})`).join(", ")}` : "gehaald") : ""}
      ${showTT ? tile("Gem. weergaven/post", fmt(st.avgViews)) : ""}
      ${showTT ? tile("Mediaan per video", fmt(st.medianViews), "de gewone video; één virale video telt nauwelijks mee") : ""}
      ${showTT ? tile("Engagement", st.engagement == null ? "–" : pct.format(st.engagement), "(likes + reacties + gedeeld) / weergaven") : ""}
      ${showTT ? tile(tt("Volgers"), fmt(v.followers), v === s && s.multi ? "beide accounts opgeteld" : "") : ""}
      ${showIg ? tile("Volgers (Instagram)", fmt(ig.followers), igSince) : ""}
      ${showTT ? tile("Beste video", st.best ? `<a href="${tiktok(st.best.handle || s.handle, st.best.id)}" target="_blank" rel="noopener">${fmt(st.best.views)} ↗</a>` : "–",
        st.best ? `geplaatst ${stampFmt.format(st.best.created)}${s.multi ? ` op @${esc(st.best.handle)}` : ""}` : "") : ""}
    </div>
    <div class="grid2">
      <div class="card">
        <h3 style="margin-top:0">Kalender</h3>
        <div class="cal">${["ma", "di", "wo", "do", "vr", "za", "zo"].map((d) => `<div class="dow">${d}</div>`).join("")}${cells.join("")}</div>
        ${st.missedList.length ? `<p class="hint">Gemist: ${st.missedList.map((d) => shortDate.format(Date.parse(d + "T00:00:00Z"))).join(", ")}</p>` : ""}
        ${ig ? `<p class="hint">Een post op TikTok of Instagram telt. Stories worden niet meegeteld.</p>` : ""}
      </div>
      <div class="card">
        <h3 style="margin-top:0">Hashtags</h3>
        <div class="chips">${st.tags.map(([t, n]) => `<span class="chip">#${esc(t)}<span class="chip-n">${n}×</span></span>`).join("") || `<span class="meta">Nog geen hashtags.</span>`}</div>
        ${showTT ? `<h3>Totaal</h3>
        <p class="meta">${fmt(st.likes)} likes · ${fmt(st.comments)} reacties · ${fmt(st.shares)} keer gedeeld${ig ? " (TikTok)" : ""}</p>` : ""}
      </div>
    </div>
    <div id="st-videos" class="card" hidden>
      <h3 style="margin-top:0">Weergaven per video</h3>
      <p class="hint" id="st-videos-note"></p>
      <div class="chart-box"><canvas id="st-videos-chart" aria-label="Weergaven per video over tijd"></canvas></div>
    </div>
    ${showTT ? `<h3>${ig ? "TikTok-posts" : "Posts"} in de campagne (${posts.length})</h3>
    <div class="table-wrap">
      <table class="board small">
        <thead><tr><th>Geplaatst</th><th class="num">Weergaven</th><th class="num">Likes</th><th class="num opt">Reacties</th><th class="num opt">Gedeeld</th><th class="num opt">Engagement</th><th>Hashtags</th><th></th></tr></thead>
        <tbody>${posts.map((p) => {
          const views = lib.toNum(p.views) || 0;
          const eng = views ? ((lib.toNum(p.likes) || 0) + (lib.toNum(p.comments) || 0) + (lib.toNum(p.shares) || 0)) / views : null;
          const t = lib.parseTs(p.created_at);
          const flags = [p.post_type && p.post_type !== "video" ? `<span class="badge info">${esc(p.post_type)}</span>` : "",
            lib.truthy(p.pinned) ? `<span class="badge info">📌 vastgezet</span>` : "",
            String(p.missing_since || "").trim() ? `<span class="badge warn" title="Sinds ${esc(p.missing_since)}">verdwenen</span>` : ""].join("");
          return `<tr>
            <td>${t ? stampFmt.format(t) : "–"} ${flags}</td>
            <td class="num strong">${fmt(lib.toNum(p.views))}</td>
            <td class="num">${fmt(lib.toNum(p.likes))}</td>
            <td class="num opt">${fmt(lib.toNum(p.comments))}</td>
            <td class="num opt">${fmt(lib.toNum(p.shares))}</td>
            <td class="num opt">${eng == null ? "–" : pct.format(eng)}</td>
            <td>${String(p.hashtags || "").split(/\s+/).filter(Boolean).map((x) => "#" + esc(x)).join(" ")}</td>
            <td>${s.multi && v === s ? `<span class="meta">@${esc(p.handle)}</span> ` : ""}<a href="${tiktok(p.handle, p.video_id)}" target="_blank" rel="noopener">open ↗</a></td>
          </tr>`;
        }).join("") || `<tr><td colspan="8">Nog geen posts gezien.</td></tr>`}</tbody>
      </table>
    </div>` : ""}
    ${showIg ? `<h3>Instagram-posts in de campagne (${igList.length})</h3>
    <div class="table-wrap">
      <table class="board small" id="st-ig-posts">
        <thead><tr><th>Geplaatst</th><th>Soort</th><th>Hashtags</th><th></th></tr></thead>
        <tbody>${igList.map((p) => {
          const t = lib.parseTs(p.created_at);
          return `<tr>
            <td>${t ? stampFmt.format(t) : "–"}</td>
            <td>${esc(IG_TYPE_NL[p.post_type] || p.post_type || "–")}</td>
            <td>${String(p.hashtags || "").split(/\s+/).filter(Boolean).map((x) => "#" + esc(x)).join(" ")}</td>
            <td><a href="${esc(instagramPost(p))}" target="_blank" rel="noopener">open ↗</a></td>
          </tr>`;
        }).join("") || `<tr><td colspan="4">Nog geen posts gezien.</td></tr>`}</tbody>
      </table>
    </div>
    <p class="hint">Instagram geeft alleen de posts zelf, geen likes, reacties of weergaven. Alleen posts vanaf ${esc(dayLabel(m.cfg.instagram?.startDate || m.cfg.campaign.start))} tellen mee. Stories worden niet meegeteld.</p>` : ""}`;
}

// ---------- Hashtags ----------

// "Zonder buiten schaal" (Stijgers, Hashtags): on by default as soon as an account is marked.
const hidingOutliers = (m) => m.outliers.size > 0 && (state.hideOutliers ?? true);
function outlierToggle(m, id) {
  const wrap = $(`${id}-wrap`);
  wrap.hidden = !m.outliers.size;
  $(id).checked = hidingOutliers(m);
  wrap.title = `Buiten schaal: ${[...m.outliers].map((h) => "@" + h).join(", ")}`;
}

function renderHashtags(m) {
  for (const b of $("tag-sort").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === state.tagSort));
  outlierToggle(m, "tag-out");
  const by = state.tagSort;
  const tags = hidingOutliers(m) ? lib.hashtagStats(new Map([...m.posts].filter(([h]) => !m.byHandle.get(h)?.isOutlier))) : m.tags;
  const rows = [...tags].sort((a, b) => b[by] - a[by] || (by === "posts" ? b.views - a.views : b.posts - a.posts) || a.tag.localeCompare(b.tag));
  $("tags-meta").textContent = `${rows.length} verschillende hashtags`;
  $("tags-body").innerHTML = rows.map((t, i) => {
    const open = state.tagOpen === t.tag;
    const users = [...t.accounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return `<tr class="link" tabindex="0" data-tag="${esc(t.tag)}" aria-expanded="${open}">
        <td class="num">${i + 1}</td><td class="handle">#${esc(t.tag)}</td>
        <td class="num${by === "posts" ? " strong" : ""}">${fmt(t.posts)}</td><td class="num">${fmt(t.accounts.size)}</td>
        <td class="num${by === "views" ? " strong" : ""}">${fmt(t.views)}</td><td class="num opt">${fmt(Math.round(t.views / t.posts))}</td>
      </tr>${open ? `<tr><td></td><td colspan="5"><div class="chips">${users.map(([h, n]) => {
        const s = m.byHandle.get(h);
        return `<a class="chip" href="#leerlingen/${encodeURIComponent(h)}">${s && s.name ? esc(s.name) + " · " : ""}@${esc(h)}<span class="chip-n">${n}×</span></a>`;
      }).join("")}</div></td></tr>` : ""}`;
  }).join("") || `<tr><td colspan="6">Nog geen hashtags gevonden.</td></tr>`;
}

// ---------- Beheer ----------

function renderAdmin(m) {
  renderFinaleCard(m);
  const raw = state.raw;
  const b = raw.budget;
  const cfg = m.cfg;
  $("bh-cool-min").textContent = cfg.forceMinMinutes;
  const lastRun = (t) => (t ? stampFmt.format(t) : "nog geen");
  $("bh-last").textContent = raw.budget.byPlatform.instagram.accounts
    ? `TikTok ${lastRun(raw.lastProfilesRun)} · Instagram ${lastRun(raw.lastInstagramRun)}` : lastRun(raw.lastProfilesRun);
  const usedPct = Math.min(100, (b.used / b.cap) * 100);
  const resPct = Math.min(100 - usedPct, (b.reserved / b.cap) * 100);
  $("bh-budget").innerHTML = `
    <p><strong>${fmt(b.used)}</strong> van <strong>${fmt(b.cap)}</strong> records gebruikt (${pct.format(b.used / b.cap)}).</p>
    <div class="bar" role="img" aria-label="Budget: ${fmt(b.used)} gebruikt, ${fmt(b.reserved)} nodig voor resterende profielruns, limiet ${fmt(b.cap)}">
      <span class="used" style="width:${usedPct}%"></span><span class="reserved" style="width:${resPct}%"></span>
    </div>
    <p class="meta">${["tiktok", "instagram"].map((pl) => `${PLATFORM_NL[pl]}: nog ${b.byPlatform[pl].runsLeft} geplande profielruns deze maand × ${b.byPlatform[pl].accounts} accounts ≈ ${fmt(b.byPlatform[pl].reserved)} records`).join("<br>")}<br>
      Verwacht totaal zonder weekrefreshes: <strong>${fmt(b.projected)}</strong> (${pct.format(b.projected / b.cap)} van de limiet). Beide platforms tellen mee voor dezelfde limiet.</p>
    <p class="meta">Weekrefresh (TikTok): max. ${cfg.refreshNumOfPosts} posts per account (reserveert tot ${fmt(cfg.refreshNumOfPosts * b.byPlatform.tiktok.accounts)} records vooraf).</p>`;
  const s = cfg.schedule;
  const platformLine = (pl) => {
    const w = s.windows[pl];
    return `<li>${PLATFORM_NL[pl]}: ${w.length ? `<strong>${w.length}× per dag</strong>, ${FREQ_NL[cfg.frequency[pl]] || cfg.frequency[pl]}: ${w.map((x) => x.start).join(", ")}
      (elk tijdvak ${w[0].start}–${w[0].end}, enz.; 1 run per tijdvak)` : "<strong>uit</strong>: geen geplande runs"}</li>`;
  };
  $("bh-schedule").innerHTML = `<ul class="issues">
    ${platformLine("tiktok")}${platformLine("instagram")}
    <li>Finale: elke ${cfg.finale.everyMinutes} minuten tot de deadline, maximaal ${cfg.finale.maxHours} uur (starten hierboven)</li>
    <li>Weekrefresh: ${esc(WEEKDAYS_NL[s.refresh.weekday] || s.refresh.weekday)} ${s.refresh.start}–${s.refresh.end}</li>
    <li>Geplande run overgeslagen als er &lt; ${s.skipRecentMinutes} min eerder al een profielrun van dat platform was</li>
    <li>Campagne: ${cfg.campaign.start} t/m ${cfg.campaign.end}; ophalen tot ${cfg.campaign.collectUntil}</li></ul>`;

  // All account rows (active and inactive).
  const q = state.accSearch.trim().toLowerCase().replace(/^@/, "");
  const accounts = raw.accounts.filter((a) => !q || (a.name || "").toLowerCase().includes(q) || (a.handle || a.rawHandle).toLowerCase().includes(q));
  $("acc-count").textContent = `(${raw.accounts.filter((a) => a.tracked).length} actief, ${raw.accounts.filter((a) => a.active === false).length} inactief)`;
  $("acc-body").innerHTML = accounts.map((a) => {
    const out = a.tracked && m.outliers.has(a.handle);
    const extra = a.tracked && a.group !== a.handle;
    const status = (a.issue ? `<span class="badge bad">${esc(a.issue)}</span>`
      : a.active ? `<span class="badge good">actief</span>` : `<span class="badge info">inactief</span>`)
      + (extra ? ` <span class="badge info" title="Telt samen met het eerste account">tweede account van @${esc(a.group)}</span>` : "")
      + (a.groupIssue ? ` <span class="badge warn" title="${esc(a.groupIssue)}">telt apart</span>` : "")
      + (out ? ` <span class="badge info">buiten schaal</span>` : "");
    // "+ account": a second account for this student (only on a tracked first account).
    const add = a.tracked && !extra && !a.main ? `<button type="button" class="btn small" data-add-for="${esc(a.handle)}"
      title="Tweede TikTok-account van deze leerling toevoegen; de weergaven tellen samen">+ account</button>` : "";
    const scale = a.tracked ? `<button type="button" class="btn small" data-outlier="${esc(a.handle)}" data-on="${!out}"
      title="${out ? "Weer meetellen in de schaal van de grafieken" : "Uit de schaal van de grafieken halen (plaats en cijfers blijven gelijk)"}">${out ? "In schaal" : "Buiten schaal"}</button>` : "";
    // A row is identified by its TikTok handle, or (a student with only Instagram) by its Instagram handle.
    const key = a.handle ? `data-handle="${esc(a.handle)}"` : a.instagram ? `data-instagram="${esc(a.instagram)}"` : "";
    const btn = !key ? "" : a.active
      ? `<button type="button" class="btn small" data-row="${a.row}" ${key} data-active="false">Deactiveren</button>`
      : a.active === false ? `<button type="button" class="btn small" data-row="${a.row}" ${key} data-active="true">Activeren</button>` : "";
    // Instagram: one account per student, typed on the student's first row (not on a second TikTok account).
    const igBtn = !a.mainRaw && (a.handle || a.instagram) ? `<button type="button" class="btn small" data-ig-edit="${a.row}"
      title="${a.instagramRaw ? "Instagram-handle van deze leerling wijzigen of verwijderen" : "Instagram-handle van deze leerling toevoegen"}">${a.instagramRaw ? "Wijzig" : "+ Instagram"}</button>` : "";
    const igShown = a.instagramTracked ? `<a href="${instagram(a.instagram)}" target="_blank" rel="noopener">@${esc(a.instagram)}</a>`
      : a.instagramIssue ? `<span class="badge bad" title="${esc(a.instagramIssue)}">${esc(a.instagramRaw)}</span>`
      : a.instagram ? `<span class="meta">@${esc(a.instagram)}</span>` : igBtn ? "" : "–";
    const igCell = `${igShown} ${igBtn}`;
    return `<tr class="${a.active === false ? "inactive" : ""}${a.issue ? " issue-row" : ""}">
      <td class="num">${a.row}</td><td>${a.name ? esc(a.name) : `<mark class="unknown">onbekend</mark>`}</td>
      <td class="handle">${a.handle ? "@" + esc(a.handle) : esc(a.rawHandle) || (a.instagram ? `<span class="meta">alleen Instagram</span>` : "–")}</td>
      <td class="handle ig">${igCell}</td><td class="st">${status}</td><td class="buttons-cell">${btn} ${scale} ${add}</td></tr>
      ${state.igFor === a.row ? `<tr class="add-row"><td></td><td colspan="5">
        <form class="add-form" data-ig-form="${a.row}" data-was="${esc(a.instagram || "")}" autocomplete="off">
          <label>Instagram-handle van ${a.name ? esc(a.name) : "deze leerling"} <input name="instagram" value="${esc(a.instagramRaw)}" placeholder="@naam of instagram.com/naam"></label>
          <button type="submit" class="btn primary">Opslaan</button>
          ${a.instagramRaw ? `<button type="button" class="btn" data-ig-clear="${a.row}">Verwijderen</button>` : ""}
          <button type="button" class="btn" data-ig-cancel>Annuleren</button>
        </form>
        <p class="hint">Eén Instagram-account per leerling, los van de TikTok-handle. Mag in elke vorm: <code>@naam</code>, <code>naam</code> of een link naar het profiel. Leeg laten en opslaan (of Verwijderen) haalt hem weg; de rij blijft staan.</p></td></tr>` : ""}
      ${state.addFor === a.handle ? `<tr class="add-row"><td></td><td colspan="5">
        <form class="add-form" data-add-form="${esc(a.handle)}" autocomplete="off">
          <label>Tweede TikTok-account van ${a.name ? esc(a.name) : "deze leerling"} <input name="handle" required placeholder="@naam of tiktok.com/@naam"></label>
          <button type="submit" class="btn primary">Toevoegen</button>
          <button type="button" class="btn" data-add-cancel>Annuleren</button>
        </form>
        <p class="hint">Wordt apart opgehaald (1 record per run extra) en telt overal samen met @${esc(a.handle)}: weergaven, posts, reeks en
          kalender. Op de openbare site staan de twee handles dan samen in één rij (zonder naam).</p></td></tr>` : ""}`;
  }).join("") || `<tr><td colspan="6">Geen rijen.</td></tr>`;
  renderInstagramMissing(m);
  renderTasks(m);

  const issues = raw.accounts.filter((a) => a.issue);
  const unknown = raw.accounts.filter((a) => a.tracked && !a.name);
  $("acc-issues").innerHTML = [
    ...issues.map((a) => `<li>Rij ${a.row} (${a.name ? esc(a.name) : "geen naam"}): <strong>${esc(a.rawHandle || "–")}</strong> — ${esc(a.issue)}. Wordt niet gevolgd.</li>`),
    ...unknown.map((a) => `<li>Rij ${a.row}: @${esc(a.handle)} heeft geen naam (<mark class="unknown">onbekend</mark>).</li>`),
    ...raw.accounts.filter((a) => a.instagramIssue).map((a) => `<li>Rij ${a.row} (${a.name ? esc(a.name) : "geen naam"}): Instagram <strong>${esc(a.instagramRaw)}</strong> — ${esc(a.instagramIssue)}. Wordt niet gevolgd.</li>`),
    ...raw.accounts.filter((a) => a.groupIssue).map((a) => `<li>Rij ${a.row}: @${esc(a.handle)} — ${esc(a.groupIssue)} (kolom <code>main_account</code>).</li>`),
  ].join("") || `<li>Geen problemen gevonden.</li>`;

  $("run-body").innerHTML = raw.runLog.slice(0, 30).map((r) => {
    const t = lib.parseTs(r.timestamp);
    const st = String(r.status);
    const cls = st === "ok" ? "good" : st === "failed" ? "bad" : st === "refused" || st === "partial" ? "warn" : "info";
    const notes = String(r.notes || "");
    return `<tr>
      <td>${t ? stampFmt.format(t) : esc(r.timestamp)}</td><td>${esc(r.run_type)}${lib.truthy(r.dry_run) ? ' <span class="badge info">dry-run</span>' : ""}</td>
      <td class="opt">${esc(r.window)}</td><td><span class="badge ${cls}">${esc(st)}</span></td>
      <td class="num">${fmt(lib.toNum(r.actual_records))}<span class="meta"> / ${fmt(lib.toNum(r.expected_records))}</span></td>
      <td class="num opt">${fmt(lib.toNum(r.errors))}</td>
      <td>${notes ? `<details><summary>${esc(notes.slice(0, 60))}${notes.length > 60 ? "…" : ""}</summary><div class="notes">${esc(notes.replace(/ \| /g, "\n"))}</div></details>` : ""}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="7">Nog geen runs.</td></tr>`;

  $("act-body").innerHTML = raw.activity.slice(0, 40).map((a) => {
    const t = lib.parseTs(a.timestamp);
    return `<tr><td>${t ? stampFmt.format(t) : esc(a.timestamp)}</td><td>${esc(a.email)}</td><td>${esc(a.action)}</td><td>${esc(a.details)}</td></tr>`;
  }).join("") || `<tr><td colspan="4">Nog geen activiteit.</td></tr>`;
}

// ---------- Leerlingen zonder Instagram (Beheer) ----------

// Active students without a (valid) Instagram handle, each with a small form to fill it in.
function renderInstagramMissing(m) {
  const box = $("ig-missing");
  const focused = document.activeElement?.closest?.("form[data-ig-quick]")?.dataset.igQuick;
  const missing = m.students.filter((s) => !s.instagram).sort(byName);
  $("ig-count").textContent = `(${missing.length} van ${m.students.length})`;
  box.innerHTML = missing.map((s) => {
    const row = s.instagramRow;
    const draft = state.igDraft.has(row) ? state.igDraft.get(row) : s.igRaw || "";
    return `<li><form class="add-form" data-ig-quick="${row}" data-was="${esc(s.igCurrent || "")}" autocomplete="off">
      <span class="ig-who">${nameCell(s)} <span class="meta">${esc(handlesText(s))}</span></span>
      <input name="instagram" value="${esc(draft)}" placeholder="@naam of instagram.com/naam" aria-label="Instagram-handle van ${esc(s.name || "onbekend")}">
      <button type="submit" class="btn small primary">Opslaan</button>
      ${s.instagramIssue ? `<span class="badge bad" title="${esc(s.instagramIssue)}">${esc(s.instagramIssue)}</span>` : ""}
    </form></li>`;
  }).join("") || `<li class="meta">Alle actieve leerlingen hebben een Instagram-account.</li>`;
  if (focused) box.querySelector(`form[data-ig-quick="${focused}"] input`)?.focus();
}

async function saveInstagram(row, was, handle, button, msgId) {
  if (button) button.disabled = true;
  try {
    const res = await api("/api/accounts/instagram", { row, was, handle });
    state.igFor = null;
    state.igDraft.delete(row);
    flash(res.message, true, msgId);
    await load();
  } catch (err) {
    flash(err.message, false, msgId);
    if (button) button.disabled = false;
  }
}

// ---------- Dagopdrachten (Beheer) ----------

// <option>s for the campaign days, Dutch labels ("di 6 okt").
const dayOptions = (days, selected) => days.map((d) => `<option value="${d}"${d === selected ? " selected" : ""}>${esc(dayLabel(d))}</option>`).join("");

function renderTasks(m) {
  const tasks = m.tasks;
  const today = lib.localDay(Date.now());
  $("task-body").innerHTML = tasks.map((t) => {
    const judged = m.students.map((s) => s.stats.tasks.find((x) => x.date === t.date)).filter(Boolean);
    const missed = judged.filter((x) => x.status === "missed").length;
    const result = t.date < today ? `${judged.length - missed} gehaald, ${missed} niet` : t.date === today ? "vandaag" : "komt nog";
    return `<tr${state.taskEdit === t.row ? ' class="editing"' : ""}><td>${esc(dayLabel(t.date))}</td><td class="num">${t.min}</td><td>${esc(t.label) || "–"}</td>
      <td class="meta">${result}</td>
      <td class="buttons-cell"><button type="button" class="btn small" data-task-edit="${t.row}">Wijzig</button>
        <button type="button" class="btn small" data-task-remove="${t.row}">Verwijder</button></td></tr>`;
  }).join("") || `<tr><td colspan="5" class="meta">Nog geen dagopdrachten.</td></tr>`;
  const form = $("task-form");
  const editing = tasks.find((t) => t.row === state.taskEdit) || null;
  const key = `${editing ? editing.row : "new"}|${m.cfg.campaign.start}|${m.cfg.campaign.end}`;
  if (form.dataset.key !== key) {
    form.dataset.key = key;
    const days = lib.campaignDays(m.cfg);
    const def = editing ? editing.date : days.find((d) => d >= today && !m.taskByDay.has(d)) || days.at(-1);
    form.querySelector("[name=date]").innerHTML = dayOptions(days, def);
    form.querySelector("[name=min]").value = editing ? editing.min : 2;
    form.querySelector("[name=label]").value = editing ? editing.label : "";
    form.querySelector("button[type=submit]").textContent = editing ? "Opslaan" : "Toevoegen";
    $("task-cancel").hidden = !editing;
  }
}

async function taskAction(body) {
  const msg = $("task-msg");
  try {
    const res = await api("/api/tasks", body);
    state.taskEdit = null;
    $("task-form").dataset.key = "";
    msg.className = "status ok";
    msg.textContent = res.message;
    await load();
  } catch (err) {
    msg.className = "status err";
    msg.textContent = err.message;
  }
}

async function loadRuns() {
  const box = $("bh-runs");
  try {
    const { runs } = await api("/api/runs");
    const icon = (r) => (r.status !== "completed" ? "⏳" : r.conclusion === "success" ? "✅" : r.conclusion === "skipped" ? "⏭️" : "❌");
    box.innerHTML = runs.slice(0, 8).map((r) => `<li>${icon(r)} <a href="${esc(r.url)}" target="_blank" rel="noopener">${r.workflow === "force-refresh.yml" ? "Nu verversen" : "Collect"}</a>
      <span class="meta">${stampFmt.format(Date.parse(r.created))} · ${esc(r.event)} · ${esc(r.status === "completed" ? r.conclusion : r.status)}</span></li>`).join("")
      || `<li class="meta">Nog geen runs.</li>`;
  } catch (err) {
    box.innerHTML = `<li class="meta">Kon de runs niet ophalen: ${esc(err.message)}</li>`;
  }
}

// ---------- Finale (Beheer) ----------

// Amsterdam date + time <input> values for a moment.
function inputValues(ms) {
  return { date: lib.localDay(ms), time: lib.localTime(ms) };
}

// Accounts that are fetched on every finale run: TikTok and Instagram, one record each.
const finaleAccounts = () => state.raw.budget.byPlatform.tiktok.accounts + state.raw.budget.byPlatform.instagram.accounts;

function finaleEstimate(m, endMs) {
  const cfg = m.cfg.finale;
  const runs = lib.finaleRuns(Date.now(), endMs, cfg.everyMinutes);
  return { runs, accounts: finaleAccounts(), records: runs * finaleAccounts() };
}

function renderFinaleCard(m) {
  const f = state.raw.finale;
  const phase = f ? (Date.now() >= f.end ? "ended" : "live") : "none";
  const key = `${phase}|${f ? f.end : ""}|${finaleAccounts()}`;
  if (key === state.finaleCardKey) return tickFinale();
  state.finaleCardKey = key;
  const cfg = m.cfg.finale;
  const perHour = (60 / cfg.everyMinutes) * finaleAccounts();
  const cost = `Kost ≈ <strong>${fmt(perHour)} records per uur</strong> (${60 / cfg.everyMinutes} runs × ${finaleAccounts()} actieve accounts, TikTok en Instagram), in plaats van de gewone runs die dan vervallen.`;
  // Dutch day names and 24-hour selects (the browser's own date/time inputs follow its language: "02:00 AM").
  const deadlineForm = (label, defMs, id) => {
    const v = inputValues(defMs);
    const max = inputValues((f && phase === "live" ? f.start : Date.now()) + cfg.maxHours * 3600e3);
    const days = [];
    for (let d = lib.localDay(Date.now()); d <= max.date; d = lib.addDays(d, 1)) days.push(d);
    const [hh, mm] = v.time.split(":");
    const minutes = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));
    if (!minutes.includes(mm)) minutes.push(mm);
    const opts = (list, sel) => list.map((x) => `<option${x === sel ? " selected" : ""}>${x}</option>`).join("");
    return `<form class="add-form" id="${id}">
      <label>Deadline <select name="date">${dayOptions(days, v.date)}</select></label>
      <label>Tijd (24 uur) <span class="hm"><select name="hour" aria-label="Uur">${opts(Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")), hh)}</select>
        : <select name="minute" aria-label="Minuten">${opts(minutes.sort(), mm)}</select></span></label>
      <button type="submit" class="btn primary">${label}</button>
    </form>
    <p class="meta" id="${id}-estimate"></p>`;
  };
  const formTime = (form) => `${form.querySelector("[name=hour]").value}:${form.querySelector("[name=minute]").value}`;
  const quarter = (ms) => Math.ceil(ms / (15 * 60e3)) * 15 * 60e3;
  let html = `<h2>Finale</h2>
    <p>Voor de laatste les. Tijdens de finale worden de profielen <strong>elke ${cfg.everyMinutes} minuten</strong> opgehaald
      in plaats van de gewone runs. De presentatie (openbaar en hier) toont een <strong>aftelklok</strong> en <strong>LIVE</strong>-labels.
      Na de deadline tonen de sites en de presentatie de <strong>Eindstand</strong>: het podium en de stand, bevroren op de laatste meting
      vóór de deadline. De finale stopt vanzelf bij de deadline en duurt nooit langer dan ${cfg.maxHours} uur. De budgetlimiet blijft gelden.</p>
    <p class="meta">${cost}</p>`;
  if (phase === "live") {
    html += `<p class="status ok"><span class="live">LIVE</span> Finale loopt · nog <strong id="finale-left"></strong> tot ${hourFmt.format(f.end)}
        <span class="meta">(gestart ${stampFmt.format(f.start)}${f.startedBy ? ` door ${esc(f.startedBy)}` : ""})</span></p>
      ${deadlineForm("Deadline wijzigen", f.end, "finale-change")}
      <p class="buttons">
        <button type="button" class="btn" id="finale-stop">⏹ Stop finale nu (Eindstand)</button>
        <button type="button" class="btn" id="finale-cancel">✕ Annuleer finale (geen Eindstand)</button>
      </p>`;
  } else {
    if (phase === "ended") {
      html += `<p class="status">🏁 De laatste finale is afgelopen op ${stampFmt.format(f.end)}: de sites tonen de Eindstand.
        <button type="button" class="btn small" id="finale-cancel">Eindstand weghalen</button></p>`;
    }
    html += deadlineForm("▶ Start finale", quarter(Date.now() + 2 * 3600e3), "finale-start");
  }
  html += `<p class="status" id="finale-msg" role="status"></p>`;
  $("bh-finale").innerHTML = html;
  for (const id of ["finale-start", "finale-change"]) {
    const form = $(id);
    if (!form) continue;
    const update = () => {
      const t = lib.amsMs(form.querySelector("[name=date]").value, formTime(form));
      const est = finaleEstimate(m, t);
      $(`${id}-estimate`).textContent = Number.isFinite(t) && t > Date.now()
        ? `Tot ${stampFmt.format(t)}: ${est.runs} runs × ${est.accounts} accounts ≈ ${fmt(est.records)} records`
          + ` (budget: ${fmt(state.raw.budget.used)} van ${fmt(state.raw.budget.cap)} gebruikt).`
        : "Kies een moment in de toekomst.";
    };
    form.addEventListener("input", update);
    update();
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const deadline = `${form.querySelector("[name=date]").value}T${formTime(form)}`;
      const start = id === "finale-start";
      if (start && !confirm(`Finale starten tot ${dayLabel(deadline.slice(0, 10))} ${deadline.slice(11)}? Vanaf nu elke ${cfg.everyMinutes} minuten nieuwe cijfers.`)) return;
      finaleAction(start ? "/api/finale/start" : "/api/finale/deadline", { deadline });
    });
  }
  $("finale-stop")?.addEventListener("click", () => {
    if (confirm("Finale nu stoppen? De Eindstand wordt de stand van de laatste meting.")) finaleAction("/api/finale/stop", { mode: "stop" });
  });
  $("finale-cancel")?.addEventListener("click", () => {
    if (confirm("Finale annuleren? Er komt geen Eindstand; alles gaat weer gewoon verder.")) finaleAction("/api/finale/stop", { mode: "cancel" });
  });
  tickFinale();
}

async function finaleAction(path, body) {
  const msg = $("finale-msg");
  for (const b of $("bh-finale").querySelectorAll("button")) b.disabled = true;
  try {
    const res = await api(path, body);
    state.finaleCardKey = null;
    await load();
    $("finale-msg").className = "status ok";
    $("finale-msg").textContent = res.message;
  } catch (err) {
    msg.className = "status err";
    msg.textContent = err.message;
    for (const b of $("bh-finale").querySelectorAll("button")) b.disabled = false;
  }
}

// Banners: live finale / Eindstand in the header, and the reminder to start the finale.
function renderBanners(m) {
  const f = state.raw.finale;
  const banner = $("finale-banner");
  if (f && Date.now() < f.end) {
    banner.innerHTML = `<span class="live">LIVE</span> Finale · nog <strong id="finale-left-top"></strong> tot ${hourFmt.format(f.end)}`;
  } else if (f) {
    banner.innerHTML = `🏁 <strong>Eindstand</strong> · finale afgelopen op ${stampFmt.format(f.end)}`;
  }
  banner.hidden = !f;
  const end = m.cfg.campaign.end;
  const today = lib.localDay(Date.now());
  const remind = !state.raw.finaleHasRun && today <= end
    && today >= lib.addDays(end, -m.cfg.finale.remindDaysBeforeEnd);
  const r = $("reminder");
  r.hidden = !remind;
  if (remind) {
    r.innerHTML = `⏰ De campagne eindigt op ${longDate.format(Date.parse(end + "T00:00:00Z"))}. `
      + `Vergeet niet de finale te starten voor de laatste les. <a href="#beheer">Naar Beheer →</a>`;
  }
  const title = $("ov-final");
  title.hidden = !m.final;
  if (m.final) title.textContent = `🏁 Eindstand · laatste meting ${m.latest ? stampFmt.format(m.latest) : "–"}`;
  tickFinale();
}

// Countdown texts, every second.
function tickFinale() {
  const f = state.raw && state.raw.finale;
  if (!f) return;
  const left = countdown(f.end - Date.now());
  for (const id of ["finale-left", "finale-left-top"]) if ($(id)) $(id).textContent = left;
  if (Date.now() >= f.end && model && !model.final) load(); // deadline passed: rebuild as Eindstand
}
setInterval(tickFinale, 1000);

// ---------- Stijgers (per video) ----------

async function loadPostHistory() {
  if (state.postHistory && Date.now() - state.postHistory.fetched < 5 * 60 * 1000) return state.postHistory;
  const { rows } = await api("/api/post-history");
  const cutoff = model && model.final ? state.raw.finale.end : Infinity;
  const byVideo = new Map();
  for (const [id, t, views] of rows) {
    if (t > cutoff) continue;
    if (!byVideo.has(id)) byVideo.set(id, []);
    byVideo.get(id).push({ t, views });
  }
  for (const list of byVideo.values()) list.sort((a, b) => a.t - b.t);
  state.postHistory = { fetched: Date.now(), byVideo };
  return state.postHistory;
}

// Views gained in the `hours` before `ref`; posted inside that period counts from 0.
function videoGain(post, pts, hours, ref) {
  const from = ref - hours * 3600e3;
  pts = (pts || []).filter((p) => p.t <= ref);
  const current = Math.max(lib.toNum(post.views) || 0, pts.length ? pts.at(-1).views : 0);
  const created = lib.parseTs(post.created_at);
  if (created !== null && created >= from) return current;
  let base = null;
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i].t <= from + 15 * 60 * 1000) { base = pts[i]; break; }
  if (!base) base = pts[0];
  return base ? Math.max(0, current - base.views) : 0;
}

function renderRisers(m) {
  for (const b of $("vid-range").querySelectorAll("button")) b.setAttribute("aria-pressed", String(Number(b.dataset.v) === state.videoRange));
  const body = $("vid-body");
  if (!state.postHistory) {
    outlierToggle(m, "vid-out");
    body.innerHTML = `<tr><td colspan="6">Geschiedenis per video laden…</td></tr>`;
    loadPostHistory().then(() => state.view === "stijgers" && renderRisers(m))
      .catch((err) => { body.innerHTML = `<tr><td colspan="6">Kon niet laden: ${esc(err.message)}</td></tr>`; });
    return;
  }
  outlierToggle(m, "vid-out");
  const ref = m.latest || Date.now();
  const list = [];
  for (const [h, posts] of m.posts) {
    if (!m.byHandle.has(h) || (hidingOutliers(m) && m.byHandle.get(h).isOutlier)) continue;
    for (const p of posts) list.push({ s: m.byHandle.get(h), p, gain: videoGain(p, state.postHistory.byVideo.get(String(p.video_id)), state.videoRange, ref) });
  }
  const rows = list.filter((x) => x.gain > 0).sort((a, b) => b.gain - a.gain).slice(0, 30);
  $("vid-meta").textContent = `Weergaven erbij in de laatste ${state.videoRange} uur tot ${m.latest ? stampFmt.format(m.latest) : "nu"}`;
  body.innerHTML = rows.map((x, i) => {
    const t = lib.parseTs(x.p.created_at);
    return `<tr class="link" tabindex="0" data-handle="${esc(x.p.handle)}">
      <td class="num">${i + 1}</td><td>${nameCell(x.s)} <span class="meta">@${esc(x.p.handle)}</span></td>
      <td class="num strong">${signed(x.gain)}</td><td class="num opt">${fmt(lib.toNum(x.p.views))}</td>
      <td class="opt">${t ? stampFmt.format(t) : "–"}</td>
      <td><a href="${tiktok(x.p.handle, x.p.video_id)}" target="_blank" rel="noopener">open ↗</a></td></tr>`;
  }).join("") || `<tr><td colspan="6">Geen video's met nieuwe weergaven in deze periode.</td></tr>`;
}

let videoChart = null;
function renderStudentVideos(m, s) {
  const box = $("st-videos");
  if (!box || typeof Chart === "undefined") return;
  if (String(state.account || "").startsWith("instagram:")) return; // the Instagram account alone: no TikTok videos
  if (!state.postHistory) {
    loadPostHistory().then(() => state.view === "leerlingen" && m.byHandle.get(state.detail) === s && renderStudentVideos(m, s)).catch(() => {});
    return;
  }
  const ref = m.latest || Date.now();
  const shown = (s.multi && s.accounts.find((a) => a.key === state.account)) || s;
  const series = shown.posts.map((p) => ({ p, pts: (state.postHistory.byVideo.get(String(p.video_id)) || []).filter((x) => x.t <= ref) }))
    .filter((x) => x.pts.length);
  if (!series.length) return;
  const gains = series.map((x) => ({ ...x, gain: videoGain(x.p, x.pts, 24, ref) })).sort((a, b) => b.gain - a.gain);
  const top = gains[0].gain > 0 ? gains[0] : null;
  box.hidden = false;
  $("st-videos-note").innerHTML = top
    ? `🚀 Snelste stijger (24 uur): video van ${stampFmt.format(lib.parseTs(top.p.created_at))}, <strong>${signed(top.gain)}</strong>. <a href="${tiktok(top.p.handle, top.p.video_id)}" target="_blank" rel="noopener">open ↗</a>`
    : "Geen nieuwe weergaven in de laatste 24 uur.";
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const isTop = (x) => top && x.p.video_id === top.p.video_id;
  const datasets = gains.slice().reverse().map((x) => ({
    label: `Video ${stampFmt.format(lib.parseTs(x.p.created_at))}`,
    data: x.pts.map((q) => ({ x: q.t, y: q.views })),
    borderColor: isTop(x) ? css("--s2") : css("--other"), backgroundColor: isTop(x) ? css("--s2") : css("--other"),
    borderWidth: isTop(x) ? 3.5 : 1.5, pointRadius: 0, pointHitRadius: 8, tension: 0.15,
  }));
  if (videoChart) videoChart.destroy();
  videoChart = new Chart($("st-videos-chart"), {
    type: "line", data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        title: (items) => (items.length ? stampFmt.format(items[0].parsed.x) : ""),
        label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
      scales: {
        x: { type: "linear", ticks: { callback: (v) => shortDate.format(Date.parse(lib.localDay(v) + "T00:00:00Z")), maxRotation: 0, color: css("--text-2") }, grid: { color: css("--grid") } },
        y: { beginAtZero: true, ticks: { color: css("--text-2") }, grid: { color: css("--grid") } },
      },
    },
  });
}

// ---------- Vandaag ----------

function renderToday(m) {
  const st = todayOf(m);
  const raw = state.raw;
  const cool = m.cfg.todayCheck?.cooldownMinutes ?? 10;
  const day = longDate.format(Date.parse(st.day + "T00:00:00Z"));
  const post = (s) => {
    const list = s.allPosts.map((p) => ({ p, t: lib.parseTs(p.created_at) })).filter((x) => x.t !== null && lib.localDay(x.t) === st.day)
      .sort((a, b) => b.t - a.t);
    return list[0] || null;
  };
  // Where the latest post of today was made: the platform when the student has both, the account when they have two.
  const where = (s, p) => (p.platform === "instagram" ? " op Instagram" : s.ig ? ` op TikTok${s.multi ? " @" + esc(p.handle) : ""}` : s.multi ? ` op @${esc(p.handle)}` : "");
  const href = (p) => (p.platform === "instagram" ? instagramPost(p) : tiktok(p.handle, p.video_id));
  const sorted = [...m.students].sort(byName);
  const todo = sorted.filter((s) => { const r = st.byHandle.get(s.handle); return !r.done && !r.private; });
  const done = sorted.filter((s) => { const r = st.byHandle.get(s.handle); return r.done && !r.private; });
  const priv = sorted.filter((s) => st.byHandle.get(s.handle).private);
  const mark = (s) => {
    const r = st.byHandle.get(s.handle);
    return st.task ? `<span class="badge ${r.done ? "good" : "warn"}">${r.count}/${st.task.min}</span>` : r.done ? `<span class="tick" aria-label="gepost">✓</span>` : "";
  };
  const item = (s) => {
    const last = post(s);
    return `<li>${mark(s)} <a href="#leerlingen/${encodeURIComponent(s.handle)}">${nameCell(s)}</a> <span class="meta">${esc(handlesText(s))}</span>
      ${last ? `<span class="meta">· ${hourFmt.format(last.t)}${where(s, last.p)}</span> <a href="${esc(href(last.p))}" target="_blank" rel="noopener">open ↗</a>` : ""}</li>`;
  };
  $("td-title").textContent = `Vandaag, ${day}`;
  $("td-info").innerHTML = !st.inCampaign ? "Vandaag is geen campagnedag."
    : st.task ? `<strong>Dagopdracht:</strong> minimaal ${st.task.min} posts${st.task.label ? ` (${esc(st.task.label)})` : ""}. Klaar = ${st.task.min} posts vandaag.`
    : st.offDay ? `Vrije dag (${esc(lib.offDayName(m.cfg, st.day))}): posten hoeft vandaag niet.` : "Klaar = vandaag minstens één post (op TikTok of Instagram).";
  $("td-checked").textContent = m.igFetched
    ? `TikTok ${m.latest ? hourFmt.format(m.latest) : "nog niet"} · Instagram ${m.latestIg ? hourFmt.format(m.latestIg) : "nog niet"}`
    : m.latest ? hourFmt.format(m.latest) : "nog niet";
  $("td-sched").textContent = ["tiktok", "instagram"].map((pl) => `${PLATFORM_NL[pl]} ${FREQ_NL[m.cfg.frequency[pl]] || m.cfg.frequency[pl]}`).join(", ");
  $("td-todo-title").textContent = st.task ? `Nog niet klaar (minder dan ${st.task.min} posts)` : "Nog niet gepost";
  $("td-done-title").textContent = st.task ? "Klaar" : "Gepost";
  $("td-todo-n").textContent = todo.length;
  $("td-done-n").textContent = done.length;
  $("td-priv-n").textContent = priv.length;
  $("td-todo").innerHTML = todo.map(item).join("") || `<li class="meta">Iedereen is klaar.</li>`;
  $("td-done").innerHTML = done.map(item).join("") || `<li class="meta">Nog niemand.</li>`;
  $("td-priv").innerHTML = priv.map((s) => `<li><a href="#leerlingen/${encodeURIComponent(s.handle)}">${nameCell(s)}</a> <span class="meta">${esc(handlesText(s))}</span></li>`).join("")
    || `<li class="meta">Geen.</li>`;
  $("td-priv-card").hidden = !priv.length;
  // "Controleer nu": the cost before starting, the cooldown, and the run on its way.
  const n = lib.todayTargets(st).length;
  const next = raw.lastTodayCheck ? raw.lastTodayCheck + cool * 60e3 : 0;
  const btn = $("td-check");
  const waiting = Boolean(state.todayRun);
  btn.disabled = waiting || !n || Date.now() < next || !st.inCampaign;
  btn.textContent = waiting ? "⏳ Controle loopt…" : "🔎 Controleer nu";
  // What the check would fetch: one record per account, TikTok and Instagram.
  const split = lib.targetSplit(lib.todayTargets(st));
  const platforms = split.tiktok && split.instagram ? ` (${split.tiktok} TikTok, ${split.instagram} Instagram)` : split.instagram ? " (Instagram)" : "";
  $("td-cost").textContent = !st.inCampaign ? "" : !n ? "Niemand om te controleren."
    : Date.now() < next ? `${n} account${n === 1 ? "" : "s"}${platforms} · kan weer om ${hourFmt.format(next)} (${cool} min tussen controles)`
    : `${n} account${n === 1 ? "" : "s"}, ${n} record${n === 1 ? "" : "s"}${platforms}`;
}

// After "Controleer nu": wait for the collector run, then reload (it takes about 5-7 minutes).
async function pollTodayRun() {
  const run = state.todayRun;
  if (!run) return;
  try {
    const { runs } = await api("/api/runs");
    const mine = runs.filter((r) => r.workflow === "collect.yml" && Date.parse(r.created) >= run.startedAt - 60e3);
    if (mine.length && mine.every((r) => r.status === "completed")) {
      state.todayRun = null;
      await load();
      const ok = mine.every((r) => r.conclusion === "success");
      todayMsg(ok ? `Klaar (${hourFmt.format(Date.now())}): de lijsten zijn bijgewerkt.` : "De run is klaar maar niet gelukt; zie Beheer → Laatste runs.", ok);
      return;
    }
  } catch { /* try again next time */ }
  if (Date.now() - run.startedAt > 25 * 60e3) {
    state.todayRun = null;
    todayMsg("Dit duurt langer dan verwacht. Kijk bij Beheer → Laatste GitHub-runs.", false);
    if (model && state.view === "vandaag") renderToday(model);
    return;
  }
  setTimeout(pollTodayRun, 20000);
}

function todayMsg(text, ok = true) {
  const msg = $("td-msg");
  msg.className = "status " + (ok ? "ok" : "err");
  msg.textContent = text;
}

// ---------- Opvallend ----------

const SIGNAL_NAMES = { likes: "Likes per weergave", step: "Groei in één sprong", silent: "Geen reacties of shares", followers: "Volgers-sprong" };

function renderSignals(m) {
  const body = $("sig-body");
  const s = m.cfg.signals;
  if (!s) { body.innerHTML = `<tr><td colspan="4">Geen instellingen (signals in config.yaml).</td></tr>`; return; }
  if (!state.postHistory) {
    body.innerHTML = `<tr><td colspan="4">Geschiedenis per video laden…</td></tr>`;
    loadPostHistory().then(() => state.view === "opvallend" && renderSignals(m))
      .catch((err) => { body.innerHTML = `<tr><td colspan="4">Kon niet laden: ${esc(err.message)}</td></tr>`; });
    return;
  }
  const posts = [...m.posts].filter(([h]) => m.byHandle.has(h)).flatMap(([, list]) => list);
  const flags = lib.signals(s, posts, state.postHistory.byVideo, m.series);
  const order = Object.keys(SIGNAL_NAMES);
  flags.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (b.views || b.followers || 0) - (a.views || a.followers || 0));
  const p1 = new Intl.NumberFormat("nl-NL", { style: "percent", maximumFractionDigits: 2 });
  const numbers = (f) => ({
    likes: () => `${p1.format(f.ratio)} likes per weergave (${fmt(f.likes)} likes, ${fmt(f.views)} weergaven); klas: ${p1.format(f.median)}. ${f.high ? "Veel hoger" : "Veel lager"} dan normaal.`,
    step: () => `${pct.format(f.share)} van de weergaven in één stap: ${fmt(f.from.views)} → ${fmt(f.to.views)} tussen ${stampFmt.format(f.from.t)} en ${hourFmt.format(f.to.t)}; daarna in ${s.flatHours} uur nog maar ${signed(f.after)}.`,
    silent: () => `${fmt(f.views)} weergaven en ${fmt(f.likes)} likes, maar 0 reacties en 0 keer gedeeld.`,
    followers: () => `${signed(f.followers)} volgers tussen ${stampFmt.format(f.from)} en ${hourFmt.format(f.to)}, met maar ${signed(f.views)} weergaven erbij `
      + `(${fmt(Math.round(f.per))} weergaven per nieuwe volger${f.median ? `; klas: ${fmt(Math.round(f.median))}` : ""}).`,
  })[f.kind]();
  $("sig-meta").textContent = `${flags.length} ding${flags.length === 1 ? "" : "en"} om naar te kijken`;
  body.innerHTML = flags.map((f) => {
    const st = m.byHandle.get(f.handle);
    return `<tr>
      <td><strong>${SIGNAL_NAMES[f.kind]}</strong></td>
      <td><a href="#leerlingen/${encodeURIComponent(f.handle)}">${st ? nameCell(st) : ""}</a> <span class="meta">@${esc(f.handle)}</span></td>
      <td>${numbers(f)}</td>
      <td>${f.video ? `<a href="${tiktok(f.handle, f.video)}" target="_blank" rel="noopener">video ↗</a>` : `<a href="${tiktok(f.handle)}" target="_blank" rel="noopener">profiel ↗</a>`}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="4">Niets opvallends gevonden.</td></tr>`;
  $("sig-rules").innerHTML = `Drempels (in <code>config.yaml</code>, onder <code>signals</code>): alleen video's vanaf ${fmt(s.minViews)} weergaven;
    likes per weergave ${s.likeRatioFactor}× lager of hoger dan de mediaan van de klas; sprong = ${pct.format(s.stepShare)}+ van de weergaven binnen
    ${String(s.stepMaxHours).replace(".", ",")} uur en daarna ${s.flatHours} uur bijna niets (&lt; ${pct.format(s.flatShare)} van die sprong);
    ${fmt(s.zeroEngagementMinViews)}+ weergaven zonder reacties en shares; ${s.followerJumpMin}+ volgers tussen twee runs met ${s.followerJumpFactor}× minder
    weergaven per nieuwe volger dan de klas.`;
}

// ---------- Export ----------

// posts, dagen_met_post, gemiste_dagen, huidige_reeks, langste_reeks, laatste_post, hashtags and opdrachten_niet_gehaald count both
// platforms; weergaven, volgers, likes, reacties, gedeeld, engagement and beste_video are TikTok only (Instagram has none of these).
const EXPORT_HEADER = ["naam", "handle", "positie", "weergaven", "volgers", "posts", "dagen_met_post", "gemiste_dagen", "opdrachten_niet_gehaald",
  "huidige_reeks", "langste_reeks", "gem_weergaven_per_post", "mediaan_weergaven_per_video", "likes", "reacties", "gedeeld", "engagement_pct",
  "beste_video", "beste_video_weergaven", "laatste_post", "hashtags", "privé", "let_op",
  "tiktok_posts", "instagram_handle", "instagram_posts", "instagram_volgers", "instagram_volgers_sinds_start"];

function exportRows(m) {
  return [...m.students].sort(byName).map((s) => {
    const st = s.stats;
    return [s.name || "onbekend", s.handles.map((h) => "@" + h).join(", "), s.rank, s.views, s.followers, st.posts, st.daysPosted, st.missedDays, st.tasksMissed,
      st.streak, st.longest, st.avgViews, st.medianViews, st.likes, st.comments, st.shares,
      st.engagement == null ? null : Math.round(st.engagement * 1000) / 10,
      st.best ? tiktok(st.best.handle || s.handle, st.best.id) : "", st.best ? st.best.views : null, st.lastDay || "",
      st.tags.slice(0, 10).map(([t]) => "#" + t).join(" "), s.isPrivate ? "ja" : "nee",
      s.warnings.map((w) => w.text).join("; "),
      st.tiktokPosts, s.ig ? "@" + s.ig.handle : "", s.ig ? st.instagramPosts : null, s.ig ? s.ig.followers : null, s.ig ? s.ig.gained : null];
  });
}

function renderExport(m) {
  for (const b of $("exp-format").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === state.format));
  $("exp-hint").textContent = state.format === "nl"
    ? "Excel (NL): puntkomma's en komma als decimaalteken; opent direct goed in Nederlandse Excel."
    : "Standaard CSV: komma's en punt als decimaalteken (Google Sheets, Numbers, Engelse Excel).";
  const rows = exportRows(m);
  $("exp-preview").innerHTML = `<thead><tr>${EXPORT_HEADER.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.slice(0, 5).map((r) => `<tr>${r.map((c) => `<td>${esc(c ?? "")}</td>`).join("")}</tr>`).join("")}
    ${rows.length > 5 ? `<tr><td colspan="${EXPORT_HEADER.length}" class="meta">… en nog ${rows.length - 5} rijen</td></tr>` : ""}</tbody>`;
}

async function download(m) {
  const nl = state.format === "nl";
  const csv = lib.toCsv(EXPORT_HEADER, exportRows(m), { sep: nl ? ";" : ",", decimalComma: nl });
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tiktok-campagne-cijfers-${lib.localDay(Date.now())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  api("/api/log", { action: "export", details: `${m.students.length} rijen, ${nl ? "Excel NL" : "standaard"}` }).catch(() => {});
}

// ---------- shell ----------

let model = null;

function render() {
  if (!model) return;
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.view === state.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${state.view}`;
  if (state.view === "overzicht") renderOverview(model);
  if (state.view === "leerlingen") renderStudents(model);
  if (state.view === "hashtags") renderHashtags(model);
  if (state.view === "beheer") renderAdmin(model);
  if (state.view === "export") renderExport(model);
  if (state.view === "stijgers") renderRisers(model);
  if (state.view === "vandaag") renderToday(model);
  if (state.view === "opvallend") renderSignals(model);
  if (state.view === "leerlingen" && state.detail && model.byHandle.has(state.detail)) {
    renderStudentVideos(model, model.byHandle.get(state.detail));
  }
  renderBanners(model);
}

function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ""));
  const [view, arg] = hash.split("/");
  const prev = state.view;
  state.view = ["overzicht", "vandaag", "leerlingen", "hashtags", "stijgers", "opvallend", "presentatie", "beheer", "export"].includes(view) ? view : "overzicht";
  state.detail = state.view === "leerlingen" && arg ? arg : null;
  state.account = null; // student page: back to "beide accounts samen" (or the account in the link)
  if (state.detail) window.scrollTo(0, 0);
  render();
  if (state.view === "beheer" && prev !== "beheer") loadRuns();
}

async function load() {
  try {
    state.raw = await api("/api/data");
    model = build(state.raw);
    $("error").hidden = true;
    $("me").textContent = `ingelogd als ${state.raw.me}`;
    $("updated").textContent = model.latest ? `Bijgewerkt: ${stampFmt.format(model.latest)}` : "Nog geen gegevens";
    render();
  } catch (err) {
    $("error").textContent = `Kon de gegevens niet laden: ${err.message}`;
    $("error").hidden = false;
  }
}

function openRow(ev, attr, go) {
  if (ev.type === "keydown" && ev.key !== "Enter") return;
  const tr = ev.target.closest(`tr[${attr}]`);
  if (tr && !ev.target.closest("a, button")) go(tr.getAttribute(attr));
}

$("ov-table").querySelector("thead").addEventListener("click", (ev) => {
  const th = ev.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (DEFAULT_DIR[key] || -1) };
  renderOverview(model);
});
// "▸ 2 accounts" (Overzicht, Leerlingen) shows the rows per account; the student page has a dropdown.
for (const id of ["ov-body", "ll-content"]) {
  $(id).addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-open]");
    if (!b) return;
    const key = b.dataset.open;
    if (state.open.has(key)) state.open.delete(key); else state.open.add(key);
    render();
  });
}
$("ll-content").addEventListener("change", (ev) => {
  if (ev.target.id !== "st-account") return;
  state.account = ev.target.value; // "" = both accounts (chosen), null = not chosen yet
  render();
});

// A warning badge in Overzicht opens its details under the row (instead of opening the student).
$("ov-body").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-warn]");
  if (!b) return;
  state.warnOpen = state.warnOpen === b.dataset.warn ? null : b.dataset.warn;
  renderOverview(model);
});
for (const id of ["tag-out", "vid-out"]) {
  $(id).addEventListener("change", (e) => { state.hideOutliers = e.target.checked; render(); });
}
$("td-check").addEventListener("click", async () => {
  const st = todayOf(model);
  const targets = lib.todayTargets(st);
  const n = targets.length;
  const split = lib.targetSplit(targets);
  const both = split.tiktok > 0 && split.instagram > 0;
  const platforms = both ? ` (${split.tiktok} TikTok, ${split.instagram} Instagram)` : split.instagram ? " (Instagram)" : "";
  if (!confirm(`Nu ${n} account${n === 1 ? "" : "s"}${platforms} controleren die vandaag nog niet ${st.task ? "klaar zijn" : "gepost hebben"}? `
    + `Kost ${n} record${n === 1 ? "" : "s"}. Het duurt ongeveer ${both ? "5–10" : "5–7"} minuten voordat de nieuwe cijfers er staan.`)) return;
  $("td-check").disabled = true;
  try {
    const res = await api("/api/today/check", {});
    state.todayRun = { startedAt: res.startedAt || Date.now(), count: res.count };
    todayMsg(res.message);
    await load();
    setTimeout(pollTodayRun, 30000);
  } catch (err) {
    todayMsg(err.message, false);
    renderToday(model);
  }
});
$("task-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.currentTarget;
  const editing = model.tasks.find((t) => t.row === state.taskEdit);
  taskAction({ action: editing ? "edit" : "add", row: editing?.row, was: editing?.date,
    date: f.querySelector("[name=date]").value, min: Number(f.querySelector("[name=min]").value), label: f.querySelector("[name=label]").value });
});
$("task-cancel").addEventListener("click", () => { state.taskEdit = null; renderTasks(model); });
$("task-body").addEventListener("click", (ev) => {
  const edit = ev.target.closest("button[data-task-edit]");
  const remove = ev.target.closest("button[data-task-remove]");
  if (edit) { state.taskEdit = Number(edit.dataset.taskEdit); renderTasks(model); $("task-form").scrollIntoView({ block: "nearest" }); }
  if (remove) {
    const t = model.tasks.find((x) => x.row === Number(remove.dataset.taskRemove));
    if (t && confirm(`Dagopdracht van ${dayLabel(t.date)} (minimaal ${t.min} posts) verwijderen?`)) taskAction({ action: "remove", row: t.row, was: t.date });
  }
});

for (const [id, attr, go] of [
  ["ov-body", "data-handle", (h) => { location.hash = "leerlingen/" + encodeURIComponent(h); }],
  ["ll-content", "data-handle", (h) => { location.hash = "leerlingen/" + encodeURIComponent(h); }],
  ["vid-body", "data-handle", (h) => { location.hash = "leerlingen/" + encodeURIComponent(h); }],
  ["tags-body", "data-tag", (t) => { state.tagOpen = state.tagOpen === t ? null : t; renderHashtags(model); }],
]) {
  $(id).addEventListener("click", (ev) => openRow(ev, attr, go));
  $(id).addEventListener("keydown", (ev) => openRow(ev, attr, go));
}
$("ov-search").addEventListener("input", (e) => { state.search = e.target.value; renderOverview(model); });
$("ov-warn").addEventListener("change", (e) => { state.onlyWarn = e.target.checked; renderOverview(model); });
$("acc-search").addEventListener("input", (e) => { state.accSearch = e.target.value; renderAdmin(model); });
$("vid-range").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.videoRange = Number(b.dataset.v); renderRisers(model); } });
$("tag-sort").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.tagSort = b.dataset.v; renderHashtags(model); } });
$("exp-format").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.format = b.dataset.v; renderExport(model); } });
$("exp-download").addEventListener("click", () => model && download(model));

$("bh-refresh").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  const msg = $("bh-refresh-msg");
  btn.disabled = true;
  msg.className = "status";
  msg.textContent = "Bezig…";
  try {
    const res = await api("/api/refresh", {});
    msg.className = "status ok";
    msg.textContent = res.message;
    setTimeout(loadRuns, 4000);
  } catch (err) {
    msg.className = "status err";
    msg.textContent = err.message;
  } finally {
    setTimeout(() => { btn.disabled = false; }, 5000);
  }
});

// "+ account": open the form under that row, or close it.
$("acc-body").addEventListener("click", (ev) => {
  const open = ev.target.closest("button[data-add-for]");
  const cancel = ev.target.closest("button[data-add-cancel]");
  if (!open && !cancel) return;
  state.addFor = open && state.addFor !== open.dataset.addFor ? open.dataset.addFor : null;
  renderAdmin(model);
  if (state.addFor) $("acc-body").querySelector("[data-add-form] input").focus();
});
$("acc-body").addEventListener("submit", async (ev) => {
  const f = ev.target.closest("form[data-add-form]");
  if (!f) return;
  ev.preventDefault();
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const res = await api("/api/accounts", { handle: f.querySelector("[name=handle]").value, main: f.dataset.addForm, active: true });
    state.addFor = null;
    flash(res.message, true, "acc-msg");
    await load();
  } catch (err) {
    flash(err.message, false, "acc-msg");
    btn.disabled = false;
  }
});

$("acc-body").addEventListener("click", async (ev) => {
  const scale = ev.target.closest("button[data-outlier]");
  if (scale) {
    scale.disabled = true;
    try {
      const res = await api("/api/outliers", { handle: scale.dataset.outlier, on: scale.dataset.on === "true" });
      flash(res.message, true, "acc-msg");
      await load();
    } catch (err) {
      flash(err.message, false, "acc-msg");
      scale.disabled = false;
    }
    return;
  }
  const btn = ev.target.closest("button[data-row]");
  if (!btn) return;
  const active = btn.dataset.active === "true";
  const label = btn.dataset.handle ? `@${btn.dataset.handle}` : `Instagram @${btn.dataset.instagram}`;
  if (!active && !confirm(`${label} op inactief zetten? Het account wordt dan niet meer opgehaald. De rij blijft staan en kan altijd weer aan.`)) return;
  btn.disabled = true;
  try {
    const res = await api("/api/accounts/active", { row: Number(btn.dataset.row), handle: btn.dataset.handle, instagram: btn.dataset.instagram, active });
    flash(res.message, true, "acc-msg");
    await load();
  } catch (err) {
    flash(err.message, false, "acc-msg");
    btn.disabled = false;
  }
});

// Instagram handle forms: in the accounts table (change/clear) and in the "zonder Instagram" list (quick fill-in).
$("acc-body").addEventListener("click", (ev) => {
  const edit = ev.target.closest("button[data-ig-edit]");
  const cancel = ev.target.closest("button[data-ig-cancel]");
  const clear = ev.target.closest("button[data-ig-clear]");
  if (clear) {
    const f = clear.closest("form");
    saveInstagram(Number(clear.dataset.igClear), f.dataset.was, "", clear, "acc-msg");
  } else if (edit || cancel) {
    state.igFor = edit && state.igFor !== Number(edit.dataset.igEdit) ? Number(edit.dataset.igEdit) : null;
    renderAdmin(model);
    if (state.igFor) $("acc-body").querySelector("[data-ig-form] input").focus();
  }
});
$("acc-body").addEventListener("submit", (ev) => {
  const f = ev.target.closest("form[data-ig-form]");
  if (!f) return;
  ev.preventDefault();
  saveInstagram(Number(f.dataset.igForm), f.dataset.was, f.querySelector("[name=instagram]").value, f.querySelector("button[type=submit]"), "acc-msg");
});
$("ig-missing").addEventListener("input", (ev) => {
  const f = ev.target.closest("form[data-ig-quick]");
  if (f) state.igDraft.set(Number(f.dataset.igQuick), ev.target.value);
});
$("ig-missing").addEventListener("submit", (ev) => {
  const f = ev.target.closest("form[data-ig-quick]");
  if (!f) return;
  ev.preventDefault();
  saveInstagram(Number(f.dataset.igQuick), f.dataset.was, f.querySelector("[name=instagram]").value, f.querySelector("button[type=submit]"), "ig-msg");
});

const form = $("add-form");
const field = (n) => form.querySelector(`[name="${n}"]`);
function previewHandles() {
  const parts = [];
  let bad = false;
  for (const [name, label, normalize] of [["handle", "TikTok", lib.normalizeHandle], ["instagram", "Instagram", lib.normalizeInstagramHandle]]) {
    const v = field(name).value;
    if (!v.trim()) continue;
    const { handle, reason } = normalize(v);
    if (handle) parts.push(`${label} @${handle}`);
    else { bad = true; parts.push(`${label} kan niet: ${reason}`); }
  }
  const p = $("add-preview");
  p.className = "status" + (bad ? " err" : "");
  p.textContent = !parts.length ? "" : bad ? parts.join(" · ") : `Wordt opgeslagen als ${parts.join(" + ")}`;
}
field("handle").addEventListener("input", previewHandles);
field("instagram").addEventListener("input", previewHandles);
form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const res = await api("/api/accounts", { name: field("name").value, handle: field("handle").value, instagram: field("instagram").value, active: field("active").checked });
    form.reset();
    flash(res.message, true);
    await load();
  } catch (err) {
    flash(err.message, false);
  } finally {
    btn.disabled = false;
  }
});

function flash(text, ok, id = "add-preview") {
  const p = $(id);
  p.className = "status " + (ok ? "ok" : "err");
  p.textContent = text;
  if (state.view === "beheer") p.scrollIntoView({ block: "nearest" });
}

window.addEventListener("hashchange", route);
route();
load();
setInterval(load, 5 * 60 * 1000);
