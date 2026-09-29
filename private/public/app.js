// Private dashboard page. All data comes from the Worker API (/api/*) behind Cloudflare Access.
import * as lib from "./lib.js";

const WARN_DAYS = 2; // "no post for 2+ days"
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
const dayLabel = (d) => dateFmt.format(Date.parse(d + "T00:00:00Z"));
const tiktok = (h, id) => `https://www.tiktok.com/@${encodeURIComponent(h)}${id ? `/video/${encodeURIComponent(id)}` : ""}`;
const $ = (id) => document.getElementById(id);

const state = {
  raw: null, view: "overzicht", detail: null,
  sort: { key: "rank", dir: 1 }, search: "", onlyWarn: false,
  tagSort: "posts", tagOpen: null, accSearch: "", format: "nl",
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
  const handleInfo = new Map(raw.handles.map((h) => [String(h.handle), h]));
  const history = new Map();
  let latest = 0;
  for (const r of raw.history) {
    const t = lib.parseTs(r.timestamp);
    if (t === null) continue;
    const h = String(r.handle);
    if (!history.has(h)) history.set(h, []);
    history.get(h).push({ t, views: lib.toNum(r.total_views) ?? 0, followers: lib.toNum(r.followers),
      posts: lib.toNum(r.campaign_posts) ?? 0, likes: lib.toNum(r.campaign_likes) ?? 0 });
    latest = Math.max(latest, t);
  }
  for (const s of history.values()) s.sort((a, b) => a.t - b.t);
  const posts = new Map();
  for (const p of raw.posts) {
    const h = String(p.handle);
    if (!posts.has(h)) posts.set(h, []);
    posts.get(h).push(p);
  }
  const refDay = latest ? lib.localDay(latest) : null;
  const students = raw.accounts.filter((a) => a.tracked).map((a) => {
    const info = handleInfo.get(a.handle) || null;
    const series = history.get(a.handle) || [];
    const cur = series.at(-1) || null;
    let base = null;
    for (let i = series.length - 1; i >= 0; i--) if (lib.localDay(series[i].t) < refDay) { base = series[i]; break; }
    const stats = lib.studentStats(posts.get(a.handle) || [], cfg, now);
    const s = {
      ...a, info, cur, stats, posts: posts.get(a.handle) || [],
      views: cur ? cur.views : 0, gain: cur && base ? cur.views - base.views : null,
      followers: cur ? cur.followers : null,
      isPrivate: info ? lib.truthy(info.is_private) : false,
    };
    s.warnings = warnings(s, cfg, now);
    return s;
  });
  const sorted = [...students].sort((x, y) => y.views - x.views || x.handle.localeCompare(y.handle));
  sorted.forEach((s, i) => { s.rank = i > 0 && sorted[i - 1].views === s.views ? sorted[i - 1].rank : i + 1; });
  return { cfg, now, latest, students, posts, tags: lib.hashtagStats(posts), byHandle: new Map(students.map((s) => [s.handle, s])) };
}

function warnings(s, cfg, now) {
  const out = [];
  const status = String(s.info?.last_status ?? "");
  if (s.isPrivate) out.push({ cls: "bad", text: "privé" });
  if (status.startsWith("fout")) out.push({ cls: "bad", text: "niet gevonden", title: status });
  if (!s.info) out.push({ cls: "info", text: "nog niet opgehaald" });
  const today = lib.localDay(now);
  if (s.info && today <= cfg.campaign.end && s.stats.daysSinceLast !== null && s.stats.daysSinceLast >= WARN_DAYS) {
    out.push({ cls: "warn", text: s.stats.lastDay ? `${s.stats.daysSinceLast} dagen geen post` : "nog geen post" });
  }
  if (s.stats.missing) out.push({ cls: "warn", text: `${s.stats.missing} video${s.stats.missing > 1 ? "'s" : ""} verdwenen`,
    title: "Stond eerder in het profiel maar nu niet meer: verwijderd of verborgen?" });
  return out;
}

