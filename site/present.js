"use strict";

// Presentation mode (?present): a full-screen slideshow for the classroom projector.
// Handles only, no admin UI. The only controls: a small fullscreen button, the slide dots,
// a pause button, and the keyboard (arrows, space, PageUp/PageDown from a presentation clicker;
// P, "." or B to pause - "." and B are what clickers send for their black-screen button).
// Finale: a countdown and LIVE labels until the deadline, then only the Eindstand (frozen).
// Uses the data, standings and chart helpers from app.js (loaded before this file).
// Two platforms, Instagram first: its podium, stand pages, graph and risers, then the same for TikTok.

const Present = (() => {
  const P = { slideSeconds: 15, pageSize: 10, graphAccounts: 8, risers: 10, ...(CFG.present || {}) };
  const sec = Number(PARAMS.get("sec"));
  if (Number.isFinite(sec) && sec >= 2) P.slideSeconds = sec; // ?present&sec=20 overrides the interval
  P.graphAccounts = Math.min(P.graphAccounts, MAX_SELECTED);

  const MEDALS = ["🥇", "🥈", "🥉"];
  const SLIDE_NAMES = { podium: "top 3", ranking: "stand", graph: "grafiek", risers: "stijgers laatste 24 uur" };

  // What differs per platform. TikTok ranks on views (+ 24 uur next to it); Instagram on followers gained since the
  // account's baseline, with the total followers next to it. `rows` are the accounts that have a place.
  const SPEC = {
    tiktok: {
      rows: (d) => d.standings,
      value: (r) => r.views, showValue: (r) => fmt(r.views), unit: "weergaven", valueHead: "Weergaven",
      next: (r) => (r.gain == null ? "" : signed(r.gain)), nextHead: "+ 24 uur",
      medal: (r) => r.rank <= 3 && r.views > 0,
      podiumNote: (r, final) => (r.gain == null || final ? "&nbsp;" : `${signed(r.gain)} in 24 uur`),
      chartKey: "total_views", chartTitle: "Weergaven over tijd",
      risersSub: "weergaven erbij in de laatste 24 uur",
    },
    instagram: {
      rows: (d) => d.standings.filter((r) => r.rank != null),
      value: (r) => r.gained, showValue: (r) => signed(r.gained), unit: "volgers erbij", valueHead: "Volgers erbij",
      next: (r) => fmt(r.followers), nextHead: "Volgers",
      medal: (r) => r.rank <= 3 && r.gained > 0,
      podiumNote: (r) => `${fmt(r.followers)} volgers`,
      chartKey: "gain", chartTitle: "Volgers erbij over tijd",
      risersSub: "volgers erbij in de laatste 24 uur",
    },
  };
  const PAUSE_KEYS = new Set(["p", "P", ".", "b", "B"]);
  const slotOf = new Map(); // graph colours stay with the account while it stays in the top
  let all = null;   // { instagram, tiktok }: the datasets of both platforms
  let data = null;  // the dataset of the slide being drawn
  let slides = [];
  let index = 0;
  let timer = null;
  let paused = false;
  let phase = finalePhase();
  let root, stage;

  // Platforms with something to rank, Instagram first.
  const platformsShown = () => ["instagram", "tiktok"].filter((p) => all[p] && SPEC[p].rows(all[p]).length);
  const isFinal = () => Boolean(all && all.tiktok && all.tiktok.final);

  // After the deadline only the Eindstand: podium and the full final ranking, per platform.
  function buildSlides() {
    const list = [];
    for (const platform of platformsShown()) {
      list.push({ kind: "podium", platform });
      for (let from = 3; from < SPEC[platform].rows(all[platform]).length; from += P.pageSize) list.push({ kind: "ranking", platform, from });
      if (!isFinal()) list.push({ kind: "graph", platform }, { kind: "risers", platform });
    }
    return list;
  }

  const live = () => (phase === "live" ? ` <span class="live p-live">LIVE</span>` : "");
  // "Instagram · Top 3", or "🏁 Eindstand Instagram · stand" after the deadline.
  const title = (text, sub = "") => {
    const platform = PLATFORMS[data.platform].label;
    const head = isFinal() ? `🏁 Eindstand ${platform}` + (text === "Top 3" ? "" : ` · ${text.toLowerCase()}`) : `${platform} · ${text}`;
    return `<h2 class="p-title">${head}${live()}${sub ? ` <span class="p-sub">${sub}</span>` : ""}</h2>`;
  };
  const badge = (r) => (r.isPrivate ? privateBadge() : "") + (r.late ? ` <span class="p-late" title="Later toegevoegd: telt vanaf zijn eerste meting">vanaf ${shortDayFmt.format(dayMs(localDay(r.baselineAt)))}</span>` : "");
  // The private dashboard passes first names as labels; the public site only has handles.
  const who = (handle) => {
    const label = data.labels && data.labels[handle];
    return label ? `${esc(label)} <span class="p-at">${esc(who2(handle))}</span>` : esc(who2(handle));
  };

  function podium() {
    const spec = SPEC[data.platform];
    const top = spec.rows(data).slice(0, 3);
    const place = (i) => {
      const r = top[i];
      if (!r) return `<div class="p-pod p-pod-${i + 1} p-pod-empty"><div class="p-pod-block"></div></div>`;
      return `<div class="p-pod p-pod-${i + 1}">
        <div class="p-pod-medal">${MEDALS[Math.min(r.rank, 3) - 1]}</div>
        <div class="p-pod-handle">${who(r.handle)}${badge(r)}</div>
        <div class="p-pod-views">${spec.showValue(r)}</div>
        <div class="p-pod-label">${spec.unit}</div>
        <div class="p-pod-gain">${spec.podiumNote(r, isFinal())}</div>
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
    const spec = SPEC[data.platform];
    const list = spec.rows(data);
    const rows = list.slice(from, from + P.pageSize);
    const to = from + rows.length;
    const vw = chars(rows.map((r) => spec.showValue(r))), gw = chars(rows.map((r) => spec.next(r)));
    return title("Stand", `plaats ${from + 1}–${to} van ${list.length}`) + `
      <div class="p-table" style="--rows:${P.pageSize}; --vw:${vw}; --gw:${gw}">
        <div class="p-row p-head"><span>#</span><span>±</span><span>Account</span><span>${spec.valueHead}</span><span>${spec.nextHead}</span></div>
        ${rows.map((r) => `
          <div class="p-row">
            <span class="p-rank">${r.rank}</span>
            <span class="p-chg">${changeCell(r)}</span>
            <span class="p-handle">${who(r.handle)}${badge(r)}</span>
            <span class="p-views">${spec.showValue(r)}</span>
            <span class="p-gain">${spec.next(r)}</span>
          </div>`).join("")}
      </div>`;
  }

  function graphTop() {
    const top = SPEC[data.platform].rows(data).slice(0, P.graphAccounts).map((r) => r.handle);
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
    const spec = SPEC[data.platform];
    return title(spec.chartTitle, `top ${top.length}`) + `
      <div class="p-graph">
        <div class="p-chart"><canvas id="p-chart" aria-label="${spec.chartTitle}, top ${top.length}"></canvas></div>
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
    const key = SPEC[data.platform].chartKey;
    const datasets = applyOutliers(top.map((h) => ({ ...lineDataset(who2(h), points(h, key), color(h), false), borderWidth: 3, handle: h })));
    outlierPadding(opts, datasets);
    drawChart("p-chart", { type: "line", data: { datasets }, options: opts, plugins: [outlierMarks] });
  }

  function risers() {
    const spec = SPEC[data.platform];
    const rows = spec.rows(data)
      .filter((r) => r.gain != null)
      .sort((a, b) => b.gain - a.gain || a.handle.localeCompare(b.handle))
      .slice(0, P.risers);
    const head = title("Stijgers", spec.risersSub);
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
    // The helpers from app.js (who2, points, applyOutliers) work on the platform of this slide.
    data = all[slide.platform];
    state.data = data;
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
    if (all) restartTimer();
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
      else if (all) show(index);  // LIVE labels on / off
    }
  }

  // d = { instagram, tiktok } (state.all).
  function update(d) {
    const first = !all;
    phase = finalePhase();
    tickFinale();
    const wasFinal = isFinal();
    all = d;
    slides = buildSlides();
    const latest = Math.max(d.tiktok.latest, d.instagram ? d.instagram.latest : 0);
    document.getElementById("p-updated").textContent = !latest ? "Nog geen gegevens"
      : isFinal() ? `Eindstand · laatste meting ${stampFmt.format(latest)}` : `Bijgewerkt: ${stampFmt.format(latest)}`;
    // New data is picked up by the next slide; the first load (and the switch to the Eindstand) starts over.
    if (first || (isFinal() && !wasFinal)) show(0);
    else if (index >= slides.length) show(0);
  }

  function error(message) {
    if (!all) {
      stage.innerHTML = `<p class="p-message">Kon de gegevens niet laden: ${esc(message)}</p>`;
    } else {
      document.getElementById("p-updated").textContent =
        `Bijgewerkt: ${stampFmt.format(Math.max(all.tiktok.latest, all.instagram ? all.instagram.latest : 0))} · verversen mislukt, probeert het zo opnieuw`;
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
      if (dot && all) show(Number(dot.dataset.slide));
    });
    const pauseBtn = document.getElementById("p-pause");
    pauseBtn.addEventListener("click", () => {
      pauseBtn.blur(); // keep Space for "next slide"
      setPaused(!paused);
    });
    addEventListener("keydown", (ev) => {
      if (!all || ev.ctrlKey || ev.altKey || ev.metaKey) return;
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
        if (all) show(index);
      }, 200);
    });
  }

  return { start, update, error };
})();
