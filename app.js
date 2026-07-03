/* ============================================================
   Blind Designs Delivery Optimiser — app logic
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- Address book: uploaded copy overrides bundled ---------------- */
  try {
    const stored = JSON.parse(localStorage.getItem('bd_addressbook') || 'null');
    if (stored && stored.length) window.CUSTOMERS = stored;
  } catch (e) { /* ignore */ }
  window.CUSTOMERS = window.CUSTOMERS || [];

  /* ---------------- Settings & state ---------------- */
  const DEFAULT_SETTINGS = {
    apiKey: '',
    depot: { ...window.DEPOT_DEFAULT, geocoded: false },
    departTime: '09:00',
    targetReturn: '15:00',
    hardReturn: '16:00',
    serviceMin: 15,
    leewayPct: 12,
    schedulePreset: 'current',
    scheduleCustom: null,
    vanNames: ['Van 1', 'Van 2', 'Van 3 (overflow)']
  };
  const VAN_COLORS = ['#1f5fa8', '#e8862d', '#2a9d8f'];

  let settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('bd_settings') || '{}') };
  settings.depot = { ...DEFAULT_SETTINGS.depot, ...(settings.depot || {}) };
  const saveSettings = () => localStorage.setItem('bd_settings', JSON.stringify(settings));

  const todayISO = () => new Date().toISOString().slice(0, 10);
  let planDate = todayISO();

  const dayKey = d => 'bd_day_' + d;
  const blankDay = () => ({ areas: null, stops: [], result: null, vansUsed: 2 });
  let day = loadDay(planDate);
  function loadDay(d) { return { ...blankDay(), ...JSON.parse(localStorage.getItem(dayKey(d)) || '{}') }; }
  function saveDay() { localStorage.setItem(dayKey(planDate), JSON.stringify(day)); }

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, bad) {
    const t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  /* ---------------- Schedule helpers ---------------- */
  function activeSchedule() {
    return settings.scheduleCustom || window.SCHEDULES[settings.schedulePreset] || window.SCHEDULES.current;
  }
  function areasForDate(dateStr) {
    const dow = new Date(dateStr + 'T12:00:00').getDay(); // 1=Mon..5=Fri
    const sched = activeSchedule();
    return Object.keys(window.REGIONS).filter(r => (sched[r] || []).includes(dow));
  }

  /* ---------------- Region / geometry helpers ---------------- */
  function pointInPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      if (((yi > pt.lat) !== (yj > pt.lat)) && (pt.lng < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function regionOfPoint(pt) {
    for (const [name, r] of Object.entries(window.REGIONS)) if (pointInPoly(pt, r.poly)) return name;
    return null;
  }
  function regionCentroid(name) {
    const p = (window.REGIONS[name] || {}).poly;
    if (!p) return null;
    return { lat: p.reduce((a, q) => a + q[0], 0) / p.length, lng: p.reduce((a, q) => a + q[1], 0) / p.length };
  }
  // deterministic jitter so approx stops don't stack on one point
  function jitter(seedStr, span) {
    let h = 2166136261;
    for (const c of seedStr) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    const a = ((h >>> 8) % 1000) / 1000 - 0.5, b = ((h >>> 18) % 1000) / 1000 - 0.5;
    return { dlat: a * span, dlng: b * span };
  }

  /* ---------------- Stops ---------------- */
  let stopSeq = 1;
  function makeStop(o) {
    return {
      id: 's' + Date.now().toString(36) + (stopSeq++),
      code: o.code || '', name: o.name || 'Unknown', address: o.address || '',
      area: o.area || '', phone: o.phone || '', orders: o.orders || [],
      lat: o.lat, lng: o.lng, geo: o.geo || 'none', // none|exact|approx|suspect
      done: false
    };
  }
  function addStopFromCustomer(c) {
    if (day.stops.some(s => s.code && s.code === c.code)) { toast(c.name + ' is already on the list'); return; }
    const cached = window.GoogleRouting.cachedCoords(c.address);
    day.stops.push(makeStop({
      code: c.code, name: c.name, address: c.address, area: c.area,
      phone: c.cell || c.tel || '',
      lat: cached ? cached.lat : undefined, lng: cached ? cached.lng : undefined,
      geo: cached ? 'exact' : 'none'
    }));
    day.result = null; saveDay(); renderPlan();
  }

  /* ---------------- Import ---------------- */
  const COL_ALIASES = {
    code: ['customer code', 'code', 'cust code', 'account'],
    name: ['customer name', 'name', 'customer'],
    address: ['delivery address', 'address', 'ship to'],
    area: ['geographical area', 'geo area', 'area', 'region'],
    order: ['order number', 'order no', 'order', 'invoice num', 'invoice number', 'invoice'],
    date: ['delivery date'],
  };
  function findCol(headers, key) {
    const H = headers.map(h => String(h || '').toLowerCase().trim());
    for (const a of COL_ALIASES[key]) { const i = H.indexOf(a); if (i >= 0) return i; }
    for (const a of COL_ALIASES[key]) { const i = H.findIndex(h => h.includes(a)); if (i >= 0) return i; }
    return -1;
  }
  const cleanAddr = s => String(s || '').replace(/_x000D_/g, ' ').replace(/[\r\n]+/g, ', ').replace(/\s*,\s*,+/g, ', ').replace(/\s+/g, ' ').trim().replace(/^,|,$/g, '');
  function excelDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400000)); return d.toISOString().slice(0, 10); }
    const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }

  function handleImportFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
        // locate header row
        let hi = rows.findIndex(r => (r || []).some(c => /customer (name|code)/i.test(String(c || ''))));
        if (hi < 0) hi = 0;
        const headers = rows[hi] || [];
        const col = {}; Object.keys(COL_ALIASES).forEach(k => col[k] = findCol(headers, k));
        if (col.name < 0 && col.code < 0) { toast('Could not find a Customer Name/Code column', true); return; }
        const data = rows.slice(hi + 1).filter(r => r && (r[col.name] || r[col.code]));
        // date filtering
        let filtered = data, note = '';
        if (col.date >= 0) {
          const dates = new Set(data.map(r => excelDate(r[col.date])).filter(Boolean));
          if (dates.size > 1) {
            const match = data.filter(r => excelDate(r[col.date]) === planDate);
            if (match.length) { filtered = match; note = match.length + ' rows dated ' + planDate + ' (of ' + data.length + ' in file)'; }
            else { note = 'No rows dated ' + planDate + ' — importing all ' + data.length + ' rows'; }
          }
        }
        // dedupe customer -> merge orders
        const map = new Map();
        for (const r of filtered) {
          const code = String(r[col.code] || '').trim();
          const name = String(r[col.name] || '').trim();
          const k = code || name.toLowerCase();
          if (!map.has(k)) map.set(k, { code, name, address: cleanAddr(col.address >= 0 ? r[col.address] : ''), area: col.area >= 0 ? String(r[col.area] || '').trim() : '', orders: [] });
          const ord = col.order >= 0 ? String(r[col.order] || '').trim() : '';
          if (ord && !map.get(k).orders.includes(ord)) map.get(k).orders.push(ord);
        }
        let added = 0, matched = 0;
        for (const rec of map.values()) {
          if (day.stops.some(s => (rec.code && s.code === rec.code) || (!rec.code && s.name.toLowerCase() === rec.name.toLowerCase()))) continue;
          const cust = window.CUSTOMERS.find(c => c.code === rec.code) ||
                       window.CUSTOMERS.find(c => c.name.toLowerCase() === rec.name.toLowerCase());
          if (cust) matched++;
          const address = rec.address || (cust ? cust.address : '');
          const cached = window.GoogleRouting.cachedCoords(address);
          day.stops.push(makeStop({
            code: rec.code || (cust ? cust.code : ''), name: rec.name || (cust ? cust.name : ''),
            address, area: rec.area || (cust ? cust.area : ''),
            phone: cust ? (cust.cell || cust.tel || '') : '', orders: rec.orders,
            lat: cached ? cached.lat : undefined, lng: cached ? cached.lng : undefined,
            geo: cached ? 'exact' : 'none'
          }));
          added++;
        }
        day.result = null; saveDay(); renderPlan();
        toast('Imported ' + added + ' stops (' + matched + ' matched to address book)' + (note ? ' · ' + note : ''));
      } catch (err) { console.error(err); toast('Import failed: ' + err.message, true); }
    };
    reader.readAsArrayBuffer(file);
  }

  /* ---------------- Optimisation ---------------- */
  const busy = on => { $('#optimiseBtn').disabled = on; $('#optStatus').textContent = on || ''; };

  function activeStops() {
    const areas = day.areas || {};
    return day.stops.filter(s => areas[s.area || 'Unassigned'] !== false);
  }

  async function ensureCoords(stops) {
    const missing = stops.filter(s => s.lat == null);
    if (!missing.length) return;
    if (settings.apiKey) {
      await window.GoogleRouting.loadApi(settings.apiKey);
      // depot precise geocode once
      if (!settings.depot.geocoded) {
        const g = await window.GoogleRouting.geocode(settings.depot.address);
        if (g && !g.suspect) { settings.depot.lat = g.lat; settings.depot.lng = g.lng; settings.depot.geocoded = true; saveSettings(); }
      }
      let n = 0;
      for (const s of missing) {
        busy('Geocoding ' + (++n) + '/' + missing.length + ' — ' + s.name);
        if (!s.address) { s.geo = 'none'; continue; }
        const g = await window.GoogleRouting.geocode(s.address, s.area);
        if (g && !g.suspect) {
          s.lat = g.lat; s.lng = g.lng; s.geo = 'exact';
          if (!s.area) s.area = regionOfPoint(s) || s.area;
        } else if (g) { s.lat = g.lat; s.lng = g.lng; s.geo = 'suspect'; }
        else s.geo = 'failed';
      }
    }
    // fallback: approximate by region centroid + deterministic jitter
    for (const s of stops) {
      if (s.lat == null) {
        const c = regionCentroid(s.area) || settings.depot;
        const j = jitter(s.code || s.name, 0.06);
        s.lat = c.lat + j.dlat; s.lng = c.lng + j.dlng; s.geo = s.geo === 'failed' ? 'failed' : 'approx';
      }
    }
    saveDay();
  }

  async function routeVans(stops, k) {
    const O = window.Optimiser;
    const when = new Date(planDate + 'T' + settings.departTime + ':00');
    const groups = O.clusterStops(settings.depot, stops, k, settings.serviceMin, when)
      .sort((a, b) => {
        const cy = g => g.reduce((s, x) => s + x.lat, 0) / g.length;
        return cy(a) - cy(b); // ascending latitude: southernmost cluster first = Van 1 (JHB side)
      });
    const vans = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      let order = null, legsOverride = null;
      if (settings.apiKey && g.length <= 25) {
        try {
          await window.GoogleRouting.loadApi(settings.apiKey);
          busy('Routing van ' + (i + 1) + ' with live traffic…');
          const res = await window.GoogleRouting.directionsRoute(settings.depot, g, when);
          if (res) { order = res.order; legsOverride = res.legMinutes; }
        } catch (e) { console.warn(e); }
      }
      if (!order) { busy('Routing van ' + (i + 1) + '…'); order = O.optimiseOrder(settings.depot, g, when); }
      const timeline = O.buildTimeline(settings.depot, g, order,
        { date: planDate, departTime: settings.departTime, serviceMin: settings.serviceMin, leewayPct: settings.leewayPct }, legsOverride);
      const orderedStops = order.map(ix => g[ix]);
      vans.push({
        name: settings.vanNames[i] || 'Van ' + (i + 1),
        color: VAN_COLORS[i % VAN_COLORS.length],
        stopIds: orderedStops.map(s => s.id),
        live: !!legsOverride,
        links: O.mapsLinks(settings.depot, orderedStops),
        tl: {
          driveMin: timeline.driveMin, km: timeline.km,
          etas: timeline.seq.map(l => +l.eta),
          returnAt: +timeline.returnAt, returnBy: +timeline.returnBy
        }
      });
    }
    return vans;
  }

  const hardReturnDate = () => new Date(planDate + 'T' + settings.hardReturn + ':00');
  const targetReturnDate = () => new Date(planDate + 'T' + settings.targetReturn + ':00');

  async function optimise(forceK) {
    const stops = activeStops().filter(s => !s.done);
    if (stops.length === 0) { toast('No active stops to optimise', true); return; }
    busy('Preparing…');
    try {
      await ensureCoords(stops);
      let k = forceK || day.vansUsed || 2;
      if (!forceK) {
        k = 2;
        const two = await routeVans(stops, Math.min(2, stops.length));
        const lateTwo = two.some(v => v.tl.returnAt > +hardReturnDate());
        day.result = { vans: two, alt: null };
        if (lateTwo && stops.length >= 3) {
          busy('2 vans run late — computing 3-van option…');
          const three = await routeVans(stops, 3);
          day.result.alt = { vans: three, k: 3 };
        } else if (stops.length <= 8) {
          const one = await routeVans(stops, 1);
          if (one[0] && one[0].tl.returnAt <= +targetReturnDate()) day.result.alt = { vans: one, k: 1 };
        }
        day.vansUsed = 2;
      } else {
        day.result = { vans: await routeVans(stops, Math.min(forceK, stops.length)), alt: null };
        day.vansUsed = forceK;
      }
      saveDay(); renderPlan();
      toast('Routes optimised' + (settings.apiKey ? ' with live traffic' : ' (offline model — add a Google key for live traffic)'));
    } catch (e) {
      console.error(e); toast('Optimisation failed: ' + e.message, true);
    } finally { busy(false); $('#optStatus').textContent = ''; }
  }

  /* ---------------- Rendering ---------------- */
  const fmtT = ms => new Date(ms).toTimeString().slice(0, 5);

  function renderAreas() {
    const scheduled = areasForDate(planDate);
    if (!day.areas) {
      day.areas = {};
      Object.keys(window.REGIONS).forEach(r => day.areas[r] = scheduled.includes(r));
      saveDay();
    }
    const counts = {};
    day.stops.forEach(s => { const a = s.area || 'Unassigned'; counts[a] = (counts[a] || 0) + 1; });
    const chip = (r, sched) => {
      const on = day.areas[r] !== false;
      const c = (window.REGIONS[r] || {}).color || '#888';
      return '<label class="area-chip' + (on ? ' on' : '') + (sched ? '' : ' offsched') + '" style="--c:' + c + '">' +
        '<input type="checkbox" data-area="' + esc(r) + '" ' + (on ? 'checked' : '') + '>' +
        '<span class="dot"></span>' + esc(r.replace('Pretoria', 'Pta')) +
        (counts[r] ? ' <b>' + counts[r] + '</b>' : '') +
        (sched ? '' : ' <i>off-schedule</i>') + '</label>';
    };
    $('#areaChips').innerHTML =
      scheduled.map(r => chip(r, true)).join('') +
      Object.keys(window.REGIONS).filter(r => !scheduled.includes(r)).map(r => chip(r, false)).join('') +
      (counts['Unassigned'] ? chip('Unassigned', false) : '');
    $$('#areaChips input').forEach(i => i.onchange = () => {
      day.areas[i.dataset.area] = i.checked; day.result = null; saveDay(); renderPlan();
    });
    const dow = new Date(planDate + 'T12:00:00').getDay();
    $('#schedNote').textContent = (dow === 0 || dow === 6)
      ? 'Weekend — no scheduled regions. Tick any area you plan to cover.'
      : 'Scheduled today (' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow] + ', ' + settings.schedulePreset + ' schedule). Tick/untick to adjust.';
  }

  const GEO_BADGE = { exact: '', approx: '<span class="badge warn" title="Approximate location — add Google key & re-optimise for precision">~</span>', suspect: '<span class="badge bad" title="Geocode looks wrong — check address">?</span>', failed: '<span class="badge bad" title="Could not geocode">!</span>', none: '' };

  function renderStops() {
    const el = $('#stopList');
    if (!day.stops.length) { el.innerHTML = '<div class="empty">No stops yet — import today\'s orders or add customers.</div>'; return; }
    const areasOff = day.stops.filter(s => (day.areas || {})[s.area || 'Unassigned'] === false);
    el.innerHTML = day.stops.map(s => {
      const off = (day.areas || {})[s.area || 'Unassigned'] === false;
      const c = (window.REGIONS[s.area] || {}).color || '#999';
      return '<div class="stop-row' + (off ? ' held' : '') + (s.done ? ' done' : '') + '">' +
        '<span class="rdot" style="background:' + c + '" title="' + esc(s.area) + '"></span>' +
        '<div class="s-main"><b>' + esc(s.name) + '</b>' + (GEO_BADGE[s.geo] || '') +
        (s.orders.length ? ' <span class="ords">' + esc(s.orders.join(', ')) + '</span>' : '') +
        '<div class="s-addr">' + esc(s.address || 'no address — will be skipped') + '</div></div>' +
        (off ? '<span class="heldtag">area off</span>' : '') +
        '<button class="mini del" data-id="' + s.id + '" title="Remove">✕</button></div>';
    }).join('');
    $$('#stopList .del').forEach(b => b.onclick = () => {
      day.stops = day.stops.filter(s => s.id !== b.dataset.id);
      day.result = null; saveDay(); renderPlan();
    });
    $('#stopCount').textContent = day.stops.length + ' stops (' + (day.stops.length - areasOff.length) + ' active)';
  }

  function vanCard(v, vi, editable) {
    const stopsById = Object.fromEntries(day.stops.map(s => [s.id, s]));
    const late = v.tl.returnAt > +hardReturnDate() ? 'bad' : (v.tl.returnAt > +targetReturnDate() ? 'warn' : 'ok');
    const rows = v.stopIds.map((id, i) => {
      const s = stopsById[id]; if (!s) return '';
      return '<div class="van-stop' + (s.done ? ' done' : '') + '">' +
        '<input type="checkbox" class="tick" data-id="' + id + '" ' + (s.done ? 'checked' : '') + ' title="Mark delivered">' +
        '<span class="seq">' + (i + 1) + '</span><span class="eta">' + fmtT(v.tl.etas[i]) + '</span>' +
        '<div class="vs-main"><b>' + esc(s.name) + '</b><div class="s-addr">' + esc(s.address) + '</div></div>' +
        (editable && day.result.vans.length > 1 ? '<button class="mini mv" data-id="' + id + '" data-van="' + vi + '" title="Move to other van">⇄</button>' : '') +
        '</div>';
    }).join('');
    return '<div class="van-card" style="--vc:' + v.color + '">' +
      '<div class="van-head"><span class="vdot"></span><b>' + esc(v.name) + '</b>' +
      '<span class="vmeta">' + v.stopIds.length + ' stops · ' + Math.round(v.tl.km) + ' km · drive ' + Math.round(v.tl.driveMin) + 'm' + (v.live ? ' · <span title="Google live traffic">🚦 live</span>' : '') + '</span>' +
      '<span class="ret ' + late + '">back ' + fmtT(v.tl.returnAt) + ' → aim ' + fmtT(v.tl.returnBy) + '</span></div>' +
      rows +
      '<div class="van-actions"><button class="btn small pdf" data-van="' + vi + '">📄 Delivery sheet (PDF)</button>' +
      v.links.map((l, i) => '<a class="btn small ghost" target="_blank" rel="noopener" href="' + l + '">🗺 Maps' + (v.links.length > 1 ? ' leg ' + (i + 1) : '') + '</a>').join('') +
      '</div></div>';
  }

  function renderResult() {
    const el = $('#result');
    if (!day.result) { el.innerHTML = ''; $('#altBanner').innerHTML = ''; return; }
    el.innerHTML = day.result.vans.map((v, i) => vanCard(v, i, true)).join('');
    // banner
    const alt = day.result.alt;
    const anyLate = day.result.vans.some(v => v.tl.returnAt > +hardReturnDate());
    let banner = '';
    if (alt && alt.k === 3) {
      banner = '<div class="banner bad"><b>⚠ ' + day.result.vans.length + '-van plan misses the ' + settings.hardReturn + ' cut-off</b> (' +
        day.result.vans.map(v => esc(v.name) + ' back ' + fmtT(v.tl.returnAt)).join(', ') + '). ' +
        'With 3 vans: ' + alt.vans.map(v => fmtT(v.tl.returnAt)).join(' / ') + '. ' +
        '<button class="btn small" id="useAlt">Bring up Van 3</button> <button class="btn small ghost" id="keepPlan">Keep ' + day.result.vans.length + ' vans</button></div>';
    } else if (alt && alt.k === 1) {
      banner = '<div class="banner ok"><b>💡 Light day:</b> all stops fit in one van, back by ' + fmtT(alt.vans[0].tl.returnAt) +
        '. <button class="btn small" id="useAlt">Use 1 van</button> <button class="btn small ghost" id="keepPlan">Keep 2</button></div>';
    } else if (anyLate) {
      banner = '<div class="banner bad"><b>⚠ A route misses ' + settings.hardReturn + '.</b> Consider moving stops between vans (⇄) or dropping low-priority stops.</div>';
    }
    $('#altBanner').innerHTML = banner;
    if ($('#useAlt')) $('#useAlt').onclick = () => { day.result = { vans: day.result.alt.vans, alt: null }; day.vansUsed = alt.k; saveDay(); renderPlan(); };
    if ($('#keepPlan')) $('#keepPlan').onclick = () => { day.result.alt = null; saveDay(); renderPlan(); };

    // wire ticks / moves / pdf
    $$('#result .tick').forEach(t => t.onchange = () => {
      const s = day.stops.find(x => x.id === t.dataset.id); if (s) { s.done = t.checked; saveDay(); renderPlan(); }
    });
    $$('#result .mv').forEach(b => b.onclick = () => {
      const from = +b.dataset.van, id = b.dataset.id;
      const to = (from + 1) % day.result.vans.length;
      day.result.vans[from].stopIds = day.result.vans[from].stopIds.filter(x => x !== id);
      day.result.vans[to].stopIds.push(id);
      toast('Stop moved — press “Re-optimise” to re-sequence & update ETAs');
      saveDay(); renderPlan();
    });
    $$('#result .pdf').forEach(b => b.onclick = () => downloadVanPdf(+b.dataset.van));
  }

  function downloadVanPdf(vi) {
    const v = day.result.vans[vi];
    const stopsById = Object.fromEntries(day.stops.map(s => [s.id, s]));
    const ordered = v.stopIds.map(id => stopsById[id]).filter(Boolean);
    const seq = ordered.map((s, i) => ({ stop: s, eta: new Date(v.tl.etas[i]) }));
    window.PdfGen.vanPdf({
      name: v.name, color: v.color, stops: ordered, links: v.links,
      timeline: { seq, driveMin: v.tl.driveMin, km: v.tl.km, returnAt: new Date(v.tl.returnAt), returnBy: new Date(v.tl.returnBy) }
    }, { date: planDate, departTime: settings.departTime, leewayPct: settings.leewayPct, hardReturn: settings.hardReturn, serviceMin: settings.serviceMin });
  }

  function renderPlan() { renderAreas(); renderStops(); renderResult(); }

  /* ---------------- Address book tab ---------------- */
  function renderBook() {
    const q = ($('#bookSearch').value || '').toLowerCase();
    const list = window.CUSTOMERS.filter(c => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q) || (c.area || '').toLowerCase().includes(q)).slice(0, 60);
    $('#bookList').innerHTML = list.map(c => {
      const col = (window.REGIONS[c.area] || {}).color || '#999';
      return '<div class="book-row"><span class="rdot" style="background:' + col + '"></span>' +
        '<div class="s-main"><b>' + esc(c.name) + '</b> <span class="code">' + esc(c.code) + '</span>' +
        (c.freq ? '<span class="badge">' + c.freq + ' deliveries</span>' : '') +
        '<div class="s-addr">' + esc(c.address || 'no address on file') + (c.area ? ' · ' + esc(c.area) : '') + '</div></div>' +
        '<button class="mini add" data-code="' + esc(c.code) + '">+ Add</button></div>';
    }).join('') || '<div class="empty">No matches.</div>';
    $$('#bookList .add').forEach(b => b.onclick = () => {
      const c = window.CUSTOMERS.find(x => x.code === b.dataset.code);
      if (c) { addStopFromCustomer(c); toast(c.name + ' added to ' + planDate); }
    });
  }

  /* ---------------- Settings tab ---------------- */
  function renderSettings() {
    renderBookStatus();
    $('#setKey').value = settings.apiKey;
    $('#setDepot').value = settings.depot.address;
    $('#setDepart').value = settings.departTime;
    $('#setTarget').value = settings.targetReturn;
    $('#setHard').value = settings.hardReturn;
    $('#setService').value = settings.serviceMin;
    $('#setLeeway').value = settings.leewayPct;
    $('#van1').value = settings.vanNames[0]; $('#van2').value = settings.vanNames[1]; $('#van3').value = settings.vanNames[2];
    $$('input[name=preset]').forEach(r => r.checked = r.value === settings.schedulePreset);
    // schedule grid
    const sched = activeSchedule();
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    $('#schedGrid').innerHTML = '<table><tr><th></th>' + days.map(d => '<th>' + d + '</th>').join('') + '</tr>' +
      Object.keys(window.REGIONS).map(r => '<tr><td>' + esc(r.replace('Pretoria', 'Pta')) + '</td>' +
        days.map((_, di) => '<td><input type="checkbox" data-r="' + esc(r) + '" data-d="' + (di + 1) + '" ' + ((sched[r] || []).includes(di + 1) ? 'checked' : '') + '></td>').join('') + '</tr>').join('') + '</table>';
    $$('#schedGrid input').forEach(i => i.onchange = () => {
      const cur = JSON.parse(JSON.stringify(activeSchedule()));
      const r = i.dataset.r, d = +i.dataset.d;
      cur[r] = cur[r] || [];
      if (i.checked && !cur[r].includes(d)) cur[r].push(d);
      if (!i.checked) cur[r] = cur[r].filter(x => x !== d);
      settings.scheduleCustom = cur; saveSettings(); renderSettings();
      toast('Custom schedule saved (overrides preset)');
    });
    $('#customNote').style.display = settings.scheduleCustom ? '' : 'none';
  }

  function wireSettings() {
    $('#saveSettings').onclick = async () => {
      settings.apiKey = $('#setKey').value.trim();
      const newDepot = $('#setDepot').value.trim();
      if (newDepot !== settings.depot.address) settings.depot = { address: newDepot, lat: settings.depot.lat, lng: settings.depot.lng, geocoded: false };
      settings.departTime = $('#setDepart').value || '09:00';
      settings.targetReturn = $('#setTarget').value || '15:00';
      settings.hardReturn = $('#setHard').value || '16:00';
      settings.serviceMin = Math.max(1, +$('#setService').value || 15);
      settings.leewayPct = Math.max(0, +$('#setLeeway').value || 12);
      settings.vanNames = [$('#van1').value || 'Van 1', $('#van2').value || 'Van 2', $('#van3').value || 'Van 3 (overflow)'];
      saveSettings(); toast('Settings saved');
      if (settings.apiKey) {
        try { await window.GoogleRouting.loadApi(settings.apiKey); toast('Google Maps key OK ✓'); }
        catch (e) { toast(e.message, true); }
      }
      renderPlan();
    };
    $$('input[name=preset]').forEach(r => r.onchange = () => {
      settings.schedulePreset = r.value; settings.scheduleCustom = null; saveSettings(); renderSettings();
      day.areas = null; saveDay(); renderPlan();
    });
    $('#resetSched').onclick = () => { settings.scheduleCustom = null; saveSettings(); renderSettings(); day.areas = null; saveDay(); renderPlan(); };
    $('#clearGeo').onclick = () => { localStorage.removeItem('bd_geocache_v1'); toast('Geocode cache cleared'); };
    $('#geocodeAll').onclick = async () => {
      if (!settings.apiKey) { toast('Add a Google API key first', true); return; }
      try {
        await window.GoogleRouting.loadApi(settings.apiKey);
        const withAddr = window.CUSTOMERS.filter(c => c.address);
        let n = 0, ok = 0;
        for (const c of withAddr) {
          $('#geocodeAllStatus').textContent = 'Geocoding ' + (++n) + '/' + withAddr.length + '…';
          if (window.GoogleRouting.cachedCoords(c.address)) { ok++; continue; }
          const g = await window.GoogleRouting.geocode(c.address, c.area);
          if (g && !g.suspect) ok++;
        }
        $('#geocodeAllStatus').textContent = 'Done — ' + ok + '/' + withAddr.length + ' geocoded & cached on this device.';
      } catch (e) { toast(e.message, true); }
    };
  }

  /* ---------------- Address book upload (Settings) ---------------- */
  function parseAddressBook(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const sheetName = wb.SheetNames.find(n => /customer|address/i.test(n)) || wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true });
        let hi = rows.findIndex(r => (r || []).some(c => /^(code|name)$/i.test(String(c || '').trim())));
        if (hi < 0) hi = 0;
        const H = (rows[hi] || []).map(h => String(h || '').toLowerCase().trim());
        const ix = {
          code: H.findIndex(h => h === 'code' || h === 'customer code'),
          name: H.findIndex(h => h === 'name' || h === 'customer name'),
          area: H.findIndex(h => h.includes('geo') || h === 'area' || h.includes('geographical')),
          address: H.findIndex(h => h.includes('delivery address')),
          contact: H.findIndex(h => h.includes('contact')),
          tel: H.findIndex(h => h === 'tel' || h.includes('telephone')),
          cell: H.findIndex(h => h === 'cell' || h.includes('mobile'))
        };
        if (ix.code < 0 || ix.name < 0) { toast('Sheet "' + sheetName + '" needs Code and Name columns', true); return; }
        const list = rows.slice(hi + 1).filter(r => r && r[ix.code]).map(r => ({
          code: String(r[ix.code]).trim(), name: String(r[ix.name] || '').trim(),
          area: ix.area >= 0 ? String(r[ix.area] || '').trim() : '',
          address: ix.address >= 0 ? cleanAddr(r[ix.address]) : '',
          contact: ix.contact >= 0 ? String(r[ix.contact] || '').trim() : '',
          tel: ix.tel >= 0 ? String(r[ix.tel] || '').trim() : '',
          cell: ix.cell >= 0 ? String(r[ix.cell] || '').trim() : '',
          freq: 0
        }));
        if (!list.length) { toast('No customer rows found in "' + sheetName + '"', true); return; }
        localStorage.setItem('bd_addressbook', JSON.stringify(list));
        window.CUSTOMERS = list;
        toast('Address book loaded: ' + list.length + ' customers (sheet: ' + sheetName + ') - stored on this device only');
        renderSettings(); renderBook();
      } catch (err) { console.error(err); toast('Could not read that file: ' + err.message, true); }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderBookStatus() {
    const stored = !!localStorage.getItem('bd_addressbook');
    $('#bookStatus').innerHTML = window.CUSTOMERS.length
      ? '&#10003; <b>' + window.CUSTOMERS.length + '</b> customers loaded (' + (stored ? 'uploaded - stored in this browser' : 'bundled file') + ')'
      : '<span style="color:var(--bad)">No address book loaded.</span> Upload your customer list (Excel with Code / Name / Geo Area / Delivery Address / Tel / Cell columns - the "Customer addresses" tab of your deliveries export works as-is). Order imports still work without it.';
  }

  /* ---------------- Tabs / date / wiring ---------------- */
  function switchTab(t) {
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    $$('.page').forEach(p => p.style.display = p.id === 'page-' + t ? '' : 'none');
    if (t === 'book') renderBook();
    if (t === 'settings') renderSettings();
  }

  function init() {
    $('#planDate').value = planDate;
    $('#planDate').onchange = () => { planDate = $('#planDate').value || todayISO(); day = loadDay(planDate); renderPlan(); };
    $$('.tab').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    $('#importBtn').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = e => { if (e.target.files[0]) handleImportFile(e.target.files[0]); e.target.value = ''; };
    $('#addCustomerBtn').onclick = () => { switchTab('book'); $('#bookSearch').focus(); };
    $('#optimiseBtn').onclick = () => optimise();
    $('#reoptBtn').onclick = () => optimise(day.vansUsed);
    $('#clearDay').onclick = () => { if (confirm('Clear all stops and routes for ' + planDate + '?')) { day = blankDay(); saveDay(); renderPlan(); } };
    $('#bookSearch').oninput = renderBook;
    $('#bookFileBtn').onclick = () => $('#bookFile').click();
    $('#bookFile').onchange = e => { if (e.target.files[0]) parseAddressBook(e.target.files[0]); e.target.value = ''; };
    $('#clearBook').onclick = () => { localStorage.removeItem('bd_addressbook'); toast('Uploaded address book removed - reload the page'); };
    wireSettings();
    if (!settings.apiKey) $('#keyNudge').style.display = '';
    $('#keyNudgeBtn').onclick = () => switchTab('settings');
    renderPlan();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
