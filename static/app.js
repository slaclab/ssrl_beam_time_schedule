/* SSRL Beam Time calendar
 *
 * Time model: the schedule is a flat array of 8-hour shift "slots" per beam line,
 * slot = dayIndex * 3 + shift (0 = owl 23:00 prev. evening, 1 = day 07:00, 2 = swing 15:00).
 * A fractional slot position x maps to wall-clock time  startDate 00:00 + (8x - 1) h.
 * All wall-clock maths is done on UTC Date fields so DST never shifts the shift grid;
 * "now" is read in America/Los_Angeles (SLAC local time).
 */
(() => {
  "use strict";

  const TZ = "America/Los_Angeles";
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const PREFS_KEY = "beamtime.prefs.v1";
  const DATA_POLL_MS = 30 * 60e3;   // re-read the server cache every 30 min
  const CLOCK_TICK_MS = 60e3;       // move the "now" line every minute

  const CATEGORY_ORDER = ["user", "checkout", "change", "AP", "MA", "DOWN",
                          "PAAM", "FACI", "COMM", "RA", "unscheduled", "other"];
  const SHIFT_LABELS = ["Owl", "Day", "Swing"];
  const SHIFT_LABELS_SHORT = ["Owl", "Day", "Sw"];

  const $ = (sel) => document.querySelector(sel);
  const el = {
    timeline: $("#timeline"), wrap: $("#timeline-wrap"), message: $("#message"),
    blList: $("#bl-list"), blCount: $("#bl-count"), legend: $("#legend"),
    rangeLabel: $("#range-label"), periodSelect: $("#period-select"),
    prev: $("#prev"), next: $("#next"), today: $("#today"),
    status: $("#status-text"), refresh: $("#refresh"), tooltip: $("#tooltip"),
    viewTabs: document.querySelectorAll(".segmented [data-view]"),
  };

  const state = {
    data: null,
    startMs: 0,              // UTC ms of startDate 00:00 (used as wall clock)
    blocks: new Map(),       // beamline -> merged blocks over the whole schedule
    facilityBlocks: [],
    view: "week",
    weekStartDay: 0,         // day index of the Monday shown in week view
    periodIdx: 0,
    selected: null,          // Set of beamline ids (null = not yet initialised)
    rendered: [],            // blocks rendered in the current view (for tooltips)
  };

  // ---------------------------------------------------------------- preferences
  // Stored per browser for now; later this can move to a per-user server endpoint.

  const prefs = {
    load() {
      try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
    },
    save() {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({
          view: state.view,
          selected: state.selected ? [...state.selected] : null,
        }));
      } catch { /* storage unavailable: ignore */ }
    },
  };

  // ---------------------------------------------------------------- time helpers

  const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  const fmtMonthDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const fmtDom = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", day: "numeric" });
  const fmtDow = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
  const fmtYear = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric" });
  const fmtLocalTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

  const dayDate = (i) => new Date(state.startMs + i * DAY);
  const slotTime = (x) => new Date(state.startMs + (8 * x - 1) * HOUR);
  const weekday = (i) => dayDate(i).getUTCDay();           // 0 = Sun
  const mondayOf = (i) => i - ((weekday(i) + 6) % 7);

  function hhmm(d) {
    return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  }
  function fmtSlotTime(x) {
    const approx = Math.abs(x - Math.round(x)) > 1e-6 ? "≈ " : "";
    const d = slotTime(x);
    return `${approx}${fmtDate.format(d)}, ${hhmm(d)}`;
  }

  /** Current SLAC wall-clock time as a fractional slot position. */
  function nowSlot() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    return ((wall - state.startMs) / HOUR + 1) / 8;
  }

  // ---------------------------------------------------------------- data shaping

  function partKey(p) {
    switch (p.c) {
      case "user": return "u:" + p.p;
      case "other": return "o:" + p.t;
      default: return p.c;
    }
  }

  function partLabel(p) {
    const d = state.data;
    switch (p.c) {
      case "user": return `${p.p} ${d.proposals[p.p] || p.n || ""}`.trim();
      case "checkout": return "X-ray checkout";
      case "change": return "Changeover";
      case "unscheduled": return "Unscheduled";
      case "other": return p.t;
      default: return p.c;
    }
  }

  /** Merge consecutive (partial) shifts with the same content into blocks. */
  function buildBlocks(slots) {
    const out = [];
    slots.forEach((parts, s) => {
      const k = parts.length;
      parts.forEach((p, j) => {
        const a = s + j / k, b = s + (j + 1) / k, key = partKey(p);
        const last = out[out.length - 1];
        if (last && last.key === key && Math.abs(last.end - a) < 1e-9) {
          last.end = b;
        } else {
          out.push({ key, cat: p.c, part: p, start: a, end: b });
        }
      });
    });
    return out;
  }

  function buildFacilityBlocks(states) {
    const out = [];
    states.forEach((st, s) => {
      if (st !== "AP" && st !== "DOWN") return;
      const last = out[out.length - 1];
      if (last && last.cat === st && last.end === s) last.end = s + 1;
      else out.push({ key: "f:" + st, cat: st, part: { c: st }, start: s, end: s + 1, facility: true });
    });
    return out;
  }

  function setData(data) {
    state.data = data;
    const [y, m, d] = data.startDate.split("-").map(Number);
    state.startMs = Date.UTC(y, m - 1, d);
    state.blocks = new Map(data.beamlines.map((b) => [b.id, buildBlocks(data.cells[b.id] || [])]));
    state.facilityBlocks = buildFacilityBlocks(data.facility || []);
    if (state.selected) {
      // Drop beam lines that disappeared from the schedule.
      const ids = new Set(data.beamlines.map((b) => b.id));
      state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
    }
  }

  // ---------------------------------------------------------------- range / navigation

  const firstMonday = () => mondayOf(0);
  const lastMonday = () => mondayOf(state.data.days - 1);

  function currentRange() {
    if (state.view === "week") {
      const s0 = state.weekStartDay * 3;
      return { s0, s1: s0 + 21 };
    }
    const p = state.data.periods[state.periodIdx];
    return p ? { s0: p.start, s1: p.end, period: p } : { s0: 0, s1: 21 };
  }

  function goToday() {
    const x = nowSlot();
    const today = Math.floor((x * 8 - 1) / 24);   // calendar day index of "now"
    state.weekStartDay = clamp(mondayOf(today), firstMonday(), lastMonday());

    const periods = state.data.periods;
    let idx = periods.findIndex((p) => x >= p.runStart && x < p.runEnd);
    if (idx < 0) idx = periods.findIndex((p) => x >= p.start && x < p.end);
    if (idx < 0) {
      // Nearest upcoming period, else the last one.
      idx = periods.findIndex((p) => p.start > x);
      if (idx < 0) idx = periods.length - 1;
    }
    state.periodIdx = Math.max(0, idx);
  }

  function step(dir) {
    if (state.view === "week") {
      state.weekStartDay = clamp(state.weekStartDay + 7 * dir, firstMonday(), lastMonday());
    } else {
      state.periodIdx = clamp(state.periodIdx + dir, 0, state.data.periods.length - 1);
    }
    render();
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------------------------------------------------------------- sidebar

  function familyOf(id) { return id.replace(/[a-z]$/i, ""); }

  function renderSidebar() {
    const groups = [];
    for (const bl of state.data.beamlines) {
      const fam = familyOf(bl.id);
      const g = groups.find((x) => x.fam === fam);
      if (g) g.items.push(bl); else groups.push({ fam, items: [bl] });
    }

    el.blList.innerHTML = groups.map((g) => {
      if (g.items.length === 1) return `<li>${blCheckbox(g.items[0])}</li>`;
      return `<li>
        <label><input type="checkbox" data-family="${esc(g.fam)}"> ${esc(g.fam)}
          <span class="tag" title="End stations share beam time">${g.items.length} stations</span></label>
        <ul>${g.items.map((b) => `<li>${blCheckbox(b)}</li>`).join("")}</ul>
      </li>`;
    }).join("");
    syncSidebar();
  }

  function blCheckbox(bl) {
    return `<label><input type="checkbox" data-bl="${esc(bl.id)}"> ${esc(bl.id)}</label>`;
  }

  function syncSidebar() {
    el.blList.querySelectorAll("input[data-bl]").forEach((cb) => {
      cb.checked = state.selected.has(cb.dataset.bl);
    });
    el.blList.querySelectorAll("input[data-family]").forEach((cb) => {
      const members = state.data.beamlines.filter((b) => familyOf(b.id) === cb.dataset.family);
      const n = members.filter((b) => state.selected.has(b.id)).length;
      cb.checked = n === members.length;
      cb.indeterminate = n > 0 && n < members.length;
    });
    el.blCount.textContent = `${state.selected.size} of ${state.data.beamlines.length}`;
  }

  el.blList.addEventListener("change", (e) => {
    const cb = e.target;
    if (cb.dataset.bl) {
      cb.checked ? state.selected.add(cb.dataset.bl) : state.selected.delete(cb.dataset.bl);
    } else if (cb.dataset.family) {
      for (const b of state.data.beamlines) {
        if (familyOf(b.id) !== cb.dataset.family) continue;
        cb.checked ? state.selected.add(b.id) : state.selected.delete(b.id);
      }
    }
    syncSidebar();
    prefs.save();
    render();
  });

  $("#bl-all").addEventListener("click", () => {
    state.selected = new Set(state.data.beamlines.map((b) => b.id));
    syncSidebar(); prefs.save(); render();
  });
  $("#bl-none").addEventListener("click", () => {
    state.selected = new Set();
    syncSidebar(); prefs.save(); render();
  });
  const XAS_BEAMLINES = ["2-2", "4-3", "7-3", "9-3", "11-2", "14-3a"];
  $("#bl-xas").addEventListener("click", () => {
    const ids = new Set(state.data.beamlines.map((b) => b.id));
    state.selected = new Set(XAS_BEAMLINES.filter((id) => ids.has(id)));
    syncSidebar(); prefs.save(); render();
  });

  function renderLegend() {
    const cats = state.data.categories;
    el.legend.innerHTML = CATEGORY_ORDER.filter((c) => c in cats).map((c) => {
      const code = ["user", "checkout", "change", "unscheduled", "other"].includes(c) ? "" : c;
      const desc = cats[c] === c ? "" : cats[c];
      return `<li><span class="sw c-${c}"></span>${esc(desc || c)}${code && desc ? `<span class="code">${esc(code)}</span>` : ""}</li>`;
    }).join("");
  }

  // ---------------------------------------------------------------- timeline

  function render() {
    const d = state.data;
    if (!d) return;
    const { s0, s1, period } = currentRange();
    const n = s1 - s0;
    const pct = (x) => `${((x - s0) / n) * 100}%`;
    const wpct = (a, b) => `${((b - a) / n) * 100}%`;
    const nowX = nowSlot();
    const todayIdx = Math.floor((nowX * 8 - 1) / 24);

    // ---- header: days
    const d0 = Math.floor(s0 / 3), d1 = Math.ceil(s1 / 3);
    let days = "", shifts = "", grid = "";
    for (let di = d0; di < d1; di++) {
      const a = Math.max(di * 3, s0), b = Math.min(di * 3 + 3, s1);
      const date = dayDate(di);
      const roomy = b - a >= 2;
      days += `<div class="tl-day${di === todayIdx ? " is-today" : ""}" style="left:${pct(a)};width:${wpct(a, b)}">
        ${roomy ? `<span class="dow">${fmtDow.format(date)}</span>` : ""}
        <span class="dom">${roomy ? fmtMonthDay.format(date) : fmtDom.format(date)}</span></div>`;
    }
    // ---- header: shifts + background grid
    for (let s = s0; s < s1; s++) {
      const di = Math.floor(s / 3), dow = weekday(di);
      const cls = [s % 3 === 0 ? "day-start" : "", dow === 0 || dow === 6 ? "weekend" : "",
                   di === todayIdx ? "today" : ""].join(" ");
      const sh = d.shifts[s % 3];
      const shiftLabel = (n > 24 ? SHIFT_LABELS_SHORT : SHIFT_LABELS)[s % 3];
      shifts += `<div class="tl-shift ${s % 3 === 0 ? "day-start" : ""}" style="left:${pct(s)};width:${wpct(s, s + 1)}" title="${sh.label} ${sh.start}–${sh.end}">${shiftLabel}</div>`;
      grid += `<div class="col ${cls}" style="left:${pct(s)};width:${wpct(s, s + 1)}"></div>`;
    }
    if (nowX >= s0 && nowX < s1) grid += `<div class="now" style="left:${pct(nowX)}" title="Now"></div>`;

    // ---- rows
    state.rendered = [];
    const rowFor = (blocks, extra = {}) => blocks
      .filter((b) => b.end > s0 && b.start < s1)
      .map((b) => {
        const a = Math.max(b.start, s0), e = Math.min(b.end, s1);
        const idx = state.rendered.push({ ...b, ...extra }) - 1;
        const cls = ["blk", "c-" + b.cat,
          b.start < s0 ? "cont-left" : "", b.end > s1 ? "cont-right" : "",
          e - a < 0.6 ? "tiny" : ""].join(" ");
        const text = b.facility ? b.cat : partLabel(b.part);
        return `<div class="${cls}" data-i="${idx}" data-key="${esc(b.key)}" style="left:${pct(a)};width:${wpct(a, e)}">${e - a < 0.6 ? "" : esc(text)}</div>`;
      }).join("");

    const selected = d.beamlines.filter((b) => state.selected.has(b.id));
    const rows = selected.map((bl) => `
      <div class="tl-row">
        <div class="tl-label">${esc(bl.id)}${bl.shared ? `<span class="shared" title="Beam time is shared between end stations which cannot run simultaneously">⇄</span>` : ""}</div>
        <div class="tl-track">${rowFor(state.blocks.get(bl.id), { beamline: bl.id, shared: bl.shared })}</div>
      </div>`).join("");

    el.timeline.style.setProperty("--slots", n);
    el.timeline.innerHTML = `
      <div class="tl-head">
        <div class="tl-row tl-days-row" style="height:40px">
          <div class="tl-label">${esc(fmtYear.format(dayDate(d0)))}</div>
          <div class="tl-track tl-days">${days}</div>
        </div>
        <div class="tl-row" style="height:20px">
          <div class="tl-label"></div>
          <div class="tl-track tl-shifts">${shifts}</div>
        </div>
      </div>
      <div class="tl-body" style="position:relative">
        <div class="tl-grid">${grid}</div>
        <div class="tl-row tl-facility">
          <div class="tl-label" title="Facility-wide AP / DOWN">Facility</div>
          <div class="tl-track">${rowFor(state.facilityBlocks, { beamline: "Facility" })}</div>
        </div>
        ${rows}
      </div>`;

    el.message.hidden = selected.length > 0;
    el.message.textContent = "Select one or more beam lines in the sidebar.";

    renderToolbar(s0, s1, period);
  }

  function renderToolbar(s0, s1, period) {
    const isWeek = state.view === "week";
    el.viewTabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === state.view)));
    el.periodSelect.hidden = isWeek;
    el.rangeLabel.hidden = !isWeek;

    if (isWeek) {
      const a = dayDate(state.weekStartDay), b = dayDate(state.weekStartDay + 6);
      el.rangeLabel.textContent = `${fmtMonthDay.format(a)} – ${fmtMonthDay.format(b)}, ${fmtYear.format(b)}`;
      el.prev.disabled = state.weekStartDay <= firstMonday();
      el.next.disabled = state.weekStartDay >= lastMonday();
    } else {
      el.periodSelect.value = String(state.periodIdx);
      el.prev.disabled = state.periodIdx <= 0;
      el.next.disabled = state.periodIdx >= state.data.periods.length - 1;
    }
  }

  function renderPeriodSelect() {
    const label = (k) => ({ start: "Start", end: "End", AP: "AP", DOWN: "DOWN" }[k] || k);
    el.periodSelect.innerHTML = state.data.periods.map((p, i) => {
      const a = slotTime(p.start), b = slotTime(p.end - 0.001);
      const beamDays = ((p.runEnd - p.runStart) / 3).toFixed(1);
      return `<option value="${i}">${fmtMonthDay.format(a)} – ${fmtMonthDay.format(b)} · ${label(p.from)} → ${label(p.to)} · ${beamDays} d beam</option>`;
    }).join("");
  }

  // ---------------------------------------------------------------- tooltip + highlight

  function showTooltip(blk, evt) {
    const b = state.rendered[+blk.dataset.i];
    if (!b) return;
    const d = state.data, p = b.part;
    const shiftsLen = b.end - b.start;
    const len = shiftsLen >= 3 ? `${+shiftsLen.toFixed(2)} shifts (${+(shiftsLen / 3).toFixed(1)} days)` :
                                 `${+shiftsLen.toFixed(2)} shift${shiftsLen === 1 ? "" : "s"} (${+(shiftsLen * 8).toFixed(1)} h)`;
    let title = b.facility ? d.categories[b.cat] || b.cat : partLabel(p);
    let rows = "";
    if (p.c === "user") {
      title = d.proposals[p.p] || p.n || "Proposal " + p.p;
      rows += `<dt>Proposal</dt><dd>${esc(p.p)}</dd>`;
    }
    rows += `<dt>Start</dt><dd>${fmtSlotTime(b.start)}</dd>`;
    rows += `<dt>End</dt><dd>${fmtSlotTime(b.end)}</dd>`;
    rows += `<dt>Length</dt><dd>${len}</dd>`;
    const sub = [b.facility ? "Facility-wide" : d.categories[b.cat] || b.cat,
                 b.facility ? "" : "BL " + b.beamline].filter(Boolean).join(" · ");
    el.tooltip.innerHTML = `<div class="tt-title">${esc(title)}</div><div class="tt-sub">${esc(sub)}</div>
      <dl>${rows}</dl>${b.shared ? `<div class="tt-sub" style="margin:6px 0 0">Beam time shared between end stations</div>` : ""}`;
    el.tooltip.hidden = false;
    moveTooltip(evt);
  }

  function moveTooltip(evt) {
    const t = el.tooltip, pad = 14;
    const r = t.getBoundingClientRect();
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
    t.style.left = Math.max(8, x) + "px";
    t.style.top = Math.max(8, y) + "px";
  }

  function hideTooltip() {
    el.tooltip.hidden = true;
    el.timeline.classList.remove("highlighting");
    el.timeline.querySelectorAll(".blk.hl").forEach((b) => b.classList.remove("hl"));
  }

  el.timeline.addEventListener("mouseover", (e) => {
    const blk = e.target.closest(".blk");
    if (!blk) return hideTooltip();
    showTooltip(blk, e);
    const key = blk.dataset.key;
    if (key.startsWith("u:")) {
      el.timeline.classList.add("highlighting");
      el.timeline.querySelectorAll(".blk").forEach((b) => b.classList.toggle("hl", b.dataset.key === key));
    }
  });
  el.timeline.addEventListener("mousemove", (e) => { if (!el.tooltip.hidden) moveTooltip(e); });
  el.timeline.addEventListener("mouseleave", hideTooltip);
  el.wrap.addEventListener("scroll", hideTooltip, { passive: true });

  // ---------------------------------------------------------------- status + loading

  function renderStatus() {
    const d = state.data;
    const fetched = d.fetchedAt ? fmtLocalTime.format(new Date(d.fetchedAt)) : "—";
    el.status.innerHTML = `Schedule of ${esc(d.sourceGenerated || "?")} · checked ${esc(fetched)}` +
      (d.lastError ? ` · <span class="warn" title="${esc(d.lastError)}">⚠ last update failed</span>` : "");
  }

  async function loadData(force = false) {
    const res = await fetch(force ? "/api/refresh" : "/api/schedule",
                            { method: force ? "POST" : "GET", cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function applyData(data, { reposition }) {
    setData(data);
    if (!state.selected) state.selected = new Set(data.beamlines.map((b) => b.id));
    renderSidebar();
    renderLegend();
    renderPeriodSelect();
    if (reposition) goToday();
    state.weekStartDay = clamp(state.weekStartDay, firstMonday(), lastMonday());
    state.periodIdx = clamp(state.periodIdx, 0, Math.max(0, data.periods.length - 1));
    renderStatus();
    render();
  }

  async function refresh(force) {
    el.refresh.classList.add("spinning");
    try {
      applyData(await loadData(force), { reposition: false });
    } catch (err) {
      el.status.innerHTML = `<span class="warn">Refresh failed: ${esc(err.message)}</span>`;
    } finally {
      el.refresh.classList.remove("spinning");
    }
  }

  // ---------------------------------------------------------------- wiring

  el.prev.addEventListener("click", () => step(-1));
  el.next.addEventListener("click", () => step(1));
  el.today.addEventListener("click", () => { goToday(); render(); });
  el.refresh.addEventListener("click", () => refresh(true));
  el.periodSelect.addEventListener("change", () => { state.periodIdx = +el.periodSelect.value; render(); });
  el.viewTabs.forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));

  function setView(v) {
    if (state.view === v) return;
    state.view = v;
    prefs.save();
    history.replaceState(null, "", "#" + v);
    render();
  }

  document.addEventListener("keydown", (e) => {
    if (!state.data || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest("input, select, textarea")) return;
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "t" || e.key === "T") { goToday(); render(); }
    else if (e.key === "w" || e.key === "W") setView("week");
    else if (e.key === "r" || e.key === "R") setView("run");
  });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function init() {
    const saved = prefs.load();
    if (saved.view === "week" || saved.view === "run") state.view = saved.view;
    const hashView = location.hash.slice(1);
    if (hashView === "week" || hashView === "run") state.view = hashView;
    if (Array.isArray(saved.selected)) state.selected = new Set(saved.selected);
    try {
      applyData(await loadData(false), { reposition: true });
    } catch (err) {
      el.status.textContent = "";
      el.message.hidden = false;
      el.message.textContent = `Could not load the schedule: ${err.message}`;
      return;
    }
    setInterval(render, CLOCK_TICK_MS);
    setInterval(() => refresh(false), DATA_POLL_MS);
  }

  init();
})();
