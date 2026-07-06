/* ============================================================
   Blind Designs Delivery Optimiser — routing engine
   Works offline (haversine + Gauteng speed/rush-hour model) and
   upgrades to Google Directions (live traffic) when a key is set.
   ============================================================ */
(function () {
  'use strict';

  const R_EARTH = 6371;
  const ROAD_FACTOR = 1.32;            // straight-line -> road distance
  const toRad = d => d * Math.PI / 180;

  function haversineKm(a, b) {
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(h));
  }

  // Average speed by hop length (short hops = suburban streets, long = highway)
  function speedKmh(km) {
    if (km < 2) return 26;
    if (km < 5) return 34;
    if (km < 12) return 48;
    if (km < 25) return 62;
    return 72;
  }

  // Gauteng rush-hour multiplier for a given Date
  function trafficMult(when) {
    const dow = when.getDay();                       // 0 Sun .. 6 Sat
    if (dow === 0 || dow === 6) return 1.0;
    const h = when.getHours() + when.getMinutes() / 60;
    if (h >= 6.5 && h < 9) return 1.45;
    if (h >= 9 && h < 10) return 1.15;
    if (h >= 14.5 && h < 16) return 1.2;
    if (h >= 16 && h < 18.5) return 1.5;
    return 1.0;
  }

  function legMinutes(a, b, when) {
    const km = haversineKm(a, b) * ROAD_FACTOR;
    return (km / speedKmh(km)) * 60 * trafficMult(when || new Date()) + 1.5; // +parking/pull-off
  }

  /* ---------- Route ordering: nearest neighbour + 2-opt ---------- */
  function nearestNeighbourOrder(depot, stops, when) {
    const left = stops.map((s, i) => i);
    const order = [];
    let cur = depot;
    while (left.length) {
      let best = 0, bestT = Infinity;
      for (let j = 0; j < left.length; j++) {
        const t = legMinutes(cur, stops[left[j]], when);
        if (t < bestT) { bestT = t; best = j; }
      }
      order.push(left[best]);
      cur = stops[left[best]];
      left.splice(best, 1);
    }
    return order;
  }

  function routeCostMin(depot, stops, order, when) {
    let t = 0, cur = depot;
    for (const i of order) { t += legMinutes(cur, stops[i], when); cur = stops[i]; }
    t += legMinutes(cur, depot, when);
    return t;
  }

  function twoOpt(depot, stops, order, when) {
    if (order.length < 4) return order;
    let best = order.slice(), bestCost = routeCostMin(depot, stops, best, when), improved = true, guard = 0;
    while (improved && guard++ < 60) {
      improved = false;
      for (let i = 0; i < best.length - 1; i++) {
        for (let k = i + 1; k < best.length; k++) {
          const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
          const c = routeCostMin(depot, stops, cand, when);
          if (c < bestCost - 0.05) { best = cand; bestCost = c; improved = true; }
        }
      }
    }
    return best;
  }

  function optimiseOrder(depot, stops, when) {
    if (!stops.length) return [];
    return twoOpt(depot, stops, nearestNeighbourOrder(depot, stops, when), when);
  }

  /* ---------- Clustering into k balanced routes ---------- */
  const SEEDS = {
    2: [{ lat: -26.20, lng: 28.00 }, { lat: -25.90, lng: 28.18 }],                    // JHB | PTA+Midrand
    3: [{ lat: -26.15, lng: 27.95 }, { lat: -26.20, lng: 28.18 }, { lat: -25.85, lng: 28.20 }] // W | E/S | PTA
  };

  function estRouteMinutes(depot, stops, serviceMin, when) {
    if (!stops.length) return 0;
    const order = optimiseOrder(depot, stops, when);
    return routeCostMin(depot, stops, order, when) + serviceMin * stops.length;
  }

  // k-means-ish assignment then rebalance boundary stops to minimise the max route time
  function clusterStops(depot, stops, k, serviceMin, when) {
    if (stops.length <= 1 || k === 1) return [stops.slice()];
    let cents = (SEEDS[k] || SEEDS[2]).slice(0, k).map(c => ({ ...c }));
    let groups;
    for (let it = 0; it < 8; it++) {
      groups = Array.from({ length: k }, () => []);
      for (const s of stops) {
        let b = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const d = haversineKm(s, cents[c]);
          if (d < bd) { bd = d; b = c; }
        }
        groups[b].push(s);
      }
      cents = groups.map((g, c) => g.length
        ? { lat: g.reduce((a, s) => a + s.lat, 0) / g.length, lng: g.reduce((a, s) => a + s.lng, 0) / g.length }
        : cents[c]);
    }
    // Rebalance: move the cheapest boundary stop from the longest route to a shorter one while max time improves
    for (let moves = 0; moves < 40; moves++) {
      const times = groups.map(g => estRouteMinutes(depot, g, serviceMin, when));
      const hi = times.indexOf(Math.max(...times));
      if (groups[hi].length < 2) break;
      let done = false;
      const candidates = groups[hi].map(s => ({
        s, gain: Math.min(...groups.map((g, gi) => gi === hi ? Infinity : haversineKm(s, cents[gi])))
      })).sort((a, b) => a.gain - b.gain).slice(0, 5);
      for (const { s } of candidates) {
        for (let gi = 0; gi < k; gi++) {
          if (gi === hi) continue;
          const newHi = estRouteMinutes(depot, groups[hi].filter(x => x !== s), serviceMin, when);
          const newGi = estRouteMinutes(depot, groups[gi].concat([s]), serviceMin, when);
          if (Math.max(newHi, newGi, ...times.filter((_, i) => i !== hi && i !== gi)) < Math.max(...times) - 1) {
            groups[hi] = groups[hi].filter(x => x !== s);
            groups[gi] = groups[gi].concat([s]);
            done = true; break;
          }
        }
        if (done) break;
      }
      if (!done) break;
    }
    return groups.filter(g => g.length);
  }

  /* ---------- Timeline / ETAs ---------- */
  function buildTimeline(depot, stops, order, settings, legsOverrideMin) {
    const dep = new Date(settings.date + 'T' + settings.departTime + ':00');
    let clock = new Date(dep), cur = depot, driveMin = 0, km = 0;
    const seq = [];
    order.forEach((idx, n) => {
      const s = stops[idx];
      const lm = legsOverrideMin ? legsOverrideMin[n] : legMinutes(cur, s, clock);
      const dKm = haversineKm(cur, s) * ROAD_FACTOR;
      clock = new Date(clock.getTime() + lm * 60000);
      seq.push({ stop: s, eta: new Date(clock), legMin: lm, legKm: dKm });
      driveMin += lm; km += dKm;
      clock = new Date(clock.getTime() + settings.serviceMin * 60000);
      cur = s;
    });
    const backMin = legsOverrideMin ? legsOverrideMin[order.length] : legMinutes(cur, depot, clock);
    const backKm = haversineKm(cur, depot) * ROAD_FACTOR;
    driveMin += backMin; km += backKm;
    const returnAt = new Date(clock.getTime() + backMin * 60000);
    // leeway: pad drive time for the printed "aim to be back by"
    const returnBy = new Date(dep.getTime() + ((returnAt - dep) / 60000 * (1 + settings.leewayPct / 100)) * 60000);
    return { seq, driveMin, serviceMin: settings.serviceMin * order.length, km, returnAt, returnBy, departAt: dep };
  }

  /* ---------- Google Maps navigation links (9 waypoints per leg) ----------
     Leg 1 omits the origin: Google Maps then starts from the driver's
     CURRENT location (they're at the depot) and offers turn-by-turn
     navigation instead of a fixed A-to-B route preview.                  */
  function mapsLinks(depot, orderedStops) {
    const pt = p => p.lat.toFixed(6) + ',' + p.lng.toFixed(6);
    // route home to the depot ADDRESS (clearer in Maps than raw coordinates)
    const depotDest = depot.address ? encodeURIComponent(depot.address) : pt(depot);
    const links = [];
    const pts = [depot, ...orderedStops.map(x => x), depot];
    // each link: origin + up to 9 waypoints + destination (11 points max)
    let i = 0;
    while (i < pts.length - 1) {
      const chunk = pts.slice(i, Math.min(i + 11, pts.length));
      const origin = chunk[0], dest = chunk[chunk.length - 1], way = chunk.slice(1, -1);
      const destParam = dest === depot ? depotDest : pt(dest);
      links.push('https://www.google.com/maps/dir/?api=1&travelmode=driving&dir_action=navigate'
        + (i === 0 ? '' : '&origin=' + pt(origin))   // leg 1: start from wherever the driver is
        + '&destination=' + destParam
        + (way.length ? '&waypoints=' + way.map(pt).join('%7C') : ''));
      i += 10;
    }
    return links;
  }

  window.Optimiser = {
    haversineKm, legMinutes, optimiseOrder, routeCostMin,
    clusterStops, estRouteMinutes, buildTimeline, mapsLinks, trafficMult
  };
})();
