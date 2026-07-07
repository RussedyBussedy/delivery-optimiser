/* ============================================================
   Google Maps integration: geocoding (cached) + traffic-aware
   directions with waypoint optimisation. All optional — the app
   falls back to the offline model when no API key is set.
   ============================================================ */
(function () {
  'use strict';

  let loaded = false, loading = null;
  let lastStatus = '';        // last Google status code (or TIMEOUT / AUTH_FAILURE / JS_ERROR)
  let authFailed = false;     // set when Google rejects the key after load

  // Google calls this global when the key is invalid/restricted for this site.
  window.gm_authFailure = function () {
    authFailed = true;
    lastStatus = 'AUTH_FAILURE';
    console.warn('Google Maps auth failure — key rejected for this site.');
    document.dispatchEvent(new CustomEvent('gmaps-auth-failure'));
  };

  function loadApi(key) {
    if (loaded) return Promise.resolve(true);
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      window.__gmapsReady = () => { loaded = true; res(true); };
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&v=weekly&callback=__gmapsReady';
      s.onerror = () => { loading = null; rej(new Error('Google Maps failed to load — check the API key.')); };
      document.head.appendChild(s);
      setTimeout(() => { if (!loaded) { loading = null; rej(new Error('Google Maps timed out — check the key and its restrictions.')); } }, 15000);
    });
    return loading;
  }

  /* ---------- Geocoding with persistent cache ---------- */
  const CACHE_KEY = 'bd_geocache_v1';
  const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  const norm = a => (a || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const persist = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { console.warn(e); } };

  /* Address quality grades (per device): exact | partial | suspect | failed */
  const QUALITY_KEY = 'bd_geoquality_v1';
  const quality = JSON.parse(localStorage.getItem(QUALITY_KEY) || '{}');
  const persistQ = () => { try { localStorage.setItem(QUALITY_KEY, JSON.stringify(quality)); } catch (e) { console.warn(e); } };
  const setQuality = (k, q) => { if (quality[k] !== q) { quality[k] = q; persistQ(); } };
  const getQuality = address => quality[norm(address)] || null;

  function cachedCoords(address) {
    const c = cache[norm(address)];
    return c ? { lat: c[0], lng: c[1] } : null;
  }

  /* Manual pins: cache entries [lat, lng, 'p'] are human-verified positions.
     They win over Google geocodes, sync to the team, and are never
     overwritten by automatic re-geocoding.                                */
  const isPinned = address => { const c = cache[norm(address)]; return !!(c && c[2] === 'p'); };
  const getPin = address => { const c = cache[norm(address)]; return (c && c[2] === 'p') ? { lat: c[0], lng: c[1], pinned: true } : null; };
  function setPin(address, lat, lng) {
    const k = norm(address);
    if (!k) return;
    cache[k] = [+lat.toFixed(7), +lng.toFixed(7), 'p'];
    persist();
    if (typeof api.onCacheChange === 'function') { try { api.onCacheChange(); } catch (e) { } }
  }
  function clearPin(address) {
    const k = norm(address);
    if (cache[k]) { delete cache[k]; persist(); }
    if (quality[k]) { delete quality[k]; persistQ(); }
    if (typeof api.onCacheChange === 'function') { try { api.onCacheChange(); } catch (e) { } }
  }

  /* Cache sharing hooks (used by Team sync) */
  const validEntry = v => Array.isArray(v) && v.length >= 2 && isFinite(v[0]) && isFinite(v[1]);
  function exportCache() { return { ...cache }; }
  function importCache(obj) {          // merge: add missing; incoming manual pins upgrade plain entries
    let changed = 0;
    for (const [k, v] of Object.entries(obj || {})) {
      if (!validEntry(v)) continue;
      const mine = cache[k];
      if (!mine) { cache[k] = v; changed++; }
      else if (v[2] === 'p' && mine[2] !== 'p') { cache[k] = v; changed++; } // pin beats geocode
    }
    if (changed) persist();
    return changed;
  }
  function replaceCache(obj) {
    for (const k of Object.keys(cache)) delete cache[k];
    for (const [k, v] of Object.entries(obj || {})) if (validEntry(v)) cache[k] = v;
    persist();
  }
  function clearCache() { replaceCache({}); localStorage.removeItem(CACHE_KEY); }
  const cacheSize = () => Object.keys(cache).length;

  async function geocode(address, regionHint, force) {
    const k = norm(address);
    // a manual pin always wins — even over a forced re-check
    if (cache[k] && cache[k][2] === 'p') { lastStatus = 'OK'; return { lat: cache[k][0], lng: cache[k][1], cached: true, pinned: true }; }
    if (cache[k] && !force) { lastStatus = 'OK'; return { lat: cache[k][0], lng: cache[k][1], cached: true }; }
    if (authFailed) { lastStatus = 'AUTH_FAILURE'; return null; }
    let g;
    try { g = new google.maps.Geocoder(); }
    catch (e) { lastStatus = 'JS_ERROR'; console.error(e); return null; }
    const q = /gauteng|johannesburg|pretoria|midrand|centurion|sandton|randburg|roodepoort|krugersdorp|boksburg|benoni|kempton|edenvale|soweto|alberton/i.test(address)
      ? address : address + ', Gauteng';
    // The Geocoder callback can fail to fire at all (auth/network problems),
    // so every request carries its own timeout — nothing can hang the app.
    const res = await new Promise(resolve => {
      let done = false;
      const finish = (r, status) => { if (done) return; done = true; lastStatus = status; resolve(r); };
      const timer = setTimeout(() => finish(null, authFailed ? 'AUTH_FAILURE' : 'TIMEOUT'), 12000);
      try {
        g.geocode({
          address: q,
          componentRestrictions: { country: 'ZA' },
          region: 'za'
        }, (r, status) => { clearTimeout(timer); finish(status === 'OK' ? r : null, status); });
      } catch (e) { clearTimeout(timer); console.error(e); finish(null, 'JS_ERROR'); }
    });
    await new Promise(r => setTimeout(r, 120)); // stay under QPS limits
    if (!res || !res[0]) {
      // only grade the ADDRESS as bad for address-level errors (not system errors)
      if (lastStatus === 'ZERO_RESULTS' || lastStatus === 'INVALID_REQUEST' || lastStatus === 'NOT_FOUND') setQuality(k, 'failed');
      return null;
    }
    const loc = res[0].geometry.location;
    const out = { lat: loc.lat(), lng: loc.lng(), partial: !!res[0].partial_match, formatted: res[0].formatted_address };
    // sanity: must be inside greater Gauteng box
    if (out.lat < -26.9 || out.lat > -25.2 || out.lng < 27.2 || out.lng > 29.0) out.suspect = true;
    setQuality(k, out.suspect ? 'suspect' : (out.partial ? 'partial' : 'exact'));
    if (!out.suspect) {                 // never cache suspect results
      cache[k] = [out.lat, out.lng];
      persist();
      if (typeof api.onCacheChange === 'function') { try { api.onCacheChange(); } catch (e) { /* ignore */ } }
    }
    return out;
  }

  /* ---------- Traffic-aware route via DirectionsService ----------
     Returns { order:[idx...], legMinutes:[...], totalKm } or null   */
  async function directionsRoute(depot, stops, departAt) {
    if (!stops.length) return { order: [], legMinutes: [], totalKm: 0 };
    if (stops.length > 25) return null; // caller falls back to offline order + chunked ETA
    const svc = new google.maps.DirectionsService();
    const dep = departAt.getTime() < Date.now() + 60000 ? new Date(Date.now() + 120000) : departAt;
    const req = {
      origin: { lat: depot.lat, lng: depot.lng },
      destination: { lat: depot.lat, lng: depot.lng },
      waypoints: stops.map(s => ({ location: { lat: s.lat, lng: s.lng }, stopover: true })),
      optimizeWaypoints: true,
      travelMode: google.maps.TravelMode.DRIVING,
      drivingOptions: { departureTime: dep, trafficModel: google.maps.TrafficModel.BEST_GUESS }
    };
    const res = await new Promise(resolve => {
      let done = false;
      const finish = r => { if (!done) { done = true; resolve(r); } };
      setTimeout(() => finish(null), 20000);
      svc.route(req, (r, status) => { lastStatus = status; finish(status === 'OK' ? r : (console.warn('Directions:', status), null)); });
    });
    if (!res || !res.routes[0]) return null;
    const route = res.routes[0];
    const legMinutes = route.legs.map(l => ((l.duration_in_traffic || l.duration).value) / 60);
    const totalKm = route.legs.reduce((a, l) => a + l.distance.value, 0) / 1000;
    return { order: route.waypoint_order, legMinutes, totalKm };
  }

  const api = {
    loadApi, geocode, cachedCoords, directionsRoute,
    exportCache, importCache, replaceCache, clearCache, cacheSize,
    getQuality, isPinned, getPin, setPin, clearPin,
    onCacheChange: null,
    get isLoaded() { return loaded; },
    get lastStatus() { return lastStatus; },
    get authFailed() { return authFailed; }
  };
  window.GoogleRouting = api;
})();