// Alphabetical by name (Dutch rules); students without a name ("onbekend") go last.
const byName = (a, b) => (!a.name - !b.name) || (a.name || "").localeCompare(b.name || "", "nl") || a.handle.localeCompare(b.handle);
const nameCell = (s) => (s.name ? esc(s.name) : `<mark class="unknown">onbekend</mark>`);
const badges = (list) => list.map((w) => `<span class="badge ${w.cls}"${w.title ? ` title="${esc(w.title)}"` : ""}>${esc(w.text)}</span>`).join("");

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
    + tile("Weergaven", fmt(all.reduce((n, s) => n + s.views, 0)))
    + tile("Posts", fmt(all.reduce((n, s) => n + s.stats.posts, 0)))
    + tile("Met waarschuwing", fmt(withWarn), withWarn ? "zie kolom Let op" : "alles in orde");

  const q = state.search.trim().toLowerCase().replace(/^@/, "");
  let rows = all.filter((s) => (!state.onlyWarn || s.warnings.length)
    && (!q || s.handle.includes(q) || (s.name || "onbekend").toLowerCase().includes(q)));
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
  $("ov-body").innerHTML = rows.map((s) => `
    <tr class="link${s.warnings.length ? "" : ""}" tabindex="0" data-handle="${esc(s.handle)}">
      <td class="num strong">${s.rank}</td>
      <td>${nameCell(s)}<span class="phone-only meta">@${esc(s.handle)}</span><span class="phone-only">${badges(s.warnings)}</span></td>
      <td class="handle wide-only">@${esc(s.handle)}</td>
      <td class="num strong">${fmt(s.views)}</td>
      <td class="num opt">${signed(s.gain)}</td>
      <td class="num opt">${fmt(s.followers)}</td>
      <td class="num">${fmt(s.stats.posts)}</td>
      <td class="num opt">${fmt(s.stats.likes)}</td>
      <td class="opt">${s.stats.lastDay ? dayLabel(s.stats.lastDay) : "–"}</td>
      <td class="wide-only">${badges(s.warnings)}</td>
    </tr>`).join("") || `<tr><td colspan="10">Geen leerlingen gevonden.</td></tr>`;
}

// ---------- Leerlingen ----------

const heatClass = (n) => (n >= 3 ? "p3" : n === 2 ? "p2" : n === 1 ? "p1" : "");

