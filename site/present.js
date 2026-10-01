"use strict";

// Presentation mode (?present): a full-screen slideshow for the classroom projector.
// Handles only, no admin UI. The only controls: a small fullscreen button, the slide dots,
// a pause button, and the keyboard (arrows, space, PageUp/PageDown from a presentation clicker;
// P, "." or B to pause - "." and B are what clickers send for their black-screen button).
// Finale: a countdown and LIVE labels until the deadline, then only the Eindstand (frozen).
// Uses the data, standings and chart helpers from app.js (loaded before this file).

const Present = (() => {
  const P = { slideSeconds: 15, pageSize: 10, graphAccounts: 8, risers: 10, ...(CFG.present || {}) };
  const sec = Number(PARAMS.get("sec"));
  if (Number.isFinite(sec) && sec >= 2) P.slideSeconds = sec; // ?present&sec=20 overrides the interval
  P.graphAccounts = Math.min(P.graphAccounts, MAX_SELECTED);

  const MEDALS = ["🥇", "🥈", "🥉"];
  const SLIDE_NAMES = { podium: "top 3", ranking: "stand", graph: "grafiek", risers: "stijgers laatste 24 uur" };
  const PAUSE_KEYS = new Set(["p", "P", ".", "b", "B"]);
  const slotOf = new Map(); // graph colours stay with the account while it stays in the top
  let data = null;
  let slides = [];
  let index = 0;
  let timer = null;
  let paused = false;
  let phase = finalePhase();
  let root, stage;

  // After the deadline only the Eindstand: podium and the full final ranking.
  function buildSlides() {
    const list = [{ kind: "podium" }];
    for (let from = 3; from < data.standings.length; from += P.pageSize) list.push({ kind: "ranking", from });
    if (!data.final) list.push({ kind: "graph" }, { kind: "risers" });
    return list;
  }

  const live = () => (phase === "live" ? ` <span class="live p-live">LIVE</span>` : "");
  const title = (text, sub = "") =>
    `<h2 class="p-title">${data && data.final ? "🏁 Eindstand" + (text === "Top 3" ? "" : ` · ${text.toLowerCase()}`) : text}${live()}${sub ? ` <span class="p-sub">${sub}</span>` : ""}</h2>`;
  const badge = (r) => (r.isPrivate ? privateBadge() : "");
  // The private dashboard passes first names as labels; the public site only has handles.
  const who = (handle) => {
    const label = data.labels && data.labels[handle];
    return label ? `${esc(label)} <span class="p-at">@${esc(handle)}</span>` : `@${esc(handle)}`;
  };

  function podium() {
    const top = data.standings.slice(0, 3);
    const place = (i) => {
      const r = top[i];
      if (!r) return `<div class="p-pod p-pod-${i + 1} p-pod-empty"><div class="p-pod-block"></div></div>`;
      return `<div class="p-pod p-pod-${i + 1}">
        <div class="p-pod-medal">${MEDALS[i]}</div>
        <div class="p-pod-handle">${who(r.handle)}${badge(r)}</div>
        <div class="p-pod-views">${fmt(r.views)}</div>
        <div class="p-pod-label">weergaven</div>
        <div class="p-pod-gain">${r.gain == null || data.final ? "&nbsp;" : `${signed(r.gain)} in 24 uur`}</div>
        <div class="p-pod-block">${r.rank}</div>
      </div>`;
    };
    // Classic podium order: 2nd, 1st, 3rd.
    return title("Top 3") + `<div class="p-podium">${[1, 0, 2].map(place).join("")}</div>`;
  }

  // Characters of the longest number in a column, so its width fits 7-digit numbers (the
  // 2-million account) and stays the same in every row.
  const chars = (list) => Math.max(0, ...list.map((s) => String(s).length));

  function ranking(from) {
    const rows = data.standings.slice(from, from + P.pageSize);
    const to = from + rows.length;
    const vw = chars(rows.map((r) => fmt(r.views))), gw = chars(rows.map((r) => (r.gain == null ? "" : signed(r.gain))));
    return title("Stand", `plaats ${from + 1}–${to} van ${data.standings.length}`) + `
      <div class="p-table" style="--rows:${P.pageSize}; --vw:${vw}; --gw:${gw}">
        <div class="p-row p-head"><span>#</span><span>±</span><span>Account</span><span>Weergaven</span><span>+ 24 uur</span></div>
        ${rows.map((r) => `
          <div class="p-row">
            <span class="p-rank">${r.rank}</span>
            <span class="p-chg">${changeCell(r)}</span>
            <span class="p-handle">${who(r.handle)}${badge(r)}</span>
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
          <li><span class="p-dot" style="background:${data.outliers.has(h) ? cssVar("--muted") : color(h)}"></span><span class="p-legend-rank">${i + 1}</span><span class="p-legend-name">${who(h)}${data.outliers.has(h) ? ` <span class="p-out">▲ buiten schaal</span>` : ""}</span></li>`).join("")}
        </ol>
      </div>`;
  }

  function drawGraph() {
    const top = graphTop();
    const opts = timeAxis(baseOptions());
    opts.plugins.tooltip.enabled = false;
    opts.layout = { padding: { right: 8 } };
    const datasets = applyOutliers(top.map((h) => ({ ...lineDataset("@" + h, points(h, "total_views"), color(h), false), borderWidth: 3, handle: h })));
    outlierPadding(opts, datasets);
    drawChart("p-chart", { type: "line", data: { datasets }, options: opts, plugins: [outlierMarks] });
  }

  function risers() {
    const rows = data.standings
      .filter((r) => r.gain != null)
      .sort((a, b) => b.gain - a.gain || a.handle.localeCompare(b.handle))
      .slice(0, P.risers);
    const head = title("Stijgers", "weergaven erbij in de laatste 24 uur");
    if (!rows.length) return head + `<p class="p-message">Nog geen vergelijking met 24 uur geleden. Morgen staan hier de grootste stijgers.</p>`;
    // Bars scale without "buiten schaal" accounts; theirs runs off the end, grey with a ▲.
    const scaled = rows.filter((r) => !data.outliers.has(r.handle));
    const max = Math.max(1, ...(scaled.length ? scaled : rows).map((r) => r.gain));
    return head + `
      <div class="p-table p-risers" style="--rows:${P.risers}; --gw:${chars(rows.map((r) => signed(r.gain)))}">
        ${rows.map((r, i) => `
          <div class="p-row">
            <span class="p-rank">${i + 1}</span>
            <span class="p-handle">${who(r.handle)}${badge(r)}</span>
            <span class="p-track${r.gain > max ? " p-track-out" : ""}"><span class="p-bar${r.gain > max ? " p-bar-out" : ""}" style="width:${Math.min(1, Math.max(0, r.gain) / max) * 100}%"></span>${r.gain > max ? `<span class="p-out-mark">▲</span>` : ""}</span>
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
    restartTimer();
    // tabindex=-1: a clicked dot never keeps focus, so Space keeps meaning "next slide".
    document.getElementById("p-dots").innerHTML = slides.map((sl, n) =>
      `<button type="button" tabindex="-1" data-slide="${n}" class="${n === index ? "on" : ""}"` +
      ` aria-label="Dia ${n + 1}: ${SLIDE_NAMES[sl.kind]}"${n === index ? ' aria-current="true"' : ""}></button>`).join("");
  }

  // Auto-advance and the progress bar; both stop while paused. Skipping keeps the pause.
  function restartTimer() {
    clearTimeout(timer);
    const bar = document.getElementById("p-bar");
    bar.style.animation = "none";
    if (paused) return;
    void bar.offsetWidth;
    bar.style.animation = `p-progress ${P.slideSeconds}s linear forwards`;
    timer = setTimeout(() => show(index + 1), P.slideSeconds * 1000);
  }

  function setPaused(value) {
    paused = value;
    const btn = document.getElementById("p-pause");
    btn.textContent = paused ? "▶" : "⏸";
    btn.setAttribute("aria-pressed", String(paused));
    btn.setAttribute("aria-label", paused ? "Verder afspelen" : "Pauzeren");
    btn.title = paused ? "Verder afspelen (P)" : "Pauzeren (P)";
    document.getElementById("p-paused").hidden = !paused;
    root.classList.toggle("p-is-paused", paused);
    if (data) restartTimer();
  }

  // Finale countdown (every second while live) and the switch to the Eindstand at the deadline.
  function tickFinale() {
    const next = finalePhase();
    const box = document.getElementById("p-finale");
    if (next === "live") {
      box.innerHTML = `<span class="live">LIVE</span> nog <strong>${countdown(FINALE.end - now())}</strong> tot de deadline (${hourFmt.format(FINALE.end)})`;
    }
    box.hidden = next !== "live";
    if (next !== phase) {
      phase = next;
      if (next === "after") load(); // rebuilt frozen at the last run before the deadline: Eindstand slides
      else if (data) show(index);  // LIVE labels on / off
    }
  }

  function update(d) {
    const first = !data;
    phase = finalePhase();
    tickFinale();
    const wasFinal = data && data.final;
    data = d;
    slides = buildSlides();
    document.getElementById("p-updated").textContent = !d.latest ? "Nog geen gegevens"
      : d.final ? `Eindstand · laatste meting ${stampFmt.format(d.latest)}` : `Bijgewerkt: ${stampFmt.format(d.latest)}`;
    // New data is picked up by the next slide; the first load (and the switch to the Eindstand) starts over.
    if (first || (d.final && !wasFinal)) show(0);
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
      fs.blur(); // keep Space for "next slide"
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    });

    // Manual skipping: click a dot, or use the keyboard. Every skip restarts that slide's timer.
    document.getElementById("p-dots").addEventListener("click", (ev) => {
      const dot = ev.target.closest("button[data-slide]");
      if (dot && data) show(Number(dot.dataset.slide));
    });
    const pauseBtn = document.getElementById("p-pause");
    pauseBtn.addEventListener("click", () => {
      pauseBtn.blur(); // keep Space for "next slide"
      setPaused(!paused);
    });
    addEventListener("keydown", (ev) => {
      if (!data || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      if (PAUSE_KEYS.has(ev.key)) {
        ev.preventDefault();
        setPaused(!paused);
        return;
      }
      const next = ["ArrowRight", "PageDown"].includes(ev.key) || (ev.key === " " && !ev.shiftKey);
      const prev = ["ArrowLeft", "PageUp"].includes(ev.key) || (ev.key === " " && ev.shiftKey);
      if (!next && !prev) return;
      ev.preventDefault();
      show(index + (next ? 1 : -1));
    });

    setInterval(tickFinale, 1000); // the finale state arrives with the data (and can start any time)

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
