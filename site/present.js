"use strict";

// Presentation mode (?present): a full-screen slideshow for the classroom projector.
// Handles only, no admin UI, no clickable UI except a small fullscreen button.
// Uses the data, standings and chart helpers from app.js (loaded before this file).

const Present = (() => {
  const P = { slideSeconds: 15, pageSize: 10, graphAccounts: 8, risers: 10, ...(CFG.present || {}) };
  const sec = Number(PARAMS.get("sec"));
  if (Number.isFinite(sec) && sec >= 2) P.slideSeconds = sec; // ?present&sec=20 overrides the interval
  P.graphAccounts = Math.min(P.graphAccounts, MAX_SELECTED);

  const MEDALS = ["🥇", "🥈", "🥉"];
  const slotOf = new Map(); // graph colours stay with the account while it stays in the top
  let data = null;
  let slides = [];
  let index = 0;
  let timer = null;
  let root, stage;

  function buildSlides() {
    const list = [{ kind: "podium" }];
    for (let from = 3; from < data.standings.length; from += P.pageSize) list.push({ kind: "ranking", from });
    list.push({ kind: "graph" }, { kind: "risers" });
    return list;
  }

  const title = (text, sub = "") => `<h2 class="p-title">${text}${sub ? ` <span class="p-sub">${sub}</span>` : ""}</h2>`;
  const badge = (r) => (r.isPrivate ? privateBadge() : "");

  function podium() {
    const top = data.standings.slice(0, 3);
    const place = (i) => {
      const r = top[i];
      if (!r) return `<div class="p-pod p-pod-${i + 1} p-pod-empty"><div class="p-pod-block"></div></div>`;
      return `<div class="p-pod p-pod-${i + 1}">
        <div class="p-pod-medal">${MEDALS[i]}</div>
        <div class="p-pod-handle">@${esc(r.handle)}${badge(r)}</div>
        <div class="p-pod-views">${fmt(r.views)}</div>
        <div class="p-pod-label">weergaven</div>
        <div class="p-pod-gain">${r.gain == null ? "&nbsp;" : `${signed(r.gain)} sinds gisteren`}</div>
        <div class="p-pod-block">${r.rank}</div>
      </div>`;
    };
    // Classic podium order: 2nd, 1st, 3rd.
    return title("Top 3") + `<div class="p-podium">${[1, 0, 2].map(place).join("")}</div>`;
  }

  function ranking(from) {
    const rows = data.standings.slice(from, from + P.pageSize);
    const to = from + rows.length;
    return title("Stand", `plaats ${from + 1}–${to} van ${data.standings.length}`) + `
      <div class="p-table" style="--rows:${P.pageSize}">
        <div class="p-row p-head"><span>#</span><span>±</span><span>Account</span><span>Weergaven</span><span>Sinds gisteren</span></div>
        ${rows.map((r) => `
          <div class="p-row">
            <span class="p-rank">${r.rank}</span>
            <span class="p-chg">${changeCell(r)}</span>
            <span class="p-handle">@${esc(r.handle)}${badge(r)}</span>
            <span class="p-views">${fmt(r.views)}</span>
            <span class="p-gain">${r.gain == null ? "" : signed(r.gain)}</span>
          </div>`).join("")}
      </div>`;
  }

  function graphTop() {
    const top = data.standings.slice(0, P.graphAccounts).map((r) => r.handle);
    for (const h of [...slotOf.keys()]) if (!top.includes(h)) slotOf.delete(h);
    for (const h of top) {
      if (slotOf.has(h)) continue;
      const used = new Set(slotOf.values());
      let slot = 1;
      while (used.has(slot)) slot++;
      slotOf.set(h, slot);
    }
    return top;
  }
  const color = (h) => cssVar(`--s${slotOf.get(h)}`);

  function graph() {
    const top = graphTop();
    return title("Weergaven over tijd", `top ${top.length}`) + `
      <div class="p-graph">
        <div class="p-chart"><canvas id="p-chart" aria-label="Weergaven over tijd, top ${top.length}"></canvas></div>
        <ol class="p-legend">${top.map((h, i) => `
          <li><span class="p-dot" style="background:${color(h)}"></span><span class="p-legend-rank">${i + 1}</span>@${esc(h)}</li>`).join("")}
        </ol>
      </div>`;
  }

  function drawGraph() {
    const top = graphTop();
    const opts = timeAxis(baseOptions());
    opts.plugins.tooltip.enabled = false;
    opts.layout = { padding: { right: 8 } };
    drawChart("p-chart", {
      type: "line",
      data: { datasets: top.map((h) => ({ ...lineDataset("@" + h, points(h, "total_views"), color(h), false), borderWidth: 3 })) },
      options: opts,
    });
  }

  function risers() {
    const rows = data.standings
      .filter((r) => r.gain != null)
      .sort((a, b) => b.gain - a.gain || a.handle.localeCompare(b.handle))
      .slice(0, P.risers);
    const head = title("Stijgers van vandaag", "weergaven erbij sinds gisteren");
    if (!rows.length) return head + `<p class="p-message">Nog geen vergelijking met gisteren. Morgen staan hier de grootste stijgers.</p>`;
    const max = Math.max(1, ...rows.map((r) => r.gain));
    return head + `
      <div class="p-table p-risers" style="--rows:${P.risers}">
        ${rows.map((r, i) => `
          <div class="p-row">
            <span class="p-rank">${i + 1}</span>
            <span class="p-handle">@${esc(r.handle)}${badge(r)}</span>
            <span class="p-track"><span class="p-bar" style="width:${(Math.max(0, r.gain) / max) * 100}%"></span></span>
            <span class="p-views">${signed(r.gain)}</span>
          </div>`).join("")}
      </div>`;
  }

  function show(i) {
    if (!slides.length) return;
    index = ((i % slides.length) + slides.length) % slides.length;
    const slide = slides[index];
    if (state.charts["p-chart"]) {
      state.charts["p-chart"].destroy();
      delete state.charts["p-chart"];
    }
    stage.dataset.kind = slide.kind;
    stage.innerHTML = slide.kind === "podium" ? podium()
      : slide.kind === "ranking" ? ranking(slide.from)
      : slide.kind === "graph" ? graph()
      : risers();
    if (slide.kind === "graph") drawGraph();
    // Restart the enter animation and the progress bar.
    stage.classList.remove("p-enter");
    void stage.offsetWidth;
    stage.classList.add("p-enter");
    const bar = document.getElementById("p-bar");
    bar.style.animation = "none";
    void bar.offsetWidth;
    bar.style.animation = `p-progress ${P.slideSeconds}s linear forwards`;
    document.getElementById("p-dots").innerHTML = slides.map((_, n) => `<span class="${n === index ? "on" : ""}"></span>`).join("");
    clearTimeout(timer);
    timer = setTimeout(() => show(index + 1), P.slideSeconds * 1000);
  }

  function update(d) {
    const first = !data;
    data = d;
    slides = buildSlides();
    document.getElementById("p-updated").textContent =
      d.latest ? `Bijgewerkt: ${stampFmt.format(d.latest)}` : "Nog geen gegevens";
    // New data is picked up by the next slide; only the very first load starts the show.
    if (first) show(0);
    else if (index >= slides.length) show(0);
  }

  function error(message) {
    if (!data) {
      stage.innerHTML = `<p class="p-message">Kon de gegevens niet laden: ${esc(message)}</p>`;
    } else {
      document.getElementById("p-updated").textContent =
        `Bijgewerkt: ${stampFmt.format(data.latest)} · verversen mislukt, probeert het zo opnieuw`;
    }
  }

  function start() {
    root = document.getElementById("present");
    stage = document.getElementById("p-stage");
    root.hidden = false;
    // Larger chart text for the projector (about 22px at 1080p, 14px at 720p).
    Chart.defaults.font.size = Math.max(14, Math.round(Math.min(innerHeight, innerWidth * 0.5625) / 48));

    const fs = document.getElementById("p-fs");
    if (!document.fullscreenEnabled) fs.hidden = true;
    fs.addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    });

    // Hide the cursor (and the fullscreen button) after 3 s without mouse movement.
    let idle;
    const wake = () => {
      root.classList.remove("p-idle");
      clearTimeout(idle);
      idle = setTimeout(() => root.classList.add("p-idle"), 3000);
    };
    addEventListener("mousemove", wake);
    wake();

    // Re-render on resize (fullscreen toggle) so the chart and sizes fit again.
    let resize;
    addEventListener("resize", () => {
      clearTimeout(resize);
      resize = setTimeout(() => {
        Chart.defaults.font.size = Math.max(14, Math.round(Math.min(innerHeight, innerWidth * 0.5625) / 48));
        if (data) show(index);
      }, 200);
    });
  }

  return { start, update, error };
})();
