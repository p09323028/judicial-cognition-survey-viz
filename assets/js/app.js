/* 司法認知調查視覺化 — 互動邏輯
   資料：window.SURVEY_DATA（由 build_data.py 產生）
   圖表：Chart.js 4（本機 vendor） */
(function () {
  "use strict";
  const D = window.SURVEY_DATA;
  if (!D || !window.Chart) {
    document.getElementById("main").insertAdjacentHTML("afterbegin",
      '<p class="card" role="alert">無法載入資料或圖表函式庫，請確認 data/ 與 assets/vendor/ 資料夾完整。</p>');
    return;
  }

  /* ---------------------------------------------------------------- 基本設定 */
  const YEARS = D.meta.years;
  const LAST = YEARS[YEARS.length - 1];
  const IND = D.meta.indicators;
  const IND_KEYS = Object.keys(IND);
  const SMALL_N = D.meta.smallN;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    ovYear: LAST, trendSel: new Set(["trust", "lawful", "sent", "willing"]), likert: "trust",
    grpInd: "trust", grpDim: "age", grpYear: LAST,
    ctyInd: "trust", ctyYear: LAST, county: null,
    ctYear: LAST,
    mediaSel: new Set(["電視", "網路新聞", "社群網站（FB、IG 等）", "影音平台（YouTube 等）", "通訊軟體（LINE 等）"]),
  };

  // 系列身分固定對應顏色與線型（顏色跟著實體，不跟排序）
  const DASHES = [[], [7, 4], [2, 3], [10, 4, 2, 4], [4, 4], [8, 3, 2, 3]];
  const POINTS = ["circle", "rect", "triangle", "rectRot", "rectRounded", "crossRot"];
  const IND_SLOT = { trust: 0, lawful: 1, sent: 2, indep: 3, willing: 4, overall: 5 };
  const MEDIA_SLOT = { "電視": 0, "網路新聞": 1, "社群網站（FB、IG 等）": 2, "影音平台（YouTube 等）": 3, "通訊軟體（LINE 等）": 4, "法律相關網站": 5 };

  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const slot = (i) => css("--s" + (i + 1));
  const fmt = (v, d = 1) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(d) + "%");
  const fmtN = (n) => (n == null ? "—" : Number(n).toLocaleString("zh-TW"));
  const ciText = (s) => (s ? `95% CI ${s.lo.toFixed(1)}–${s.hi.toFixed(1)}，n=${fmtN(s.n)}` : "");
  const SHORT = { "金門縣、連江縣": "金馬", "新竹市": "竹市", "新竹縣": "竹縣", "嘉義市": "嘉市", "嘉義縣": "嘉縣" };
  const shortCounty = (name) => SHORT[name] || name.slice(0, 2);
  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------- Chart.js 外掛 */
  // 線尾直接標註系列名稱（避免只靠顏色辨識）；窄螢幕時停用，改靠圖例／標籤
  const endLabels = {
    id: "endLabels",
    afterDatasetsDraw(chart, _a, opts) {
      if (!opts || !opts.enabled || chart.width < END_LABEL_MIN) return;
      const { ctx, chartArea } = chart;
      const items = [];
      chart.data.datasets.forEach((ds, i) => {
        const meta = chart.getDatasetMeta(i);
        if (meta.hidden) return;
        for (let j = meta.data.length - 1; j >= 0; j--) {
          const v = ds.data[j];
          if (v != null) { items.push({ y: meta.data[j].y, x: meta.data[j].x, label: ds.shortLabel || ds.label, color: ds.borderColor }); break; }
        }
      });
      items.sort((a, b) => a.y - b.y);
      for (let i = 1; i < items.length; i++) if (items[i].y - items[i - 1].y < 16) items[i].y = items[i - 1].y + 16;
      ctx.save();
      ctx.font = "600 12px " + css("--font");
      ctx.textBaseline = "middle";
      items.forEach((it) => {
        const x = Math.min(it.x + 10, chartArea.right + 10);
        ctx.strokeStyle = it.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, it.y); ctx.lineTo(x + 10, it.y); ctx.stroke();
        ctx.fillStyle = css("--text-2");
        ctx.fillText(it.label, x + 14, it.y);
      });
      ctx.restore();
    },
  };
  // 水平長條的 95% 信賴區間細線
  const ciWhiskers = {
    id: "ciWhiskers",
    afterDatasetsDraw(chart, _a, opts) {
      if (!opts || !opts.enabled) return;
      const { ctx } = chart; const xs = chart.scales.x;
      ctx.save();
      ctx.strokeStyle = css("--text"); ctx.lineWidth = 1.5;
      chart.data.datasets.forEach((ds, i) => {
        if (!ds.ci) return;
        chart.getDatasetMeta(i).data.forEach((bar, j) => {
          const c = ds.ci[j]; if (!c) return;
          const x1 = xs.getPixelForValue(c[0]), x2 = xs.getPixelForValue(c[1]), y = bar.y;
          ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y);
          ctx.moveTo(x1, y - 5); ctx.lineTo(x1, y + 5); ctx.moveTo(x2, y - 5); ctx.lineTo(x2, y + 5);
          ctx.stroke();
        });
      });
      ctx.restore();
    },
  };
  // 長條數值標籤（end：長條外側；inside：區段內，夠寬才標）
  const barLabels = {
    id: "barLabels",
    afterDatasetsDraw(chart, _a, opts) {
      if (!opts || !opts.mode) return;
      const { ctx } = chart;
      ctx.save();
      ctx.font = "600 12px " + css("--font");
      ctx.textBaseline = "middle";
      chart.data.datasets.forEach((ds, i) => {
        const meta = chart.getDatasetMeta(i); if (meta.hidden) return;
        meta.data.forEach((bar, j) => {
          const v = ds.data[j]; if (v == null) return;
          if (opts.mode === "end") {
            const xEnd = ds.ci && ds.ci[j] ? chart.scales.x.getPixelForValue(ds.ci[j][1]) : bar.x;
            ctx.fillStyle = css("--text"); ctx.textAlign = "left";
            ctx.fillText(fmt(v), Math.max(bar.x, xEnd) + 6, bar.y);
          } else if (opts.mode === "inside" && Math.abs(v) >= (opts.min || 8)) {
            const w = Math.abs(bar.x - bar.base);
            if (w < 34) return;
            ctx.fillStyle = ds.labelInk || "#ffffff"; ctx.textAlign = "center";
            ctx.fillText(fmt(Math.abs(v), 0), (bar.x + bar.base) / 2, bar.y);
          }
        });
      });
      ctx.restore();
    },
  };
  // 參考線（例：全體平均）
  const refLine = {
    id: "refLine",
    afterDatasetsDraw(chart, _a, opts) {
      if (!opts || opts.value == null) return;
      const { ctx, chartArea } = chart; const x = chart.scales.x.getPixelForValue(opts.value);
      ctx.save();
      ctx.strokeStyle = css("--muted"); ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css("--text-2"); ctx.font = "12px " + css("--font"); ctx.textAlign = "left";
      ctx.fillText(opts.label, Math.min(x + 4, chartArea.right - 80), chartArea.top + 6);
      ctx.restore();
    },
  };
  Chart.register(endLabels, ciWhiskers, barLabels, refLine);

  function applyChartTheme() {
    Chart.defaults.font.family = css("--font");
    Chart.defaults.font.size = 13;
    Chart.defaults.color = css("--text-2");
    Chart.defaults.borderColor = css("--grid");
    // 只改 duration，不可整個覆蓋 animation 物件（會遺失 easing 等預設，導致重繪後空白）
    if (reduceMotion) Chart.defaults.animation = false;
    else Chart.defaults.animation.duration = 350;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.plugins.tooltip.backgroundColor = css("--primary");
    Chart.defaults.plugins.tooltip.titleColor = css("--bg");
    Chart.defaults.plugins.tooltip.bodyColor = css("--bg");
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.plugins.legend.labels.boxWidth = 14;
    Chart.defaults.plugins.legend.labels.boxHeight = 14;
  }

  const charts = {};
  function draw(id, cfg) {
    if (charts[id]) {
      charts[id].destroy();
      // 互動重繪時不跑動畫：同步繪製，不依賴 requestAnimationFrame
      // （部分瀏覽器／預覽窗格會暫停 rAF，動畫卡在第 0 格導致圖表空白）
      cfg.options = Object.assign({}, cfg.options, { animation: false });
    }
    charts[id] = new Chart($(id), cfg);
    return charts[id];
  }
  // 線尾標註只在寬度 ≥ 560px 時顯示，窄螢幕不保留右側空間
  const END_LABEL_MIN = 560;
  const endPad = (id, px) => ($(id).parentElement.clientWidth >= END_LABEL_MIN ? px : 8);
  const pctAxis = (min = 0, max = 100) => ({
    min, max, grid: { color: css("--grid") }, border: { color: css("--axis") },
    ticks: { callback: (v) => v + "%" },
  });

  /* ---------------------------------------------------------------- 資料表（無障礙替代） */
  const tables = {};
  function setTable(id, caption, head, rows) {
    tables[id] = { caption, head, rows };
    const host = document.querySelector(`[data-table-for="${id}"]`);
    if (host && host._wrap && !host._wrap.hidden) renderTable(id);
  }
  function renderTable(id) {
    const host = document.querySelector(`[data-table-for="${id}"]`);
    const t = tables[id]; if (!host || !t) return;
    const sortable = t.sortable;
    const thead = t.head.map((h, i) => `<th scope="col">${sortable ? `<button type="button" data-col="${i}">${h}</button>` : h}</th>`).join("");
    const body = t.rows.map((r) => "<tr>" + r.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join("") + "</tr>").join("");
    host._wrap.innerHTML = `<table class="data-table"><caption class="sr-only">${t.caption}</caption><thead><tr>${thead}</tr></thead><tbody>${body}</tbody></table>`;
  }
  document.querySelectorAll("[data-table-for]").forEach((host) => {
    const id = host.dataset.tableFor;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "table-toggle"; btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v14H3zM3 10h18M9 10v9"/></svg><span>顯示資料表</span>';
    const wrap = document.createElement("div"); wrap.className = "table-wrap"; wrap.hidden = true; wrap.id = "tbl-" + id;
    btn.setAttribute("aria-controls", wrap.id);
    btn.addEventListener("click", () => {
      wrap.hidden = !wrap.hidden;
      btn.setAttribute("aria-expanded", String(!wrap.hidden));
      btn.querySelector("span").textContent = wrap.hidden ? "顯示資料表" : "隱藏資料表";
      if (!wrap.hidden) renderTable(id);
    });
    host._wrap = wrap;
    host.append(btn, wrap);
  });

  /* ---------------------------------------------------------------- 控制元件 */
  function segmented(name, options, getVal, setVal) {
    const el = document.querySelector(`[data-control="${name}"]`);
    el.innerHTML = "";
    const btns = options.map((o) => {
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "radio"); b.textContent = o.label; b.dataset.value = o.value;
      b.addEventListener("click", () => { setVal(o.value); sync(); });
      el.appendChild(b); return b;
    });
    function sync() {
      btns.forEach((b) => {
        const on = String(getVal()) === b.dataset.value;
        b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1;
      });
    }
    el.addEventListener("keydown", (e) => {
      const i = btns.findIndex((b) => b.getAttribute("aria-checked") === "true");
      let k = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") k = (i + 1) % btns.length;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") k = (i - 1 + btns.length) % btns.length;
      if (k == null) return;
      e.preventDefault(); btns[k].click(); btns[k].focus();
    });
    sync();
  }
  function fillSelect(id, options, value, onChange) {
    const s = $(id);
    s.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
  }
  const yearOpts = YEARS.map((y) => ({ value: String(y), label: y + " 年" }));

  /* ---------------------------------------------------------------- 1. 重點摘要與 KPI */
  function renderHighlights() {
    const t0 = D.trend.trust[YEARS[0]], t1 = D.trend.trust[LAST];
    const ch = D.change[LAST];
    const tv = D.media["電視"][LAST], net = D.media["網路新聞"][LAST];
    const diff = (t1.p - t0.p).toFixed(1);
    $("highlights").innerHTML = [
      `<li>${LAST} 年信任法官的比例為 <strong>${fmt(t1.p)}</strong>，${YEARS[0]} 年為 ${fmt(t0.p)}（${diff > 0 ? "+" : ""}${diff} 個百分點）。</li>`,
      `<li>曾到過法院的人當中，<strong>${fmt(ch["更差"].p)}</strong> 覺得去過之後對司法觀感變差，${fmt(ch["更好"].p)} 覺得變好。</li>`,
      `<li>${LAST} 年從網路新聞獲得司法資訊者占 <strong>${fmt(net.p)}</strong>，${net.p > tv.p ? "已超過" : "接近"}電視（${fmt(tv.p)}）。</li>`,
    ].join("");
  }

  const KPI_DEFS = [
    { key: "trust", label: "信任法官", get: (y) => D.trend.trust[y], base: "全體受訪者" },
    { key: "willing", label: "願意上法院解決糾紛", get: (y) => D.trend.willing[y], base: "全體受訪者" },
    { key: "visit", label: "曾到過法院", get: (y) => D.funnel[y]["到過法院"], base: "全體受訪者（本人或陪同親友）" },
    { key: "overall", label: "到法院整體經驗滿意", get: (y) => D.trend.overall[y], base: "曾到過法院者" },
  ];
  function sparkline(vals, curIdx) {
    const w = 220, h = 44, pad = 6;
    const min = Math.min(...vals) - 2, max = Math.max(...vals) + 2;
    const X = (i) => pad + (i * (w - 2 * pad)) / (vals.length - 1);
    const Y = (v) => h - pad - ((v - min) / (max - min)) * (h - 2 * pad);
    const d = vals.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1)).join(" ");
    const dots = vals.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="${i === curIdx ? 5 : 3}"/>`).join("");
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/>${dots}</svg>`;
  }
  function renderKPIs() {
    const y = state.ovYear, yi = YEARS.indexOf(y), prev = YEARS[yi - 1];
    $("kpis").innerHTML = KPI_DEFS.map((k) => {
      const s = k.get(y), vals = YEARS.map((yy) => k.get(yy).p);
      let delta = '<span class="kpi-delta flat"><span class="delta-text">首年資料</span></span>';
      if (prev) {
        const dlt = s.p - k.get(prev).p, cls = Math.abs(dlt) < 0.05 ? "flat" : dlt > 0 ? "up" : "down";
        const icon = cls === "up" ? '<path d="m6 15 6-6 6 6"/>' : cls === "down" ? '<path d="m6 9 6 6 6-6"/>' : '<path d="M5 12h14"/>';
        delta = `<span class="kpi-delta ${cls}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>${dlt > 0 ? "+" : ""}${dlt.toFixed(1)} 個百分點<span class="delta-text">（較 ${prev} 年）</span></span>`;
      }
      return `<div class="kpi">
        <span class="kpi-label">${k.label}</span>
        <span class="kpi-base">${k.base}</span>
        <span class="kpi-value">${s.p.toFixed(1)}<small>%</small></span>
        <span class="kpi-ci">${ciText(s)}</span>
        ${delta}
        ${sparkline(vals, yi)}
      </div>`;
    }).join("");
  }

  /* ---------------------------------------------------------------- 2. 趨勢 */
  function buildTrendChips() {
    const host = $("trendChips");
    host.innerHTML = "";
    IND_KEYS.forEach((k) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.dataset.key = k;
      const i = IND_SLOT[k];
      b.innerHTML = `<span class="swatch" style="--c:${slot(i)};border-top-style:${i === 0 ? "solid" : i === 2 ? "dotted" : "dashed"}"></span>${IND[k].label}`;
      b.setAttribute("aria-pressed", String(state.trendSel.has(k)));
      b.addEventListener("click", () => {
        if (state.trendSel.has(k)) { if (state.trendSel.size > 1) state.trendSel.delete(k); }
        else state.trendSel.add(k);
        b.setAttribute("aria-pressed", String(state.trendSel.has(k)));
        renderTrend();
      });
      host.appendChild(b);
    });
  }
  function renderTrend() {
    const keys = IND_KEYS.filter((k) => state.trendSel.has(k));
    const datasets = keys.map((k) => {
      const i = IND_SLOT[k], wc = IND[k].wording_change || [];
      const meta = YEARS.map((y) => D.trend[k][y]);
      return {
        label: IND[k].label, shortLabel: IND[k].label, data: meta.map((s) => s.p), meta,
        borderColor: slot(i), backgroundColor: slot(i), borderWidth: 2, borderDash: DASHES[i],
        pointStyle: YEARS.map((y) => (wc.includes(y) ? "rectRot" : POINTS[i])),
        pointRadius: YEARS.map((y) => (wc.includes(y) ? 7 : 4)), pointHoverRadius: 8,
        pointBorderColor: css("--surface"), pointBorderWidth: 2, tension: 0,
      };
    });
    const all = datasets.flatMap((d) => d.data);
    const lo = Math.max(0, Math.floor((Math.min(...all) - 5) / 10) * 10), hi = Math.min(100, Math.ceil((Math.max(...all) + 5) / 10) * 10);
    draw("trendChart", {
      type: "line",
      data: { labels: YEARS.map((y) => y + " 年"), datasets },
      options: {
        interaction: { mode: "index", intersect: false },
        layout: { padding: { right: endPad("trendChart", 130), top: 8 } },
        scales: { y: pctAxis(lo, hi), x: { grid: { display: false }, border: { color: css("--axis") } } },
        plugins: {
          legend: { display: false },
          endLabels: { enabled: true },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}：${fmt(c.raw)}（${ciText(c.dataset.meta[c.dataIndex])}）` } },
        },
      },
    });
    $("trendNote").textContent = state.trendSel.has("indep")
      ? "菱形標記：「法官能獨立審判」題於 112、113、114 年修改措辭，跨年變化可能部分來自題目改變。" : "";
    setTable("trendChart", "各指標年度正面比例", ["指標", ...YEARS.map((y) => y + " 年")],
      keys.map((k) => [IND[k].label, ...YEARS.map((y) => fmt(D.trend[k][y].p))]));
  }

  function renderLikert() {
    const k = state.likert, sc = D.meta.likert[IND[k].scale];
    $("likertQ").textContent = IND[k].question + "（" + IND[k].base + "）";
    const dist = YEARS.map((y) => D.trend[k][y].dist);
    const L = YEARS.map((y, i) => `${y} 年（無意見 ${dist[i]["98"].toFixed(1)}%）`);
    const neu = dist.map((d) => d["3"] / 2);
    const surface = css("--surface");
    const mkDs = (label, data, color, ink, hideLegend) => ({ label, data, backgroundColor: color, borderColor: surface, borderWidth: 1, labelInk: ink, hideLegend, stack: "s", barPercentage: 0.75, categoryPercentage: 0.9 });
    const dark = "#0b0b0b", white = "#ffffff";
    const isDark = document.documentElement.getAttribute("data-theme") === "dark" ||
      (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const datasets = [
      mkDs("普通", neu.map((v) => -v), css("--neutral"), isDark ? white : dark, true),
      mkDs(sc[2], dist.map((d) => -d["4"]), css("--neg-weak"), isDark ? white : dark),
      mkDs(sc[3], dist.map((d) => -d["5"]), css("--neg-strong"), white),
      mkDs("普通", neu, css("--neutral"), isDark ? white : dark),
      mkDs(sc[1], dist.map((d) => d["2"]), css("--pos-weak"), isDark ? white : dark),
      mkDs(sc[0], dist.map((d) => d["1"]), css("--pos-strong"), white),
    ];
    draw("likertChart", {
      type: "bar",
      data: { labels: L, datasets },
      options: {
        indexAxis: "y",
        scales: {
          x: { stacked: true, min: -60, max: 80, grid: { color: css("--grid") }, ticks: { callback: (v) => Math.abs(v) + "%" } },
          y: { stacked: true, grid: { display: false } },
        },
        plugins: {
          legend: { position: "bottom", labels: { filter: (item, data) => !data.datasets[item.datasetIndex].hideLegend, sort: (a, b) => [5, 4, 3, 1, 2].indexOf(a.datasetIndex) - [5, 4, 3, 1, 2].indexOf(b.datasetIndex) } },
          barLabels: { mode: "inside", min: 5 },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}：${fmt(c.dataset.label === "普通" ? dist[c.dataIndex]["3"] : Math.abs(c.raw))}` } },
        },
      },
    });
    setTable("likertChart", "各年度回答分布", ["年度", sc[0], sc[1], "普通", sc[2], sc[3], "無意見／拒答"],
      YEARS.map((y, i) => [y + " 年", ...["1", "2", "3", "4", "5", "98"].map((c) => fmt(dist[i][c]))]));
  }

  /* ---------------------------------------------------------------- 3. 族群 */
  function renderGroups() {
    const k = state.grpInd, d = state.grpDim, y = state.grpYear;
    const rows = D.breakdown[k][d][y];
    const dimMeta = D.meta.dims[d];
    if (!rows) {
      draw("groupChart", { type: "bar", data: { labels: [], datasets: [] }, options: {} });
      $("groupNote").textContent = `${y} 年沒有「${dimMeta.label}」資料。` + (dimMeta.note ? " " + dimMeta.note : "");
      setTable("groupChart", "族群比較", ["類別"], []);
      return;
    }
    const valid = rows.filter(Boolean);
    const labels = valid.map((r) => r.cat + (r.n < SMALL_N ? "＊" : ""));
    const overall = D.trend[k][y].p;
    draw("groupChart", {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: IND[k].label, data: valid.map((r) => r.p), ci: valid.map((r) => [r.lo, r.hi]), meta: valid,
          backgroundColor: css("--s1"), borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: "start",
          barPercentage: 0.7, categoryPercentage: 0.85,
        }],
      },
      options: {
        indexAxis: "y",
        layout: { padding: { right: 48 } },
        scales: { x: pctAxis(0, 100), y: { grid: { display: false } } },
        plugins: {
          legend: { display: false },
          ciWhiskers: { enabled: true }, barLabels: { mode: "end" },
          refLine: { value: overall, label: `全體 ${fmt(overall)}` },
          tooltip: { callbacks: { label: (c) => `${fmt(c.raw)}（${ciText(c.dataset.meta[c.dataIndex])}）` } },
        },
      },
    });
    const notes = [];
    if (valid.some((r) => r.n < SMALL_N)) notes.push(`＊樣本少於 ${SMALL_N} 人，估計較不穩定。`);
    if (dimMeta.note) notes.push(dimMeta.note);
    if (IND[k].note) notes.push(IND[k].note);
    $("groupNote").textContent = notes.join(" ");
    setTable("groupChart", `${y} 年 ${IND[k].label}，依${dimMeta.label}`, [dimMeta.label, "正面比例", "95% CI", "n"],
      valid.map((r) => [r.cat, fmt(r.p), `${r.lo.toFixed(1)}–${r.hi.toFixed(1)}`, fmtN(r.n)]));
  }

  /* ---------------------------------------------------------------- 4. 縣市 */
  const TILE_POS = { 1: [4, 1], 7: [5, 1], 21: [1, 2], 3: [3, 2], 2: [4, 2], 8: [2, 3], 10: [3, 3], 17: [4, 3],
    11: [2, 4], 4: [3, 4], 18: [4, 4], 12: [2, 5], 13: [3, 5], 14: [2, 6], 15: [3, 6], 20: [1, 7], 9: [2, 7],
    19: [4, 7], 5: [2, 8], 6: [3, 8], 16: [3, 9] };
  const RAMP = ["--ramp-0", "--ramp-1", "--ramp-2", "--ramp-3", "--ramp-4", "--ramp-5", "--ramp-6"];

  function renderCounty() {
    const k = state.ctyInd, y = state.ctyYear;
    const rows = D.county[k][y] || [];
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
    const vals = rows.map((r) => r.p);
    const min = Math.floor(Math.min(...vals)), max = Math.ceil(Math.max(...vals));
    const step = (v) => Math.min(RAMP.length - 1, Math.floor(((v - min) / Math.max(1e-6, max - min)) * RAMP.length));
    const map = $("tileMap");
    map.innerHTML = "";
    Object.entries(D.countyNames).forEach(([code, name]) => {
      const pos = TILE_POS[code]; const r = byCode[code];
      const b = document.createElement("button");
      b.type = "button"; b.className = "tile";
      b.style.gridColumn = pos[0]; b.style.gridRow = pos[1];
      if (!r) {
        b.classList.add("nodata"); b.disabled = true;
        b.innerHTML = `<span class="t-name">${shortCounty(name)}</span><span class="t-val">無資料</span>`;
        b.setAttribute("aria-label", `${name}：${y} 年無資料`);
      } else {
        const s = step(r.p);
        b.style.background = css(RAMP[s]);
        b.style.color = s >= 3 ? "#ffffff" : "#0b0b0b";
        if (r.n < SMALL_N) { b.classList.add("small-n"); b.style.borderColor = b.style.color; } // 虛線框與字同色，深淺格都看得到
        b.innerHTML = `<span class="t-name">${shortCounty(name)}</span><span class="t-val">${r.p.toFixed(0)}%</span>`;
        b.setAttribute("aria-label", `${name}：${fmt(r.p)}，${ciText(r)}`);
        b.setAttribute("aria-pressed", String(state.county === Number(code)));
        b.addEventListener("click", () => { state.county = state.county === Number(code) ? null : Number(code); renderCounty(); });
      }
      map.appendChild(b);
    });
    $("rampLegend").innerHTML = `<span>${min}%</span><span class="bar">${RAMP.map((v) => `<span style="background:${css(v)}"></span>`).join("")}</span><span>${max}%</span>`;

    // 右側明細
    const c = state.county, nat = D.trend[k][y];
    const cur = c ? byCode[c] : null;
    $("cdName").textContent = c ? D.countyNames[c] : "全國（請點選縣市）";
    $("cdValue").textContent = fmt(cur ? cur.p : nat.p);
    $("cdMeta").textContent = `${y} 年 ${IND[k].label}；${ciText(cur || nat)}` + (cur && cur.n < SMALL_N ? "（樣本少，估計不穩定）" : "");
    const series = (code) => YEARS.map((yy) => { const r = (D.county[k][yy] || []).find((x) => x.code === code); return r ? r : null; });
    const natS = YEARS.map((yy) => D.trend[k][yy]);
    const ds = [{ label: "全國", data: natS.map((s) => s.p), meta: natS, borderColor: css("--muted"), backgroundColor: css("--muted"), borderDash: [5, 4], borderWidth: 2, pointRadius: 3 }];
    if (c) {
      const cs = series(c);
      ds.unshift({ label: D.countyNames[c], data: cs.map((s) => (s ? s.p : null)), meta: cs, borderColor: css("--s1"), backgroundColor: css("--s1"), borderWidth: 2, pointRadius: 4, pointBorderColor: css("--surface"), pointBorderWidth: 2 });
    }
    draw("countyChart", {
      type: "line",
      data: { labels: YEARS.map(String), datasets: ds },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: { y: pctAxis(Math.max(0, Math.floor((Math.min(...ds.flatMap((d) => d.data.filter((v) => v != null))) - 10) / 10) * 10), 100), x: { grid: { display: false } } },
        plugins: {
          legend: { display: ds.length > 1, position: "bottom" },
          tooltip: { callbacks: { label: (cx) => `${cx.dataset.label}：${fmt(cx.raw)}（${ciText(cx.dataset.meta[cx.dataIndex])}）` } },
        },
      },
    });

    // 可排序資料表
    const sorted = [...rows].sort((a, b) => b.p - a.p);
    tables.countyTable = {
      caption: `${y} 年各縣市 ${IND[k].label}`, sortable: true,
      head: ["縣市", "正面比例", "95% CI", "n"],
      rows: sorted.map((r) => [D.countyNames[r.code] + (r.n < SMALL_N ? '<span class="flag">樣本少</span>' : ""), fmt(r.p), `${r.lo.toFixed(1)}–${r.hi.toFixed(1)}`, fmtN(r.n)]),
      raw: sorted,
    };
    const host = document.querySelector('[data-table-for="countyTable"]');
    if (host._wrap && !host._wrap.hidden) renderTable("countyTable");
  }
  // 縣市表排序
  document.querySelector('[data-table-for="countyTable"]').addEventListener("click", (e) => {
    const btn = e.target.closest("th button"); if (!btn) return;
    const t = tables.countyTable; const col = Number(btn.dataset.col);
    const keyFn = [(r) => D.countyNames[r.code], (r) => r.p, (r) => r.lo, (r) => r.n][col];
    t.dir = t.col === col ? -(t.dir || 1) : (col === 0 ? 1 : -1); t.col = col;
    t.raw.sort((a, b) => { const A = keyFn(a), B = keyFn(b); return (A > B ? 1 : A < B ? -1 : 0) * t.dir; });
    t.rows = t.raw.map((r) => [D.countyNames[r.code] + (r.n < SMALL_N ? '<span class="flag">樣本少</span>' : ""), fmt(r.p), `${r.lo.toFixed(1)}–${r.hi.toFixed(1)}`, fmtN(r.n)]);
    renderTable("countyTable");
    const th = document.querySelectorAll("#tbl-countyTable th[scope=col]")[col];
    if (th) th.setAttribute("aria-sort", t.dir > 0 ? "ascending" : "descending");
    const nb = document.querySelector(`#tbl-countyTable th button[data-col="${col}"]`); if (nb) nb.focus();
  });

  /* ---------------------------------------------------------------- 5. 法院使用經驗 */
  function hbar(id, labels, values, cis, metas, extra = {}) {
    draw(id, {
      type: "bar",
      data: { labels, datasets: [{ label: extra.label || "比例", data: values, ci: cis, meta: metas, backgroundColor: extra.color || css("--s1"), borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: "start", barPercentage: 0.72, categoryPercentage: 0.88 }] },
      options: {
        indexAxis: "y",
        layout: { padding: { right: 52 } },
        scales: { x: pctAxis(0, extra.max || 100), y: { grid: { display: false }, ticks: { autoSkip: false } } },
        plugins: {
          legend: { display: false }, ciWhiskers: { enabled: !!cis }, barLabels: { mode: "end" },
          tooltip: { callbacks: { label: (c) => `${fmt(c.raw)}（${ciText(c.dataset.meta[c.dataIndex])}）` } },
        },
      },
    });
  }
  function renderCourt() {
    const y = state.ctYear;
    // 漏斗
    const F = D.funnel[y], stages = ["到過法院", "打過官司", "有開庭經驗", "已有判決", "接受判決結果"];
    hbar("funnelChart", stages, stages.map((s) => F[s].p), null, stages.map((s) => F[s]), { max: 50 });
    const acc = F["接受判決（占已判決者）"];
    $("funnelNote").textContent = `已有判決者中，${fmt(acc.p)} 接受判決結果（${ciText(acc)}）。「有開庭經驗」與「已有判決」都是打過官司者的子集合，彼此並非包含關係。` + (y === 114 ? " 114 年開庭題改為「由法官主持的開庭」，與前幾年不完全可比。" : "");
    setTable("funnelChart", `${y} 年法院使用經驗`, ["階段", "占全體", "95% CI"], stages.map((s) => [s, fmt(F[s].p), `${F[s].lo.toFixed(1)}–${F[s].hi.toFixed(1)}`]));

    // 開庭滿意度
    const H = D.meta.hearingItems, hk = Object.keys(H);
    const hs = hk.map((k) => D.hearing[k][y]);
    hbar("hearingChart", hk.map((k) => H[k]), hs.map((s) => s.p), hs.map((s) => [s.lo, s.hi]), hs);
    $("hearingNote").textContent = `樣本約 ${fmtN(Math.max(...hs.map((s) => s.n)))} 人；細線為 95% 信賴區間。`;
    setTable("hearingChart", `${y} 年開庭經驗滿意度`, ["項目", "滿意比例", "95% CI", "n"], hk.map((k, i) => [H[k], fmt(hs[i].p), `${hs[i].lo.toFixed(1)}–${hs[i].hi.toFixed(1)}`, fmtN(hs[i].n)]));

    // 服務滿意度
    const svc = Object.entries(D.service).map(([name, byY]) => ({ name, s: byY[y] })).filter((x) => x.s).sort((a, b) => b.s.p - a.s.p);
    hbar("serviceChart", svc.map((x) => x.name), svc.map((x) => x.s.p), svc.map((x) => [x.s.lo, x.s.hi]), svc.map((x) => x.s));
    setTable("serviceChart", `${y} 年法院服務滿意度`, ["項目", "滿意比例", "95% CI", "n"], svc.map((x) => [x.name, fmt(x.s.p), `${x.s.lo.toFixed(1)}–${x.s.hi.toFixed(1)}`, fmtN(x.s.n)]));

    // 不願上法院原因
    const rs = D.reasons[y].filter((r) => r.label !== "其他");
    hbar("reasonChart", rs.map((r) => r.label.replace("/上法院太麻煩", "／太麻煩").replace("/", "／")), rs.map((r) => r.p), rs.map((r) => [r.lo, r.hi]), rs, { color: css("--s2") });
    setTable("reasonChart", `${y} 年不願上法院的原因`, ["原因", "比例", "n"], rs.map((r) => [r.label, fmt(r.p), fmtN(r.n)]));
  }

  function renderChange() {
    const cats = [["更好", "--pos-strong", "#ffffff"], ["相同／與預期相符", "--neutral", null], ["更差", "--neg-strong", "#ffffff"]];
    const isDark = getComputedStyle(document.documentElement).colorScheme === "dark";
    draw("changeChart", {
      type: "bar",
      data: {
        labels: YEARS.map((y) => y + " 年"),
        datasets: cats.map(([c, col, ink]) => ({
          label: c, data: YEARS.map((y) => D.change[y][c].p), meta: YEARS.map((y) => D.change[y][c]),
          backgroundColor: css(col), borderColor: css("--surface"), borderWidth: 1, labelInk: ink || (isDark ? "#ffffff" : "#0b0b0b"),
          barPercentage: 0.75, categoryPercentage: 0.9,
        })),
      },
      options: {
        indexAxis: "y",
        scales: { x: { stacked: true, min: 0, max: 100, grid: { color: css("--grid") }, ticks: { callback: (v) => v + "%" } }, y: { stacked: true, grid: { display: false } } },
        plugins: {
          legend: { position: "bottom" }, barLabels: { mode: "inside", min: 6 },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}：${fmt(c.raw)}（${ciText(c.dataset.meta[c.dataIndex])}）` } },
        },
      },
    });
    setTable("changeChart", "去過法院後觀感變化", ["年度", ...cats.map((c) => c[0]), "n"],
      YEARS.map((y) => [y + " 年", ...cats.map(([c]) => fmt(D.change[y][c].p)), fmtN(D.change[y]["更好"].n)]));
  }

  function buildMediaChips() {
    const host = $("mediaChips");
    host.innerHTML = "";
    Object.keys(D.media).forEach((m) => {
      const i = MEDIA_SLOT[m];
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip";
      b.innerHTML = `<span class="swatch" style="--c:${i != null ? slot(i) : css("--muted")};border-top-style:${i == null ? "dotted" : i === 0 ? "solid" : "dashed"}"></span>${m}`;
      b.setAttribute("aria-pressed", String(state.mediaSel.has(m)));
      b.addEventListener("click", () => {
        if (state.mediaSel.has(m)) { if (state.mediaSel.size > 1) state.mediaSel.delete(m); } else state.mediaSel.add(m);
        b.setAttribute("aria-pressed", String(state.mediaSel.has(m)));
        renderMedia();
      });
      host.appendChild(b);
    });
  }
  function renderMedia() {
    const keys = Object.keys(D.media).filter((m) => state.mediaSel.has(m));
    const datasets = keys.map((m, j) => {
      // 影音平台 110 年雖列選項但幾乎無人提及（111 年未列），圖上不畫 110 年以免誤導；資料表仍保留原值
      const meta = YEARS.map((y) => (m.startsWith("影音平台") && y === 110 ? null : D.media[m][y]));
      const i = MEDIA_SLOT[m];
      const color = i != null ? slot(i) : css("--muted");
      return {
        label: m, shortLabel: m.replace(/（.*）/, ""), data: meta.map((s) => (s ? s.p : null)), meta,
        borderColor: color, backgroundColor: color, borderWidth: 2,
        borderDash: i != null ? DASHES[i] : [2, 3], pointStyle: i != null ? POINTS[i] : "circle",
        pointRadius: 4, pointBorderColor: css("--surface"), pointBorderWidth: 2, spanGaps: false,
      };
    });
    draw("mediaChart", {
      type: "line",
      data: { labels: YEARS.map((y) => y + " 年"), datasets },
      options: {
        interaction: { mode: "index", intersect: false },
        layout: { padding: { right: endPad("mediaChart", 110), top: 8 } },
        scales: { y: pctAxis(0, 80), x: { grid: { display: false } } },
        plugins: {
          legend: { display: false }, endLabels: { enabled: true },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}：${c.raw == null ? "該年未列選項" : fmt(c.raw)}` } },
        },
      },
    });
    setTable("mediaChart", "資訊管道年度比例", ["管道", ...YEARS.map((y) => y + " 年")],
      Object.keys(D.media).map((m) => [m, ...YEARS.map((y) => (D.media[m][y] ? fmt(D.media[m][y].p) : "未列"))]));
  }

  function renderKnowledge() {
    const items = D.meta.knowItems;
    const shortL = ["偵查起訴非法官工作", "少年家事法庭不公開", "強制執行須顧債務人", "營業秘密可不公開審判"];
    const datasets = items.map((it, i) => {
      const meta = YEARS.map((y) => D.knowledge[i][y]);
      return {
        label: it, shortLabel: shortL[i], data: meta.map((s) => s.p), meta,
        borderColor: slot(i), backgroundColor: slot(i), borderWidth: 2, borderDash: DASHES[i],
        pointStyle: YEARS.map((y) => (i === 3 && y === 110 ? "rectRot" : POINTS[i])),
        pointRadius: YEARS.map((y) => (i === 3 && y === 110 ? 7 : 4)), pointBorderColor: css("--surface"), pointBorderWidth: 2,
      };
    });
    draw("knowChart", {
      type: "line",
      data: { labels: YEARS.map((y) => y + " 年"), datasets },
      options: {
        interaction: { mode: "index", intersect: false },
        layout: { padding: { right: endPad("knowChart", 150), top: 8 } },
        scales: { y: pctAxis(30, 90), x: { grid: { display: false } } },
        plugins: {
          legend: { display: false }, endLabels: { enabled: true },
          tooltip: { callbacks: { label: (c) => `${c.dataset.shortLabel}：答對 ${fmt(c.raw)}，不清楚 ${fmt(c.dataset.meta[c.dataIndex].unsure)}` } },
        },
      },
    });
    setTable("knowChart", "法律常識答對率", ["題目", ...YEARS.map((y) => y + " 年")],
      items.map((it, i) => [it, ...YEARS.map((y) => fmt(D.knowledge[i][y].p))]));
  }

  /* ---------------------------------------------------------------- 6. 說明 */
  function renderAbout() {
    $("methodText").textContent = D.meta.method;
    $("sampleTable").insertAdjacentHTML("beforeend",
      `<thead><tr><th scope="col">年度</th><th scope="col">樣本數</th><th scope="col">權重變數</th></tr></thead><tbody>` +
      YEARS.map((y) => `<tr><th scope="row">${y} 年</th><td>${fmtN(D.sample[y].n)}</td><td>${D.sample[y].weight}</td></tr>`).join("") + "</tbody>");
    $("notesList").innerHTML = D.meta.notes.map((n) => `<li>${n}</li>`).join("");
    $("genDate").textContent = ` 彙總資料產生日期：${D.meta.generated}。`;
  }

  /* ---------------------------------------------------------------- 初始化 */
  const indOpts = (keys) => keys.map((k) => ({ value: k, label: IND[k].label }));
  segmented("ovYear", yearOpts, () => state.ovYear, (v) => { state.ovYear = Number(v); renderKPIs(); });
  segmented("ctYear", yearOpts, () => state.ctYear, (v) => { state.ctYear = Number(v); renderCourt(); });
  segmented("grpDim", Object.entries(D.meta.dims).map(([k, v]) => ({ value: k, label: v.label })), () => state.grpDim, (v) => { state.grpDim = v; renderGroups(); });
  fillSelect("likertSel", indOpts(IND_KEYS), state.likert, (v) => { state.likert = v; renderLikert(); });
  fillSelect("grpInd", indOpts(D.meta.breakdownKeys), state.grpInd, (v) => { state.grpInd = v; renderGroups(); });
  fillSelect("grpYear", yearOpts, String(state.grpYear), (v) => { state.grpYear = Number(v); renderGroups(); });
  fillSelect("ctyInd", indOpts(D.meta.breakdownKeys), state.ctyInd, (v) => { state.ctyInd = v; renderCounty(); });
  fillSelect("ctyYear", yearOpts, String(state.ctyYear), (v) => { state.ctyYear = Number(v); renderCounty(); });

  function renderAll() {
    applyChartTheme();
    renderKPIs(); buildTrendChips(); renderTrend(); renderLikert(); renderGroups(); renderCounty();
    renderCourt(); renderChange(); buildMediaChips(); renderMedia(); renderKnowledge();
  }
  renderHighlights();
  renderAbout();
  renderAll();

  // 主題切換：跟隨系統，也可手動
  const root = document.documentElement;
  $("themeToggle").addEventListener("click", () => {
    const dark = getComputedStyle(root).colorScheme === "dark";
    const next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) {}
    renderAll();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (!root.getAttribute("data-theme")) renderAll(); });

  // 視窗寬度跨過線尾標註門檻時重繪折線圖（調整右側留白）
  let wide = $("trendChart").parentElement.clientWidth >= END_LABEL_MIN, rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const now = $("trendChart").parentElement.clientWidth >= END_LABEL_MIN;
      if (now !== wide) { wide = now; renderTrend(); renderMedia(); renderKnowledge(); }
    }, 200);
  });

  // 導覽列標示目前章節
  const links = [...document.querySelectorAll(".site-nav a")];
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      links.forEach((a) => a.setAttribute("aria-current", String(a.getAttribute("href") === "#" + e.target.id)));
    });
  }, { rootMargin: "-40% 0px -55% 0px" });
  document.querySelectorAll("main section[id]").forEach((s) => io.observe(s));
})();
