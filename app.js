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

  /* The depot is HARD-PINNED. Whenever the depot address is our Ivanseth Rd
     building (any spelling), snap to the verified coordinates & canonical
     address — geocoding is never allowed to move the depot.               */
  const DEPOT_PIN = { address: '14 Ivanseth Rd, Reuven, Johannesburg, 2091', lat: -26.2348178, lng: 28.0298321 };
  function enforceDepot() {
    if (/ivanseth/i.test(settings.depot.address || '')) {
      settings.depot.address = DEPOT_PIN.address;
      settings.depot.lat = DEPOT_PIN.lat;
      settings.depot.lng = DEPOT_PIN.lng;
      settings.depot.geocoded = true;
    }
  }
  enforceDepot();

  let applyingRemote = false; // true while applying data received from Team sync (prevents echo loops)
  const saveSettings = () => {
    enforceDepot();
    localStorage.setItem('bd_settings', JSON.stringify(settings));
    if (!applyingRemote && window.TeamSync) window.TeamSync.push('settings');
  };
  function persistBook() {
    try { localStorage.setItem('bd_addressbook', JSON.stringify(window.CUSTOMERS)); }
    catch (e) { toast('Could not save the address book locally: ' + e.message, true); }
    if (!applyingRemote && window.TeamSync) window.TeamSync.push('addressbook');
    renderBookStatus();
  }

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
      let n = 0, fatal = 0;
      for (const s of missing) {
        busy('Geocoding ' + (++n) + '/' + missing.length + ' — ' + s.name);
        if (!s.address) { s.geo = 'none'; continue; }
        const g = await window.GoogleRouting.geocode(s.address, s.area);
        if (g && !g.suspect) {
          s.lat = g.lat; s.lng = g.lng; s.geo = 'exact'; fatal = 0;
          if (!s.area) s.area = regionOfPoint(s) || s.area;
        } else if (g) { s.lat = g.lat; s.lng = g.lng; s.geo = 'suspect'; fatal = 0; }
        else {
          s.geo = 'failed';
          const st = window.GoogleRouting.lastStatus;
          const systemic = st === 'REQUEST_DENIED' || st === 'AUTH_FAILURE' || st === 'OVER_QUERY_LIMIT' ||
            ((st === 'TIMEOUT' || st === 'JS_ERROR') && ++fatal >= 3);
          if (systemic) {
            toast('Geocoding unavailable (' + st + ') — using approximate locations. ' + hintForStatus(st), true);
            break;
          }
        }
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
      '<button class="btn small ghost share" data-van="' + vi + '" title="Send the updated route + navigation link to the driver (WhatsApp etc.) — use after adding a stop mid-route">📤 Send route to driver</button>' +
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
    $$('#result .share').forEach(b => b.onclick = () => shareVanRoute(+b.dataset.van));
  }

  /* Send the (remaining) route to a driver — for mid-route additions.
     The navigation link has no fixed origin, so it starts from wherever
     the driver is when they tap it.                                     */
  async function shareVanRoute(vi) {
    const v = day.result.vans[vi];
    const stopsById = Object.fromEntries(day.stops.map(s => [s.id, s]));
    const lines = ['Blind Designs — ' + v.name + ' · ' + planDate];
    let n = 0;
    v.stopIds.forEach((id, i) => {
      const s = stopsById[id];
      if (!s || s.done) return;
      n++;
      lines.push(n + '. ~' + fmtT(v.tl.etas[i]) + '  ' + s.name + ' — ' + (s.address || '') + (s.phone ? ' (' + s.phone + ')' : ''));
    });
    if (!n) { toast('All stops on this van are already ticked off', true); return; }
    (v.links || []).forEach((l, i) => lines.push((v.links.length > 1 ? 'Navigate leg ' + (i + 1) + ': ' : 'Tap to navigate: ') + l));
    lines.push('(Link starts from wherever you are now.)');
    const text = lines.join('\n');
    if (navigator.share) {
      try { await navigator.share({ text }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(text); toast('Route copied ✓ — paste it to the driver on WhatsApp'); }
    catch (e) { window.prompt('Copy the route text below:', text); }
  }

  /* Sequence label for map pins: 1-9 then A-Z (static maps allow one char) */
  const pinLabel = i => i < 9 ? String(i + 1) : (i < 35 ? String.fromCharCode(65 + i - 9) : '');

  /* Build a Google Static Maps route image (depot + numbered stops + path).
     Returns { dataUrl, legend } or null (missing key/coords, API not enabled…). */
  async function buildRouteMap(orderedStops, vanColor) {
    if (!settings.apiKey) return null;
    const pts = orderedStops.filter(s => s.lat != null && s.lng != null);
    if (pts.length < 1 || settings.depot.lat == null) return null;
    const col = (vanColor || '#1f5fa8').replace('#', '0x');
    const r5 = n => Math.round(n * 1e5) / 1e5;
    const depot = r5(settings.depot.lat) + ',' + r5(settings.depot.lng);
    const parts = [
      'size=640x360', 'scale=2', 'maptype=roadmap', 'language=en', 'region=ZA',
      'markers=' + encodeURIComponent('size:mid|color:0x222222|label:D|' + depot)
    ];
    pts.forEach((s, i) => {
      const lab = pinLabel(orderedStops.indexOf(s));
      parts.push('markers=' + encodeURIComponent('size:mid|color:' + col + (lab ? '|label:' + lab : '') + '|' + r5(s.lat) + ',' + r5(s.lng)));
    });
    parts.push('path=' + encodeURIComponent('color:' + col + 'CC|weight:3|' + depot + '|' + pts.map(s => r5(s.lat) + ',' + r5(s.lng)).join('|') + '|' + depot));
    parts.push('key=' + encodeURIComponent(settings.apiKey));
    const url = 'https://maps.googleapis.com/maps/api/staticmap?' + parts.join('&');
    if (url.length > 8100) return null; // static maps URL limit
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      if (!blob.type.startsWith('image')) throw new Error('not an image');
      const dataUrl = await new Promise((ok, bad) => {
        const fr = new FileReader();
        fr.onload = () => ok(fr.result); fr.onerror = bad;
        fr.readAsDataURL(blob);
      });
      let legend = 'Map pins match the stop numbers below · D = depot.';
      if (orderedStops.length > 9) legend += ' Pins A, B, C… = stops 10, 11, 12…';
      if (pts.length < orderedStops.length) legend += ' (' + (orderedStops.length - pts.length) + ' stop(s) without a precise location are not shown.)';
      return { dataUrl, legend };
    } catch (e) {
      console.warn('Static map failed:', e);
      toast('Route map unavailable — enable the "Maps Static API" for your Google key (PDF still generated)', true);
      return null;
    }
  }

  async function downloadVanPdf(vi) {
    const v = day.result.vans[vi];
    const stopsById = Object.fromEntries(day.stops.map(s => [s.id, s]));
    const ordered = v.stopIds.map(id => stopsById[id]).filter(Boolean);
    const seq = ordered.map((s, i) => ({ stop: s, eta: new Date(v.tl.etas[i]) }));
    let map = null;
    try {
      busy('Building route map…');
      map = await buildRouteMap(ordered, v.color);
    } finally { busy(false); $('#optStatus').textContent = ''; }
    window.PdfGen.vanPdf({
      name: v.name, color: v.color, stops: ordered, links: v.links, map,
      timeline: { seq, driveMin: v.tl.driveMin, km: v.tl.km, returnAt: new Date(v.tl.returnAt), returnBy: new Date(v.tl.returnBy) }
    }, { date: planDate, departTime: settings.departTime, leewayPct: settings.leewayPct, hardReturn: settings.hardReturn, serviceMin: settings.serviceMin });
  }

  function renderPlan() { renderAreas(); renderStops(); renderResult(); }

  /* ---------------- Address book tab ---------------- */
  function renderBook() {
    const q = ($('#bookSearch').value || '').toLowerCase();
    const all = window.CUSTOMERS.filter(c => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q) || (c.area || '').toLowerCase().includes(q));
    const list = all.slice(0, 60);
    $('#bookCount').textContent = all.length === window.CUSTOMERS.length
      ? window.CUSTOMERS.length + ' customers' + (all.length > 60 ? ' (showing 60 — search to narrow)' : '')
      : all.length + ' matches' + (all.length > 60 ? ' (showing 60)' : '');
    $('#bookList').innerHTML = list.map(c => {
      const col = (window.REGIONS[c.area] || {}).color || '#999';
      const q = c.address ? window.GoogleRouting.getQuality(c.address) : null;
      const qBadge =
        q === 'partial' ? '<span class="badge warn" title="Google could not match this address exactly — verify it">⚠ check address</span>' :
        q === 'suspect' ? '<span class="badge bad" title="Pinned outside the delivery area — address probably wrong">⚠ outside area</span>' :
        q === 'failed' ? '<span class="badge bad" title="Google cannot find this address">✗ not found</span>' : '';
      return '<div class="book-row"><span class="rdot" style="background:' + col + '"></span>' +
        '<div class="s-main"><b>' + esc(c.name) + '</b> <span class="code">' + esc(c.code) + '</span>' +
        (c.freq ? '<span class="badge">' + c.freq + ' deliveries</span>' : '') + qBadge +
        '<div class="s-addr">' + esc(c.address || 'no address on file') + (c.area ? ' · ' + esc(c.area) : '') + '</div></div>' +
        '<button class="mini add" data-code="' + esc(c.code) + '">+ Add</button>' +
        '<button class="mini edit" data-code="' + esc(c.code) + '" title="Edit customer">✎</button>' +
        '<button class="mini del" data-code="' + esc(c.code) + '" title="Remove from address book">✕</button></div>';
    }).join('') || '<div class="empty">No matches.</div>';
    $$('#bookList .add').forEach(b => b.onclick = () => {
      const c = window.CUSTOMERS.find(x => x.code === b.dataset.code);
      if (c) { addStopFromCustomer(c); toast(c.name + ' added to ' + planDate); }
    });
    $$('#bookList .edit').forEach(b => b.onclick = () => {
      const c = window.CUSTOMERS.find(x => x.code === b.dataset.code);
      if (c) openCustForm(c);
    });
    $$('#bookList .del').forEach(b => b.onclick = () => {
      const c = window.CUSTOMERS.find(x => x.code === b.dataset.code);
      if (!c) return;
      const team = window.TeamSync && window.TeamSync.state().teamId;
      if (!confirm('Remove ' + c.name + ' from the address book' + (team ? ' for the whole team' : '') + '?')) return;
      window.CUSTOMERS = window.CUSTOMERS.filter(x => x.code !== c.code);
      persistBook(); renderBook();
      toast(c.name + ' removed from the address book');
    });
  }

  /* ---------------- Manual customer add / edit ---------------- */
  let editingCode = null;
  function openCustForm(c) {
    editingCode = c ? c.code : null;
    $('#cfTitle').textContent = c ? 'Edit customer — ' + c.name : 'New customer';
    $('#custForm').style.display = '';
    $('#cfName').value = c ? c.name : '';
    $('#cfCode').value = c ? c.code : '';
    $('#cfCode').disabled = !!c;
    $('#cfPhone').value = c ? (c.cell || c.tel || '') : '';
    $('#cfAddr').value = c ? c.address : '';
    const cur = c ? c.area : '';
    let opts = '<option value="">(auto from address)</option>' +
      Object.keys(window.REGIONS).map(r => '<option value="' + esc(r) + '"' + (cur === r ? ' selected' : '') + '>' + esc(r) + '</option>').join('');
    if (cur && !window.REGIONS[cur]) opts += '<option value="' + esc(cur) + '" selected>' + esc(cur) + '</option>';
    $('#cfArea').innerHTML = opts;
    $('#cfStatus').textContent = '';
    $('#cfName').focus();
  }
  function closeCustForm() { $('#custForm').style.display = 'none'; editingCode = null; }

  async function saveCustForm(alsoAdd) {
    const name = $('#cfName').value.trim();
    const addr = cleanAddr($('#cfAddr').value);
    if (!name || !addr) { toast('Name and delivery address are both required', true); return; }
    let rec = editingCode ? window.CUSTOMERS.find(x => x.code === editingCode) : null;
    if (!rec) {
      let code = ($('#cfCode').value || '').trim() || ('MAN-' + Date.now().toString(36).toUpperCase());
      if (window.CUSTOMERS.some(x => x.code === code)) { toast('Customer code "' + code + '" already exists — pick another', true); return; }
      rec = { code, name: '', area: '', address: '', contact: '', tel: '', cell: '', freq: 0 };
      window.CUSTOMERS.unshift(rec);
    }
    const oldAddr = rec.address;
    rec.name = name;
    rec.address = addr;
    rec.cell = $('#cfPhone').value.trim();
    rec.area = $('#cfArea').value || rec.area || '';
    const areaWasAuto = !$('#cfArea').value;
    const wasEdit = !!editingCode;
    // save immediately — geocoding happens in the background
    persistBook();
    closeCustForm();
    renderBook();
    toast((wasEdit ? 'Customer updated: ' : 'Customer added: ') + name +
      (window.TeamSync && window.TeamSync.state().teamId ? ' (synced to team)' : ''));
    if (alsoAdd) {
      // refresh any matching stop already on the plan, else add
      const existing = day.stops.find(s => s.code === rec.code);
      if (existing) {
        existing.name = rec.name; existing.address = rec.address; existing.area = rec.area;
        const cached = window.GoogleRouting.cachedCoords(rec.address);
        existing.lat = cached ? cached.lat : undefined; existing.lng = cached ? cached.lng : undefined;
        existing.geo = cached ? 'exact' : 'none';
        day.result = null; saveDay(); renderPlan();
        toast(rec.name + ' updated on ' + planDate);
      } else addStopFromCustomer(rec);
      switchTab('plan');
    }
    // background: pin the address on the map so routing is precise
    if (settings.apiKey) {
      (async () => {
        try {
          await window.GoogleRouting.loadApi(settings.apiKey);
          const g = await window.GoogleRouting.geocode(addr, rec.area, addr !== oldAddr);
          if (g && !g.suspect) {
            if (areaWasAuto) {
              const region = regionOfPoint({ lat: g.lat, lng: g.lng });
              if (region && region !== rec.area) { rec.area = region; persistBook(); }
            }
            // update today's stop for this customer, if any
            const st = day.stops.find(s => s.code === rec.code);
            if (st) { st.lat = g.lat; st.lng = g.lng; st.geo = 'exact'; st.area = rec.area || st.area; saveDay(); }
            renderPlan();
            if ($('#page-book').style.display !== 'none') renderBook();
            toast('Address located ✓' + (g.formatted ? ' — ' + g.formatted : ''));
          } else {
            toast('Could not pinpoint "' + name + '" (' + window.GoogleRouting.lastStatus + ') — an approximate position will be used; check the address', true);
          }
        } catch (e) { toast('Could not geocode ' + name + ': ' + e.message, true); }
      })();
    }
  }

  /* ---------------- Settings tab ---------------- */
  function updateKeyBanner() {
    $('#keyNudge').style.display = settings.apiKey ? 'none' : '';
  }
  function hintForStatus(st) {
    switch (st) {
      case 'REQUEST_DENIED': return 'Usually the Geocoding API isn\'t enabled for this key, billing isn\'t linked, or the key\'s website restriction blocks ' + location.origin + '.';
      case 'AUTH_FAILURE': return 'Google rejected the key — check the key value and that its website restriction includes ' + location.origin + '/*.';
      case 'OVER_QUERY_LIMIT': case 'RESOURCE_EXHAUSTED': return 'Google\'s rate/quota limit hit — wait a minute and try again.';
      case 'TIMEOUT': return 'No answer from Google — check your internet connection or ad-blocker.';
      case 'ZERO_RESULTS': return 'Google couldn\'t find that address.';
      case 'JS_ERROR': return 'The Maps library didn\'t load properly — reload the page.';
      default: return '';
    }
  }
  async function testKey() {
    const S = $('#keyTestStatus');
    S.textContent = 'Testing key against Google…'; S.className = 'note';
    try {
      await window.GoogleRouting.loadApi(settings.apiKey);
      const g = await window.GoogleRouting.geocode(settings.depot.address, null, true); // force = bypass cache
      if (g) {
        if (!g.suspect) { settings.depot.lat = g.lat; settings.depot.lng = g.lng; settings.depot.geocoded = true; saveSettings(); }
        S.textContent = '✓ Key working — live traffic and precise geocoding are ON.'; S.className = 'note okText';
        toast('Google Maps key OK ✓');
      } else {
        const st = window.GoogleRouting.lastStatus;
        S.textContent = '✗ Maps loaded but geocoding failed (' + st + '). ' + hintForStatus(st); S.className = 'note badText';
        toast('Geocoding test failed: ' + st, true);
      }
    } catch (e) {
      S.textContent = '✗ ' + e.message + ' ' + hintForStatus(window.GoogleRouting.lastStatus); S.className = 'note badText';
      toast(e.message, true);
    }
  }
  function renderSyncStatus() {
    if (!window.TeamSync) return;
    const st = window.TeamSync.state();
    const el = $('#syncStatus');
    let cls = '', txt;
    if (st.status === 'on') { cls = 'ok'; txt = 'Synced ✓' + (st.lastSync ? ' · ' + st.lastSync.toTimeString().slice(0, 5) : ''); }
    else if (st.status === 'connecting') { cls = 'warn'; txt = 'Connecting…'; }
    else if (st.status === 'error') { cls = 'bad'; txt = st.statusMsg || 'Sync error'; }
    else txt = st.hasConfig ? 'Not connected' : 'Not set up';
    el.className = 'pill ' + cls; el.textContent = txt;
    $('#disconnectTeam').style.display = st.teamId ? '' : 'none';
  }

  function renderSettings() {
    renderBookStatus();
    $('#setKey').value = settings.apiKey;
    if (!$('#keyTestStatus').textContent) {
      $('#keyTestStatus').textContent = settings.apiKey
        ? 'Key saved (ends …' + settings.apiKey.slice(-4) + '). Press "Save settings" to re-test it.'
        : '';
    }
    if (window.TeamSync) {
      const st = window.TeamSync.state();
      $('#fbConfigRow').style.display = st.baked ? 'none' : '';
      if (!st.baked && st.hasConfig && !$('#fbConfig').value) $('#fbConfig').placeholder = 'Config saved on this device ✓ — paste a new one to replace it';
      if (st.teamId) $('#teamCode').value = st.teamId;
      renderSyncStatus();
    }
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
    $('#keyEye').onclick = () => { const k = $('#setKey'); k.type = k.type === 'password' ? 'text' : 'password'; };
    $('#saveSettings').onclick = async () => {
      const prevKey = settings.apiKey;
      settings.apiKey = $('#setKey').value.trim();
      const newDepot = $('#setDepot').value.trim();
      if (newDepot !== settings.depot.address) settings.depot = { address: newDepot, lat: settings.depot.lat, lng: settings.depot.lng, geocoded: false };
      settings.departTime = $('#setDepart').value || '09:00';
      settings.targetReturn = $('#setTarget').value || '15:00';
      settings.hardReturn = $('#setHard').value || '16:00';
      settings.serviceMin = Math.max(1, +$('#setService').value || 15);
      settings.leewayPct = Math.max(0, +$('#setLeeway').value || 12);
      settings.vanNames = [$('#van1').value || 'Van 1', $('#van2').value || 'Van 2', $('#van3').value || 'Van 3 (overflow)'];
      saveSettings(); updateKeyBanner(); toast('Settings saved');
      renderPlan();
      // Google's Maps script can only load one key per page — swap keys via a quick reload
      if (settings.apiKey && settings.apiKey !== prevKey && window.GoogleRouting.isLoaded) {
        $('#keyTestStatus').textContent = 'New key saved — reloading to apply it…';
        setTimeout(() => location.reload(), 1200);
        return;
      }
      if (settings.apiKey) testKey();
      else $('#keyTestStatus').textContent = '';
    };
    $$('input[name=preset]').forEach(r => r.onchange = () => {
      settings.schedulePreset = r.value; settings.scheduleCustom = null; saveSettings(); renderSettings();
      day.areas = null; saveDay(); renderPlan();
    });
    $('#resetSched').onclick = () => { settings.scheduleCustom = null; saveSettings(); renderSettings(); day.areas = null; saveDay(); renderPlan(); };
    $('#clearGeo').onclick = () => {
      const team = window.TeamSync && window.TeamSync.state().teamId;
      if (!confirm(team
        ? 'Clear cached geocodes for the WHOLE TEAM? Every address will need geocoding again.'
        : 'Clear cached geocodes on this device?')) return;
      window.GoogleRouting.clearCache();
      if (team) window.TeamSync.clearGeoTeam();
      toast('Geocode cache cleared');
    };

    /* -------- Geocode entire address book: resumable, stoppable, can't hang -------- */
    let geoRun = null;
    $('#geocodeAll').onclick = async () => {
      const btn = $('#geocodeAll'), S = $('#geocodeAllStatus');
      if (geoRun) { geoRun.cancel = true; btn.textContent = 'Stopping…'; return; }
      if (!settings.apiKey) { toast('Add and save a Google API key first', true); return; }
      geoRun = { cancel: false };
      btn.textContent = '⏹ Stop';
      try {
        await window.GoogleRouting.loadApi(settings.apiKey);
        const withAddr = window.CUSTOMERS.filter(c => c.address);
        const todo = withAddr.filter(c => !window.GoogleRouting.cachedCoords(c.address));
        const cachedN = withAddr.length - todo.length;
        if (!todo.length) {
          S.textContent = 'All ' + withAddr.length + ' addresses are already geocoded ✓';
        } else {
          let ok = 0, fail = 0, fatal = null, consecTO = 0, i = 0;
          for (const c of todo) {
            if (geoRun.cancel) break;
            i++;
            S.textContent = 'Geocoding ' + i + '/' + todo.length + ' — ' + c.name + (cachedN ? ' (' + cachedN + ' already cached)' : '');
            let g = await window.GoogleRouting.geocode(c.address, c.area);
            let st = window.GoogleRouting.lastStatus;
            if (!g && st === 'OVER_QUERY_LIMIT') { // back off once, then give up cleanly
              await new Promise(r => setTimeout(r, 2500));
              g = await window.GoogleRouting.geocode(c.address, c.area);
              st = window.GoogleRouting.lastStatus;
            }
            if (g && !g.suspect) { ok++; consecTO = 0; }
            else {
              fail++;
              if (st === 'REQUEST_DENIED' || st === 'AUTH_FAILURE' || st === 'OVER_QUERY_LIMIT') { fatal = st; break; }
              if (st === 'TIMEOUT' || st === 'JS_ERROR') { if (++consecTO >= 3) { fatal = st; break; } }
              else consecTO = 0;
            }
          }
          const total = cachedN + ok;
          if (fatal) {
            S.textContent = '⚠ Stopped at ' + i + '/' + todo.length + ' (' + fatal + '). ' + hintForStatus(fatal) + ' Progress so far is saved — run again once fixed.';
            toast('Geocoding stopped: ' + fatal, true);
          } else if (geoRun.cancel) {
            S.textContent = 'Stopped — ' + total + '/' + withAddr.length + ' addresses cached. Run again any time to continue.';
          } else {
            S.textContent = 'Done — ' + total + '/' + withAddr.length + ' geocoded' + (fail ? ', ' + fail + ' failed (check those addresses)' : '') +
              (window.TeamSync && window.TeamSync.state().teamId ? '. Shared with the team ✓' : '. Cached on this device.');
            toast('Geocoding complete');
          }
        }
        if (window.TeamSync) window.TeamSync.push('geocache');
      } catch (e) {
        S.textContent = '⚠ ' + e.message; toast(e.message, true);
      } finally {
        geoRun = null; btn.textContent = '📍 Geocode entire address book';
      }
    };

    /* -------- Address veracity check: grade every address against Google -------- */
    let checkRun = null;
    $('#checkAddr').onclick = async () => {
      const btn = $('#checkAddr'), R = $('#addrReport');
      if (checkRun) { checkRun.cancel = true; btn.textContent = 'Stopping…'; return; }
      if (!settings.apiKey) { toast('Add and save a Google API key first', true); return; }
      checkRun = { cancel: false };
      btn.textContent = '⏹ Stop check';
      R.style.display = '';
      R.innerHTML = '<p class="note" id="arProgress">Checking every address against Google…</p>';
      const buckets = { missing: [], failed: [], suspect: [], partial: [], exact: [], unknown: [] };
      let fatal = null, i = 0;
      try {
        await window.GoogleRouting.loadApi(settings.apiKey);
        for (const c of window.CUSTOMERS) {
          if (checkRun.cancel) break;
          i++;
          if (!c.address) { buckets.missing.push(c); continue; }
          let q = window.GoogleRouting.getQuality(c.address);
          if (!q) { // not graded on this device yet — verify live (also re-grades old cached entries)
            const el = $('#arProgress');
            if (el) el.textContent = 'Checking ' + i + '/' + window.CUSTOMERS.length + ' — ' + c.name;
            await window.GoogleRouting.geocode(c.address, c.area, true);
            const st = window.GoogleRouting.lastStatus;
            if (st === 'REQUEST_DENIED' || st === 'AUTH_FAILURE' || st === 'OVER_QUERY_LIMIT') { fatal = st; break; }
            q = window.GoogleRouting.getQuality(c.address);
          }
          (buckets[q] || buckets.unknown).push(c);
        }
        R.innerHTML = renderAddrReport(buckets, i, window.CUSTOMERS.length, fatal, checkRun.cancel);
        if (window.TeamSync) window.TeamSync.push('geocache');
        renderBook();
      } catch (e) {
        R.innerHTML = '<p class="note badText">⚠ ' + esc(e.message) + '</p>';
      } finally {
        checkRun = null; btn.textContent = '🔍 Check addresses';
      }
    };

    /* -------- Team sync -------- */
    if (window.TeamSync) wireSync();
  }

  function renderAddrReport(b, done, total, fatal, cancelled) {
    const row = (c, why) => '<div class="ar-row"><b>' + esc(c.name) + '</b> <span class="code">' + esc(c.code) + '</span> — ' +
      esc(c.address || 'no address on file') + (why ? ' <i>' + why + '</i>' : '') + '</div>';
    const sect = (title, arr, cls, why) => arr.length
      ? '<p class="ar-h ' + cls + '">' + title + ' (' + arr.length + ')</p>' + arr.map(c => row(c, why)).join('')
      : '';
    let h = '<p><b>Address check ' + (fatal ? 'stopped (' + fatal + ')' : cancelled ? 'stopped' : 'complete') + '</b> — ' + done + ' of ' + total + ' customers: ' +
      '<span class="okText">' + b.exact.length + ' exact ✓</span> · ' +
      '<span class="' + (b.partial.length ? 'badText' : '') + '">' + b.partial.length + ' guessed ⚠</span> · ' +
      '<span class="' + (b.suspect.length ? 'badText' : '') + '">' + b.suspect.length + ' outside area</span> · ' +
      '<span class="' + (b.failed.length ? 'badText' : '') + '">' + b.failed.length + ' not found</span> · ' +
      '<span class="' + (b.missing.length ? 'badText' : '') + '">' + b.missing.length + ' no address</span></p>';
    if (fatal) h += '<p class="note badText">' + esc(hintForStatus(fatal)) + '</p>';
    h += sect('No address on file — add one (✎ in the Address book)', b.missing, 'badText', '');
    h += sect('Google cannot find these — fix the address', b.failed, 'badText', '');
    h += sect('Pinned OUTSIDE the delivery area — almost certainly wrong', b.suspect, 'badText', '');
    h += sect('Partial match — Google guessed the location; verify these', b.partial, 'warnText', '');
    h += sect('Could not be checked (network hiccup) — run again', b.unknown, 'warnText', '');
    if (!fatal && !cancelled && !b.missing.length && !b.failed.length && !b.suspect.length && !b.partial.length && !b.unknown.length) {
      h += '<p class="okText"><b>Every address located exactly ✓</b></p>';
    }
    h += '<p class="note">Fix any of the above in the Address book tab (✎ edit — the address re-checks itself when you save), then run the check again.</p>';
    return h;
  }

  function wireSync() {
    const maybeSaveConfig = () => {
      const t = $('#fbConfig');
      if ($('#fbConfigRow').style.display !== 'none' && t.value.trim()) {
        window.TeamSync.saveConfigText(t.value);
        t.value = ''; t.placeholder = 'Config saved on this device ✓ — paste a new one to replace it';
      }
    };
    $('#connectTeam').onclick = async () => {
      try {
        maybeSaveConfig();
        await window.TeamSync.connect($('#teamCode').value);
        toast('Connected — team data is syncing ✓');
      } catch (e) { toast(e.message, true); renderSyncStatus(); }
    };
    $('#createTeam').onclick = async () => {
      try {
        maybeSaveConfig();
        const code = await window.TeamSync.createTeam();
        $('#teamCode').value = code;
        toast('Team created ✓ — copy the team code and share it privately with the team');
      } catch (e) { toast(e.message, true); renderSyncStatus(); }
    };
    $('#disconnectTeam').onclick = () => {
      window.TeamSync.disconnect();
      toast('Sync turned off on this device (data stays in the cloud for the team)');
      renderSyncStatus();
    };
    $('#copyTeamCode').onclick = async () => {
      const v = $('#teamCode').value.trim();
      if (!v) return;
      try { await navigator.clipboard.writeText(v); toast('Team code copied'); }
      catch (e) { $('#teamCode').select(); document.execCommand('copy'); toast('Team code copied'); }
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
        window.CUSTOMERS = list;
        persistBook();
        toast('Address book loaded: ' + list.length + ' customers (sheet: ' + sheetName + ')' +
          (window.TeamSync && window.TeamSync.state().teamId ? ' — synced to the team ✓' : ' — stored on this device'));
        renderSettings(); renderBook();
      } catch (err) { console.error(err); toast('Could not read that file: ' + err.message, true); }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderBookStatus() {
    const stored = !!localStorage.getItem('bd_addressbook');
    const synced = window.TeamSync && window.TeamSync.state().teamId;
    $('#bookStatus').innerHTML = window.CUSTOMERS.length
      ? '&#10003; <b>' + window.CUSTOMERS.length + '</b> customers loaded (' + (synced ? 'synced with the team' : stored ? 'stored in this browser' : 'bundled file') + ') · <b>' + window.GoogleRouting.cacheSize() + '</b> addresses geocoded'
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
    $('#clearBook').onclick = () => {
      localStorage.removeItem('bd_addressbook');
      const synced = window.TeamSync && window.TeamSync.state().teamId;
      toast('Uploaded address book removed on this device — reload the page' + (synced ? ' (the team copy will download again while sync is on)' : ''));
    };
    $('#newCustomerBtn').onclick = () => openCustForm(null);
    $('#cfCancel').onclick = closeCustForm;
    $('#cfSave').onclick = () => saveCustForm(false);
    $('#cfSaveAdd').onclick = () => saveCustForm(true);
    wireSettings();
    updateKeyBanner();
    $('#keyNudgeBtn').onclick = () => switchTab('settings');

    /* ---- Team sync: register what gets shared + how it lands ---- */
    if (window.TeamSync) {
      window.TeamSync.register('settings', {
        provide: () => settings,
        apply: (s, meta) => {
          if (!s) return;
          applyingRemote = true;
          try {
            settings = { ...DEFAULT_SETTINGS, ...s };
            settings.depot = { ...DEFAULT_SETTINGS.depot, ...(s.depot || {}) };
            enforceDepot();
            localStorage.setItem('bd_settings', JSON.stringify(settings));
            updateKeyBanner(); renderPlan();
            if ($('#page-settings').style.display !== 'none') renderSettings();
            if (!meta.first) toast('Settings updated from team sync');
          } finally { applyingRemote = false; }
        }
      });
      window.TeamSync.register('addressbook', {
        provide: () => ({ customers: window.CUSTOMERS }),
        apply: (d, meta) => {
          const list = (d && d.customers) || [];
          if (!list.length) return;
          applyingRemote = true;
          try {
            window.CUSTOMERS = list;
            localStorage.setItem('bd_addressbook', JSON.stringify(list));
            if ($('#page-book').style.display !== 'none') renderBook();
            renderBookStatus();
            if (!meta.first) toast('Address book updated from team sync (' + list.length + ' customers)');
          } finally { applyingRemote = false; }
        }
      });
      window.TeamSync.register('geocache', {
        provide: () => ({ cache: window.GoogleRouting.exportCache() }),
        apply: d => {
          if (!d) return;
          if (d.replace) window.GoogleRouting.replaceCache(d.cache || {});
          else window.GoogleRouting.importCache(d.cache || {});
          renderBookStatus();
        }
      });
      window.GoogleRouting.onCacheChange = () => { if (!applyingRemote) window.TeamSync.push('geocache'); };
      window.TeamSync.on('status', renderSyncStatus);
      window.TeamSync.autoConnect();
    }
    document.addEventListener('gmaps-auth-failure', () => {
      toast('Google rejected the Maps key for this site — check the key and its website restrictions.', true);
      $('#keyTestStatus').textContent = '✗ AUTH_FAILURE. ' + hintForStatus('AUTH_FAILURE');
      $('#keyTestStatus').className = 'note badText';
    });
    renderPlan();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