function dayCellClass(s, day, today) {
  const n = s.stats.perDay.get(day) || 0;
  if (day > today) return "future";
  return [n ? heatClass(n) : day < today ? "miss" : "", day === today ? "today" : ""].filter(Boolean).join(" ");
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
      <span><span class="sw miss"></span>gemist</span><span><span class="sw future"></span>nog niet</span>
      <span>Dagen volgens Nederlandse tijd. Vandaag telt nog niet als gemist.</span>
    </div>
    <div class="table-wrap">
      <table class="heat">
        <thead><tr><th class="name">Leerling</th>${head}<th class="num" title="Huidige reeks dagen achter elkaar">Reeks</th><th class="num">Gemist</th><th class="num">Posts</th></tr></thead>
        <tbody>${list.map((s) => `
          <tr class="link" tabindex="0" data-handle="${esc(s.handle)}">
            <td class="name">${nameCell(s)} <span class="meta">@${esc(s.handle)}</span></td>
            ${days.map((d) => {
              const n = s.stats.perDay.get(d) || 0;
              return `<td class="day ${dayCellClass(s, d, today)}" title="${dayLabel(d)}: ${n} post${n === 1 ? "" : "s"}">${n > 1 ? n : ""}</td>`;
            }).join("")}
            <td class="num"><strong>${s.stats.streak}</strong></td>
            <td class="num">${s.stats.missedDays}</td>
            <td class="num">${s.stats.posts}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="hint">Klik op een leerling voor de details. Weekgrenzen (maandag) hebben een lijntje.</p>`;
}

function renderStudent(m, handle) {
  const s = m.byHandle.get(handle);
  const box = $("ll-content");
  if (!s) {
    box.innerHTML = `<a class="back" href="#leerlingen">← Alle leerlingen</a><p>@${esc(handle)} wordt niet (meer) gevolgd.</p>`;
    return;
  }
  const st = s.stats;
  const today = lib.localDay(m.now);
  const tile = (label, value, sub = "") => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  // Week calendar (Mon-Sun) over the campaign.
  const days = lib.campaignDays(m.cfg);
  const lead = (new Date(days[0] + "T00:00:00Z").getUTCDay() + 6) % 7;
  const cells = [...Array(lead).fill(`<div class="d out"></div>`), ...days.map((d) => {
    const n = st.perDay.get(d) || 0;
    return `<div class="d ${dayCellClass(s, d, today)}" title="${dayLabel(d)}">${shortDate.format(Date.parse(d + "T00:00:00Z"))}<b>${d > today ? "" : n}</b></div>`;
  })];
  const posts = [...s.posts].sort((a, b) => (lib.parseTs(b.created_at) || 0) - (lib.parseTs(a.created_at) || 0));
  box.innerHTML = `
    <a class="back" href="#leerlingen">← Alle leerlingen</a>
    <div class="detail-head">
      <h2>${nameCell(s)}</h2>
      <a href="${tiktok(s.handle)}" target="_blank" rel="noopener">@${esc(s.handle)} op TikTok ↗</a>
      ${badges(s.warnings)}
    </div>
    <div class="tiles">
      ${tile("Positie", s.rank, `van ${m.students.length}`)}
      ${tile("Weergaven", fmt(s.views), s.gain == null ? "" : `${signed(s.gain)} sinds gisteren`)}
      ${tile("Posts", fmt(st.posts), `op ${st.daysPosted} dag${st.daysPosted === 1 ? "" : "en"}`)}
      ${tile("Gemiste dagen", fmt(st.missedDays), "tot en met gisteren")}
      ${tile("Reeks", fmt(st.streak), `langste: ${st.longest}`)}
      ${tile("Gem. weergaven/post", fmt(st.avgViews))}
      ${tile("Engagement", st.engagement == null ? "–" : pct.format(st.engagement), "(likes + reacties + gedeeld) / weergaven")}
      ${tile("Volgers", fmt(s.followers))}
      ${tile("Beste video", st.best ? `<a href="${tiktok(s.handle, st.best.id)}" target="_blank" rel="noopener">${fmt(st.best.views)} ↗</a>` : "–",
        st.best ? `geplaatst ${stampFmt.format(st.best.created)}` : "")}
    </div>
    <div class="grid2">
      <div class="card">
        <h3 style="margin-top:0">Kalender</h3>
        <div class="cal">${["ma", "di", "wo", "do", "vr", "za", "zo"].map((d) => `<div class="dow">${d}</div>`).join("")}${cells.join("")}</div>
        ${st.missedList.length ? `<p class="hint">Gemist: ${st.missedList.map((d) => shortDate.format(Date.parse(d + "T00:00:00Z"))).join(", ")}</p>` : ""}
      </div>
      <div class="card">
        <h3 style="margin-top:0">Hashtags</h3>
        <div class="chips">${st.tags.map(([t, n]) => `<span class="chip">#${esc(t)}<span class="chip-n">${n}×</span></span>`).join("") || `<span class="meta">Nog geen hashtags.</span>`}</div>
        <h3>Totaal</h3>
        <p class="meta">${fmt(st.likes)} likes · ${fmt(st.comments)} reacties · ${fmt(st.shares)} keer gedeeld</p>
      </div>
    </div>
    <h3>Posts in de campagne (${posts.length})</h3>
    <div class="table-wrap">
      <table class="board small">
        <thead><tr><th>Geplaatst</th><th class="num">Weergaven</th><th class="num">Likes</th><th class="num opt">Reacties</th><th class="num opt">Gedeeld</th><th class="num opt">Engagement</th><th>Hashtags</th><th></th></tr></thead>
        <tbody>${posts.map((p) => {
          const v = lib.toNum(p.views) || 0;
          const eng = v ? ((lib.toNum(p.likes) || 0) + (lib.toNum(p.comments) || 0) + (lib.toNum(p.shares) || 0)) / v : null;
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
            <td><a href="${tiktok(s.handle, p.video_id)}" target="_blank" rel="noopener">open ↗</a></td>
          </tr>`;
        }).join("") || `<tr><td colspan="8">Nog geen posts gezien.</td></tr>`}</tbody>
      </table>
    </div>`;
}

// ---------- Hashtags ----------

function renderHashtags(m) {
  for (const b of $("tag-sort").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === state.tagSort));
  const by = state.tagSort;
  const rows = [...m.tags].sort((a, b) => b[by] - a[by] || (by === "posts" ? b.views - a.views : b.posts - a.posts) || a.tag.localeCompare(b.tag));
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
  const raw = state.raw;
  const b = raw.budget;
  const cfg = m.cfg;
  $("bh-cool-min").textContent = cfg.forceMinMinutes;
  $("bh-last").textContent = raw.lastProfilesRun ? stampFmt.format(raw.lastProfilesRun) : "nog geen";
  const usedPct = Math.min(100, (b.used / b.cap) * 100);
  const resPct = Math.min(100 - usedPct, (b.reserved / b.cap) * 100);
  $("bh-budget").innerHTML = `
    <p><strong>${fmt(b.used)}</strong> van <strong>${fmt(b.cap)}</strong> records gebruikt (${pct.format(b.used / b.cap)}).</p>
    <div class="bar" role="img" aria-label="Budget: ${fmt(b.used)} gebruikt, ${fmt(b.reserved)} nodig voor resterende profielruns, limiet ${fmt(b.cap)}">
      <span class="used" style="width:${usedPct}%"></span><span class="reserved" style="width:${resPct}%"></span>
    </div>
    <p class="meta">Nog ${b.runsLeft} geplande profielruns deze maand × ${m.students.length} accounts ≈ ${fmt(b.reserved)} records.
      Verwacht totaal zonder weekrefreshes: <strong>${fmt(b.projected)}</strong> (${pct.format(b.projected / b.cap)} van de limiet).</p>
    <p class="meta">Weekrefresh: max. ${cfg.refreshNumOfPosts} posts per account (reserveert tot ${fmt(cfg.refreshNumOfPosts * m.students.length)} records vooraf).</p>`;
  const s = cfg.schedule;
  $("bh-schedule").innerHTML = `<ul class="issues">
    ${s.profileRuns.map((w) => `<li>Profielen <strong>${esc(w.name)}</strong>: ${w.start}–${w.end}</li>`).join("")}
    <li>Weekrefresh: ${esc(WEEKDAYS_NL[s.refresh.weekday] || s.refresh.weekday)} ${s.refresh.start}–${s.refresh.end}</li>
    <li>Geplande run overgeslagen als er &lt; ${s.skipRecentMinutes} min eerder al een profielrun was</li>
    <li>Campagne: ${cfg.campaign.start} t/m ${cfg.campaign.end}; ophalen tot ${cfg.campaign.collectUntil}</li></ul>`;

  // All account rows (active and inactive).
  const q = state.accSearch.trim().toLowerCase().replace(/^@/, "");
  const accounts = raw.accounts.filter((a) => !q || (a.name || "").toLowerCase().includes(q) || (a.handle || a.rawHandle).toLowerCase().includes(q));
  $("acc-count").textContent = `(${raw.accounts.filter((a) => a.tracked).length} actief, ${raw.accounts.filter((a) => a.active === false).length} inactief)`;
  $("acc-body").innerHTML = accounts.map((a) => {
    const status = a.issue ? `<span class="badge bad">${esc(a.issue)}</span>`
      : a.active ? `<span class="badge good">actief</span>` : `<span class="badge info">inactief</span>`;
    const btn = !a.handle ? "" : a.active
      ? `<button type="button" class="btn small" data-row="${a.row}" data-handle="${esc(a.handle)}" data-active="false">Deactiveren</button>`
      : a.active === false ? `<button type="button" class="btn small" data-row="${a.row}" data-handle="${esc(a.handle)}" data-active="true">Activeren</button>` : "";
    return `<tr class="${a.active === false ? "inactive" : ""}${a.issue ? " issue-row" : ""}">
      <td class="num">${a.row}</td><td>${a.name ? esc(a.name) : `<mark class="unknown">onbekend</mark>`}</td>
      <td class="handle">${a.handle ? "@" + esc(a.handle) : esc(a.rawHandle) || "–"}</td><td>${status}</td><td>${btn}</td></tr>`;
  }).join("") || `<tr><td colspan="5">Geen rijen.</td></tr>`;

  const issues = raw.accounts.filter((a) => a.issue);
  const unknown = raw.accounts.filter((a) => a.tracked && !a.name);
  $("acc-issues").innerHTML = [
    ...issues.map((a) => `<li>Rij ${a.row} (${a.name ? esc(a.name) : "geen naam"}): <strong>${esc(a.rawHandle || "–")}</strong> — ${esc(a.issue)}. Wordt niet gevolgd.</li>`),
    ...unknown.map((a) => `<li>Rij ${a.row}: @${esc(a.handle)} heeft geen naam (<mark class="unknown">onbekend</mark>).</li>`),
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

// ---------- Export ----------

const EXPORT_HEADER = ["naam", "handle", "positie", "weergaven", "volgers", "posts", "dagen_met_post", "gemiste_dagen",
  "huidige_reeks", "langste_reeks", "gem_weergaven_per_post", "likes", "reacties", "gedeeld", "engagement_pct",
  "beste_video", "beste_video_weergaven", "laatste_post", "hashtags", "privé", "let_op"];

function exportRows(m) {
  return [...m.students].sort(byName).map((s) => {
    const st = s.stats;
    return [s.name || "onbekend", "@" + s.handle, s.rank, s.views, s.followers, st.posts, st.daysPosted, st.missedDays,
      st.streak, st.longest, st.avgViews, st.likes, st.comments, st.shares,
      st.engagement == null ? null : Math.round(st.engagement * 1000) / 10,
      st.best ? tiktok(s.handle, st.best.id) : "", st.best ? st.best.views : null, st.lastDay || "",
      st.tags.slice(0, 10).map(([t]) => "#" + t).join(" "), s.isPrivate ? "ja" : "nee",
      s.warnings.map((w) => w.text).join("; ")];
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
}

function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ""));
  const [view, arg] = hash.split("/");
  const prev = state.view;
  state.view = ["overzicht", "leerlingen", "hashtags", "presentatie", "beheer", "export"].includes(view) ? view : "overzicht";
  state.detail = state.view === "leerlingen" && arg ? arg : null;
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
for (const [id, attr, go] of [
  ["ov-body", "data-handle", (h) => { location.hash = "leerlingen/" + encodeURIComponent(h); }],
  ["ll-content", "data-handle", (h) => { location.hash = "leerlingen/" + encodeURIComponent(h); }],
  ["tags-body", "data-tag", (t) => { state.tagOpen = state.tagOpen === t ? null : t; renderHashtags(model); }],
]) {
  $(id).addEventListener("click", (ev) => openRow(ev, attr, go));
  $(id).addEventListener("keydown", (ev) => openRow(ev, attr, go));
}
$("ov-search").addEventListener("input", (e) => { state.search = e.target.value; renderOverview(model); });
$("ov-warn").addEventListener("change", (e) => { state.onlyWarn = e.target.checked; renderOverview(model); });
$("acc-search").addEventListener("input", (e) => { state.accSearch = e.target.value; renderAdmin(model); });
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

$("acc-body").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-row]");
  if (!btn) return;
  const active = btn.dataset.active === "true";
  if (!active && !confirm(`@${btn.dataset.handle} op inactief zetten? Het account wordt dan niet meer opgehaald. De rij blijft staan en kan altijd weer aan.`)) return;
  btn.disabled = true;
  try {
    const res = await api("/api/accounts/active", { row: Number(btn.dataset.row), handle: btn.dataset.handle, active });
    flash(res.message, true);
    await load();
  } catch (err) {
    flash(err.message, false);
    btn.disabled = false;
  }
});

const form = $("add-form");
const field = (n) => form.querySelector(`[name="${n}"]`);
field("handle").addEventListener("input", () => {
  const v = field("handle").value;
  const { handle, reason } = lib.normalizeHandle(v);
  const p = $("add-preview");
  p.className = "status" + (v && !handle ? " err" : "");
  p.textContent = !v ? "" : handle ? `Wordt opgeslagen als @${handle}` : `Kan niet: ${reason}`;
});
form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const res = await api("/api/accounts", { name: field("name").value, handle: field("handle").value, active: field("active").checked });
    form.reset();
    flash(res.message, true);
    await load();
  } catch (err) {
    flash(err.message, false);
  } finally {
    btn.disabled = false;
  }
});

function flash(text, ok) {
  const p = $("add-preview");
  p.className = "status " + (ok ? "ok" : "err");
  p.textContent = text;
  if (state.view === "beheer" && !ok) p.scrollIntoView({ block: "nearest" });
}

window.addEventListener("hashchange", route);
route();
load();
setInterval(load, 5 * 60 * 1000);
