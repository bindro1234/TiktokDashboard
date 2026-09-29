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
const PERIODS = { day: "Per dag", week: "Per week" };
const TAG_SORTS = { posts: "Meest gebruikt", views: "Meeste weergaven" };
const TAGS_SHOWN = 30; // rows before "Toon alle"

const PARAMS = new URLSearchParams(location.search);
// Presentation mode (?present): classroom slideshow, see present.js.
const IS_PRESENT = PARAMS.has("present");
// Admin mode (?beheerder): shows a link to the "Nu verversen" workflow. It is only a link;
// GitHub itself checks that whoever starts the workflow has write access. Never in presentation mode.
const IS_ADMIN = PARAMS.has("beheerder") && !IS_PRESENT;

const state = {
  data: null,
  view: "stand",
  account: null,
  metric: "views",
  growthMetric: "views",
  period: "day",
  selected: [],          // handles, in the order they were picked
  slotOf: new Map(),     // handle -> colour slot 1..8; colour follows the account, not its rank
  showOthers: false,
  sort: { key: "views", dir: -1 }, // leaderboard sort; -1 = high to low
  tagSort: "posts",
  tagsAll: false,
  tagOpen: null,         // hashtag whose accounts are shown
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

function weekOf(dayKey) {
  const idx = Math.floor((dayMs(dayKey) - dayMs(CFG.campaignStart)) / 864e5 / 7);
  return Math.max(0, idx) + 1;
}
function weekLabel(n) {
  const start = dayMs(CFG.campaignStart) + (n - 1) * 7 * 864e5;
  return `Week ${n} (${shortDayFmt.format(start)})`;
}

// ---------- data loading ----------

async function fetchCsv(tab) {
  const base = (CFG.csvUrls && CFG.csvUrls[tab]) || CFG.csvUrl(tab);
  const url = base + (base.includes("?") ? "&" : "?") + "t=" + Date.now();
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Tabblad '${tab}' niet te laden (HTTP ${res.status}). Is de sheet gepubliceerd?`);
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error(`Tabblad '${tab}' gaf geen CSV terug. Is de sheet gepubliceerd?`);
  return Papa.parse(text, { header: true, skipEmptyLines: true }).data;
}

function build(handleRows, historyRows, postRows, labels = {}) {
  const accounts = handleRows
    .filter((r) => r.handle)
    .map((r) => {
      const handle = String(r.handle).trim();
      return { handle, label: labels[handle] || null, isPrivate: isTrue(r.is_private), status: r.last_status || "" };
    });
  const known = new Set(accounts.map((a) => a.handle));
  const series = new Map(accounts.map((a) => [a.handle, []]));
  let latest = 0;
  for (const r of historyRows) {
    const s = series.get(String(r.handle).trim());
    const t = Date.parse(r.timestamp);
    if (!s || !Number.isFinite(t)) continue;
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

  const posts = new Map(accounts.map((a) => [a.handle, []]));
  for (const r of postRows) {
    const h = String(r.handle).trim();
    if (!known.has(h)) continue;
    posts.get(h).push({
      id: String(r.video_id), created: Date.parse(r.created_at), views: toNum(r.views), likes: toNum(r.likes),
      comments: toNum(r.comments), shares: toNum(r.shares), type: r.post_type || "", pinned: isTrue(r.pinned),
      tags: String(r.hashtags || "").toLowerCase().split(/\s+/).filter(Boolean),
    });
  }
  return { accounts, series, posts, latest, labels, standings: standings(accounts, series, latest), tags: hashtagStats(posts) };
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

// Rank by total views; "+ since yesterday" compares with the last run of an earlier day.
function standings(accounts, series, latest) {
  const refDay = latest ? localDay(latest) : null;
  const rows = accounts.map((a) => {
    const s = series.get(a.handle);
    const cur = s.at(-1) || null;
    let base = null;
    for (let i = s.length - 1; i >= 0; i--) if (localDay(s[i].t) < refDay) { base = s[i]; break; }
    return { ...a, cur, base, views: cur ? cur.total_views : 0 };
  });
  const rankBy = (list, value) => {
    const sorted = [...list].sort((a, b) => value(b) - value(a) || a.handle.localeCompare(b.handle));
    const ranks = new Map();
    sorted.forEach((r, i) => ranks.set(r.handle, i > 0 && value(sorted[i - 1]) === value(r) ? ranks.get(sorted[i - 1].handle) : i + 1));
    return ranks;
  };
  const now = rankBy(rows, (r) => r.views);
  const before = rankBy(rows.filter((r) => r.base), (r) => r.base.total_views);
  for (const r of rows) {
    r.rank = now.get(r.handle);
    r.rankChange = before.has(r.handle) ? before.get(r.handle) - r.rank : null;
    r.gain = r.base ? r.views - r.base.total_views : null;
  }
  return rows.sort((a, b) => a.rank - b.rank || a.handle.localeCompare(b.handle));
}

async function load() {
  try {
    // The private dashboard supplies its own source (with names as labels); the public site reads the CSVs.
    const src = CFG.source
      ? await CFG.source()
      : await Promise.all([fetchCsv("handles"), fetchCsv("history"), fetchCsv("posts")])
        .then(([handles, history, posts]) => ({ handles, history, posts }));
    state.data = build(src.handles, src.history, src.posts, src.labels);
    if (IS_PRESENT) {
      Present.update(state.data);
      return;
    }
    document.getElementById("error").hidden = true;
    if (!state.selected.length) state.data.standings.slice(0, 5).forEach((r) => select(r.handle));
    const upd = state.data.latest ? `Bijgewerkt: ${stampFmt.format(state.data.latest)}` : "Nog geen gegevens";
    document.getElementById("updated").textContent = `${upd} · ${state.data.accounts.length} accounts`;
    if (IS_ADMIN) {
      document.getElementById("admin-last").textContent = state.data.latest ? stampFmt.format(state.data.latest) : "nog geen";
    }
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
  box.innerHTML = state.selected.map((h) =>
    `<button type="button" class="chip" aria-pressed="true" data-handle="${esc(h)}" title="Klik om te verbergen">` +
    `<span class="dot" style="background:${colorOf(h)}"></span>@${esc(h)}</button>`).join("")
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
    b.innerHTML = `<span class="dot"${on ? ` style="background:${colorOf(r.handle)}"` : ""}></span>@${esc(r.handle)}`;
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
        ticks: { color: text, callback: (v) => compact.format(v) },
        title: { display: !!yTitle, text: yTitle, color: text },
      },
    },
  };
}

function timeAxis(opts) {
  opts.scales.x.type = "linear";
  opts.scales.x.ticks.callback = (v) => shortDayFmt.format(dayMs(localDay(v)));
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
  const m = METRICS[state.metric];
  const datasets = [];
  if (state.showOthers) {
    for (const r of state.data.standings) {
      if (state.selected.includes(r.handle)) continue;
      const ds = lineDataset("@" + r.handle, points(r.handle, m.key), cssVar("--other"), false);
      ds.borderWidth = 1;
      ds.pointHoverRadius = 0;
      datasets.push(ds);
    }
  }
  for (const h of state.selected) datasets.push(lineDataset("@" + h, points(h, m.key), colorOf(h), true));
  drawChart("chart-main", { type: "line", data: { datasets }, options: timeAxis(baseOptions(m.label)), plugins: [endLabels] });
}

function points(handle, key) {
  return state.data.series.get(handle).filter((p) => p[key] != null).map((p) => ({ x: p.t, y: p[key] }));
}

// Gain per period: closing value of each period minus the previous close.
// Campaign counters (views, posts, likes) start at 0; followers skip their first period.
function gains(handle, key, period) {
  const closes = new Map();
  for (const p of state.data.series.get(handle)) {
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
  const m = METRICS[state.growthMetric];
  const perHandle = new Map(state.data.accounts.map((a) => [a.handle, gains(a.handle, m.key, state.period)]));
  const keys = [...new Set([...perHandle.values()].flatMap((g) => [...g.keys()]))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const labels = keys.map((k) => (state.period === "day" ? shortDayFmt.format(dayMs(k)) : weekLabel(k)));
  const isBar = state.period === "week";
  const datasets = state.selected.map((h) => {
    const g = perHandle.get(h);
    const ds = isBar
      ? { label: "@" + h, data: keys.map((k) => g.get(k) ?? null), backgroundColor: colorOf(h), borderRadius: 4,
          borderSkipped: "start", borderColor: cssVar("--surface"), borderWidth: 1, maxBarThickness: 36 }
      : lineDataset("@" + h, keys.map((k) => g.get(k) ?? null), colorOf(h), true);
    return ds;
  });
  const opts = baseOptions(`${m.label} erbij`);
  opts.scales.y.beginAtZero = true;
  if (!isBar) opts.spanGaps = true;
  drawChart("chart-growth", { type: isBar ? "bar" : "line", data: { labels, datasets }, options: opts, plugins: [endLabels] });

  // Ranked table for the latest period.
  const lastKey = keys.at(-1);
  const periodName = state.period === "day" ? (lastKey ? shortDayFmt.format(dayMs(lastKey)) : "") : (lastKey ? weekLabel(lastKey) : "");
  document.getElementById("growth-title").textContent = `Grootste stijgers · ${periodName}`;
  document.getElementById("growth-col").textContent = `${m.label} erbij`;
  const rows = state.data.standings
    .map((r) => ({ r, gain: perHandle.get(r.handle).get(lastKey) ?? 0, total: r.cur ? r.cur[m.key] : null }))
    .sort((a, b) => b.gain - a.gain || a.r.handle.localeCompare(b.r.handle));
  const body = document.getElementById("growth-body");
  body.innerHTML = rows.map((x, i) => `
    <tr tabindex="0" data-handle="${esc(x.r.handle)}">
      <td class="rank num">${i + 1}</td>
      <td class="handle">@${esc(x.r.handle)}${x.r.isPrivate ? privateBadge() : ""}</td>
      <td class="num views">${signed(x.gain)}</td>
      <td class="num opt">${fmt(x.total)}</td>
    </tr>`).join("");
}

// ---------- views ----------

const privateBadge = () => `<span class="badge private" title="Dit account staat op privé en kan niet worden gevolgd">🔒 privé</span>`;

function changeCell(r) {
  if (r.rankChange == null) return `<span class="new">nieuw</span>`;
  if (r.rankChange > 0) return `<span class="up" aria-label="${r.rankChange} plaatsen gestegen">▲ ${r.rankChange}</span>`;
  if (r.rankChange < 0) return `<span class="down" aria-label="${-r.rankChange} plaatsen gedaald">▼ ${-r.rankChange}</span>`;
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

function renderSortHeaders() {
  // On a phone the extra columns are hidden; the column being sorted on stays visible.
  document.getElementById("board").dataset.sorted = state.sort.key;
  document.getElementById("sort-select").value = state.sort.key;
  for (const th of document.querySelectorAll("#view-stand th[data-sort]")) {
    const on = th.dataset.sort === state.sort.key;
    if (on) th.setAttribute("aria-sort", state.sort.dir < 0 ? "descending" : "ascending");
    else th.removeAttribute("aria-sort");
    const btn = th.querySelector("button");
    btn.dataset.arrow = on ? (state.sort.dir < 0 ? "▼" : "▲") : "";
    btn.title = on ? "Klik om de volgorde om te draaien" : "Klik om hierop te sorteren";
  }
}

function renderBoard() {
  renderSortHeaders();
  const body = document.getElementById("board-body");
  const medal = { 1: "🥇", 2: "🥈", 3: "🥉" };
  body.innerHTML = sortedStandings().map((r) => `
    <tr tabindex="0" data-handle="${esc(r.handle)}" class="${r.rank <= 3 && r.views > 0 ? "top3" : ""}">
      <td class="rank num">${r.rank <= 3 && r.views > 0 ? medal[r.rank] : r.rank}</td>
      <td class="chg">${changeCell(r)}</td>
      <td class="handle">@${esc(r.handle)}${r.isPrivate ? privateBadge() : ""}</td>
      <td class="num views c-views">${fmt(r.views)}</td>
      <td class="num opt gain">${r.gain == null ? "–" : signed(r.gain)}</td>
      <td class="num opt2 c-followers">${fmt(r.cur ? r.cur.followers : null)}</td>
      <td class="num opt2 c-posts">${fmt(r.cur ? r.cur.campaign_posts : null)}</td>
      <td class="num opt2 c-likes">${fmt(r.cur ? r.cur.campaign_likes : null)}</td>
    </tr>`).join("") || `<tr><td colspan="8">Nog geen accounts.</td></tr>`;
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

function renderAccount(handle) {
  const el = document.getElementById("view-account");
  const r = state.data.standings.find((x) => x.handle === handle);
  if (!r) {
    el.innerHTML = `<a class="back" href="#stand">← Terug naar de stand</a><p>Account @${esc(handle)} niet gevonden.</p>`;
    return;
  }
  const c = r.cur || {};
  const posts = [...state.data.posts.get(handle)].sort((a, b) => b.created - a.created);
  const tile = (label, value, sub = "") => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  el.innerHTML = `
    <a class="back" href="#stand">← Terug naar de stand</a>
    <div class="detail-head">
      <h2>@${esc(handle)}</h2>${r.isPrivate ? privateBadge() : ""}
      <a href="https://www.tiktok.com/@${encodeURIComponent(handle)}" target="_blank" rel="noopener">Bekijk op TikTok ↗</a>
    </div>
    ${r.isPrivate ? `<p class="notice">Dit account staat op privé. Zet het op openbaar, anders tellen nieuwe weergaven niet mee.</p>` : ""}
    <div class="tiles">
      ${tile("Positie", r.rank, changeCell(r))}
      ${tile("Weergaven", fmt(r.views), r.gain == null ? "" : `${signed(r.gain)} sinds gisteren`)}
      ${tile("Volgers", fmt(c.followers))}
      ${tile("Posts", fmt(c.campaign_posts), "sinds start campagne")}
      ${tile("Likes", fmt(c.campaign_likes), "op campagneposts")}
      ${tile("Gem. weergaven/post", c.campaign_posts ? fmt(Math.round(r.views / c.campaign_posts)) : "–")}
    </div>
    <div class="grid2">
      <div><h3>Weergaven over tijd</h3><div class="chart-card short"><canvas id="chart-acc-views"></canvas></div></div>
      <div><h3>Volgers over tijd</h3><div class="chart-card short"><canvas id="chart-acc-followers"></canvas></div></div>
    </div>
    ${accountTags(posts)}
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
            <td><a href="https://www.tiktok.com/@${encodeURIComponent(handle)}/video/${esc(p.id)}" target="_blank" rel="noopener">open ↗</a></td>
          </tr>`).join("") || `<tr><td colspan="6">Nog geen posts gezien.</td></tr>`}
        </tbody>
      </table>
    </div>`;

  const accent = cssVar("--s1");
  const single = (id, key, label) =>
    drawChart(id, { type: "line", data: { datasets: [lineDataset(label, points(handle, key), accent, false)] }, options: timeAxis(baseOptions()) });
  single("chart-acc-views", "total_views", "Weergaven");
  single("chart-acc-followers", "followers", "Volgers");
  const g = gains(handle, "total_views", "day");
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

function render() {
  if (!state.data) return;
  for (const a of document.querySelectorAll(".tabs a")) {
    const active = a.dataset.view === state.view || (state.view === "account" && a.dataset.view === "stand");
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${state.view}`;
  if (state.view === "stand") renderBoard();
  if (state.view === "grafiek") {
    renderSeg("metric", METRICS);
    renderChips("chips-grafiek");
    renderMainChart();
  }
  if (state.view === "groei") {
    renderSeg("growthMetric", METRICS);
    renderSeg("period", PERIODS);
    renderChips("chips-groei");
    renderGrowth();
  }
  if (state.view === "hashtags") renderHashtags();
  if (state.view === "account") renderAccount(state.account);
}

function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (hash.startsWith("account/")) {
    state.view = "account";
    state.account = hash.slice(8);
    window.scrollTo(0, 0);
  } else {
    state.view = ["stand", "grafiek", "groei", "hashtags"].includes(hash) ? hash : "stand";
  }
  render();
}

function openAccount(ev) {
  if (ev.type === "keydown" && ev.key !== "Enter") return;
  const tr = ev.target.closest("tr[data-handle]");
  if (tr) location.hash = "account/" + encodeURIComponent(tr.dataset.handle);
}

document.getElementById("show-others").addEventListener("change", (e) => { state.showOthers = e.target.checked; render(); });
for (const id of ["board-body", "growth-body"]) {
  document.getElementById(id).addEventListener("click", openAccount);
  document.getElementById(id).addEventListener("keydown", openAccount);
}
document.querySelector("#view-stand thead").addEventListener("click", (ev) => {
  const th = ev.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : -1 };
  renderBoard();
});
document.getElementById("sort-select").addEventListener("change", (ev) => {
  state.sort = { key: ev.target.value, dir: -1 };
  renderBoard();
});
function toggleTag(ev) {
  if (ev.type === "keydown" && ev.key !== "Enter") return;
  const tr = ev.target.closest("tr[data-tag]");
  if (!tr) return;
  state.tagOpen = state.tagOpen === tr.dataset.tag ? null : tr.dataset.tag;
  renderHashtags();
  document.querySelector(`#tags-body tr[data-tag="${CSS.escape(tr.dataset.tag)}"]`)?.focus();
}
document.getElementById("tags-body").addEventListener("click", toggleTag);
document.getElementById("tags-body").addEventListener("keydown", toggleTag);
document.getElementById("tags-more").addEventListener("click", () => { state.tagsAll = !state.tagsAll; renderHashtags(); });
window.addEventListener("hashchange", route);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

if (IS_ADMIN && CFG.forceRefreshUrl) {
  document.getElementById("admin-refresh").href = CFG.forceRefreshUrl;
  document.getElementById("admin").hidden = false;
}

// Start once every script (including present.js) has run.
document.addEventListener("DOMContentLoaded", () => {
  if (IS_PRESENT) Present.start();
  else route();
  load();
});
// The admin reloads every minute so new numbers show up soon after a refresh.
setInterval(load, (IS_ADMIN ? 1 : CFG.refreshMinutes || 10) * 60 * 1000);
