/* ============================================================
   Google Maps integration: geocoding (cached) + traffic-aware
   directions with waypoint optimisation. All optional — the app
   falls back to the offline model when no API key is set.
   ============================================================ */
(function () {
  'use strict';

  let loaded = false, loading = null;

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

  function cachedCoords(address) {
    const c = cache[norm(address)];
    return c ? { lat: c[0], lng: c[1] } : null;
  }

  async function geocode(address, regionHint) {
    const k = norm(address);
    if (cache[k]) return { lat: cache[k][0], lng: cache[k][1], cached: true };
    const g = new google.maps.Geocoder();
    const q = /gauteng|johannesburg|pretoria|midrand|centurion|sandton|randburg|roodepoort|krugersdorp|boksburg|benoni|kempton|edenvale|soweto|alberton/i.test(address)
      ? address : address + ', Gauteng';
    const res = await new Promise(resolve => {
      g.geocode({
        address: q,
        componentRestrictions: { country: 'ZA' },
        region: 'za'
      }, (r, status) => resolve(status === 'OK' ? r : null));
    });
    await new Promise(r => setTimeout(r, 120)); // stay under QPS limits
    if (!res || !res[0]) return null;
    const loc = res[0].geometry.location;
    const out = { lat: loc.lat(), lng: loc.lng(), partial: !!res[0].partial_match, formatted: res[0].formatted_address };
    // sanity: must be inside greater Gauteng box
    if (out.lat < -26.9 || out.lat > -25.2 || out.lng < 27.2 || out.lng > 29.0) out.suspect = true;
    cache[k] = [out.lat, out.lng];
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
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
      svc.route(req, (r, status) => resolve(status === 'OK' ? r : (console.warn('Directions:', status), null)));
    });
    if (!res || !res.routes[0]) return null;
    const route = res.routes[0];
    const legMinutes = route.legs.map(l => ((l.duration_in_traffic || l.duration).value) / 60);
    const totalKm = route.legs.reduce((a, l) => a + l.distance.value, 0) / 1000;
    return { order: route.waypoint_order, legMinutes, totalKm };
  }

  window.GoogleRouting = { loadApi, geocode, cachedCoords, directionsRoute, get isLoaded() { return loaded; } };
})();
