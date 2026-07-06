/* ============================================================
   Team sync — shares settings, the address book and geocodes
   between all devices via a Firebase Firestore project you own.
   Entirely optional: without config the app stays local-only.
   The team code is the secret — treat it like a password.
   ============================================================ */
(function () {
  'use strict';

  const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  const LS_CFG = 'bd_fb_config', LS_CODE = 'bd_team_code', LS_DEV = 'bd_device_id';
  const DOCS = ['settings', 'addressbook', 'geocache'];

  let db = null, teamId = null, unsubs = [];
  let status = 'off', statusMsg = '', lastSync = null;

  let deviceId = localStorage.getItem(LS_DEV);
  if (!deviceId) { deviceId = 'd' + Math.random().toString(36).slice(2, 10); localStorage.setItem(LS_DEV, deviceId); }

  /* ---------- events ---------- */
  const subs = {};
  const on = (ev, cb) => { (subs[ev] = subs[ev] || []).push(cb); };
  const emit = (ev, p) => { (subs[ev] || []).forEach(f => { try { f(p); } catch (e) { console.error(e); } }); };
  const setStatus = (s, msg) => { status = s; statusMsg = msg || ''; emit('status', { status, msg: statusMsg }); };

  /* ---------- SDK loading (only when actually used) ---------- */
  function script(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = () => rej(new Error('Could not load Firebase — check your internet connection.'));
      document.head.appendChild(s);
    });
  }
  let sdkP = null;
  function loadSdk() {
    if (window.firebase && window.firebase.firestore) return Promise.resolve();
    if (!sdkP) sdkP = script(SDK + 'firebase-app-compat.js').then(() => script(SDK + 'firebase-firestore-compat.js'));
    return sdkP;
  }

  /* ---------- config ---------- */
  function bakedConfig() {
    return (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.projectId) ? window.FIREBASE_CONFIG : null;
  }
  function getConfig() {
    if (bakedConfig()) return bakedConfig();
    try { const c = JSON.parse(localStorage.getItem(LS_CFG) || 'null'); return (c && c.projectId) ? c : null; }
    catch (e) { return null; }
  }
  function saveConfigText(txt) {
    txt = (txt || '').trim();
    if (!txt) { localStorage.removeItem(LS_CFG); return null; }
    const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('Paste the whole firebaseConfig = { … } snippet from the Firebase console.');
    let obj;
    try { obj = (new Function('return (' + txt.slice(a, b + 1) + ')'))(); }
    catch (e) { throw new Error('Could not read that config — paste it exactly as shown in the Firebase console.'); }
    if (!obj || !obj.projectId || !obj.apiKey) throw new Error('That doesn\'t look like a Firebase config (it needs apiKey and projectId).');
    localStorage.setItem(LS_CFG, JSON.stringify(obj));
    return obj;
  }

  let initializedWith = null;
  async function ensureDb() {
    const cfg = getConfig();
    if (!cfg) throw new Error('Add the Firebase config first — see the README (Team sync).');
    if (db) {
      if (initializedWith !== JSON.stringify(cfg)) throw new Error('Firebase config changed — reload the page, then press Connect again.');
      return db;
    }
    await loadSdk();
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    initializedWith = JSON.stringify(cfg);
    db = firebase.firestore();
    return db;
  }

  /* ---------- data plumbing: the app registers each doc ---------- */
  const providers = {};  // name -> () => payload to store
  const appliers = {};   // name -> (payload, {first}) => apply remotely-received data
  function register(name, opts) { providers[name] = opts.provide; appliers[name] = opts.apply; }

  const base = () => db.collection('teams').doc(teamId).collection('data');
  const wrap = payload => ({ v: 1, src: deviceId, at: Date.now(), data: payload });

  function friendlyErr(e) {
    const m = String((e && (e.code || e.message)) || e);
    if (m.includes('permission')) return 'Permission denied — check the Firestore rules were published and the team code is right.';
    if (m.includes('unavailable') || m.includes('network')) return 'Firebase unreachable — will retry when back online.';
    return 'Sync error: ' + m;
  }

  /* ---------- debounced pushes ---------- */
  const timers = {};
  function push(name) {
    if (!db || !teamId || !providers[name]) return;
    clearTimeout(timers[name]);
    timers[name] = setTimeout(async () => {
      if (!db || !teamId) return; // disconnected while the debounce was pending
      try {
        const payload = providers[name]();
        if (payload == null) return;
        const bytes = JSON.stringify(payload).length;
        if (bytes > 900000) { setStatus('error', 'Too much data to sync (' + Math.round(bytes / 1024) + ' KB) — reduce the address book.'); return; }
        await base().doc(name).set(wrap(payload));
        lastSync = new Date(); setStatus('on');
      } catch (e) { console.error('sync push', name, e); setStatus('error', friendlyErr(e)); }
    }, 1200);
  }

  /* ---------- connect / disconnect ---------- */
  function stopListeners() { unsubs.forEach(u => { try { u(); } catch (e) { } }); unsubs = []; }

  async function connect(code, opts) {
    opts = opts || {};
    code = (code || '').trim();
    if (!code) throw new Error('Enter a team code.');
    await ensureDb();
    stopListeners();
    teamId = code;
    localStorage.setItem(LS_CODE, code);
    setStatus('connecting');

    if (opts.create) {
      for (const d of DOCS) {
        const payload = providers[d] ? providers[d]() : null;
        if (payload != null) await base().doc(d).set(wrap(payload));
      }
    }

    const first = {};
    for (const d of DOCS) {
      first[d] = true;
      const un = base().doc(d).onSnapshot(snap => {
        const isFirst = first[d]; first[d] = false;
        if (!snap.exists) {
          // first device to use this code seeds it with its local data
          if (isFirst && providers[d]) {
            const p = providers[d]();
            if (p != null) base().doc(d).set(wrap(p)).catch(e => setStatus('error', friendlyErr(e)));
          }
          return;
        }
        if (snap.metadata.hasPendingWrites) return;         // our own write echoing back
        const v = snap.data() || {};
        lastSync = new Date(); setStatus('on');
        if (v.src === deviceId && !isFirst) return;         // server echo of our own change
        if (appliers[d]) { try { appliers[d](v.data, { first: isFirst }); } catch (e) { console.error('sync apply', d, e); } }
      }, err => { console.error(err); setStatus('error', friendlyErr(err)); });
      unsubs.push(un);
    }
    setStatus('on');
    return code;
  }

  function newCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const a = new Uint8Array(24);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return 'bd-' + Array.from(a, b => chars[b % 36]).join('');
  }
  async function createTeam() { return connect(newCode(), { create: true }); }

  function disconnect() {
    stopListeners();
    teamId = null;
    localStorage.removeItem(LS_CODE);
    setStatus('off');
  }

  function autoConnect() {
    const code = localStorage.getItem(LS_CODE);
    if (code && getConfig()) connect(code).catch(e => setStatus('error', friendlyErr(e)));
  }

  /* explicit team-wide geocache clear (replace, not merge) */
  async function clearGeoTeam() {
    if (!db || !teamId) return;
    try { await base().doc('geocache').set(wrap({ cache: {}, replace: true })); }
    catch (e) { setStatus('error', friendlyErr(e)); }
  }

  window.TeamSync = {
    register, on, push, connect, createTeam, disconnect, autoConnect, clearGeoTeam,
    saveConfigText, getConfig,
    state: () => ({
      status, statusMsg, teamId, lastSync,
      hasConfig: !!getConfig(), baked: !!bakedConfig(), deviceId
    })
  };
})();
