/* =====================================================================
   visits.js — visitor data adapter for the readership heatmap.

   Two modes:
     • "demo"     — works with zero backend. Seeds a plausible global
                    distribution, geolocates the current visitor, and
                    accumulates real counts for THIS browser in
                    localStorage. Great for development / before launch.
     • "firebase" — counts real visits globally via Firestore. Flip the
                    MODE below, paste your firebaseConfig, deploy the
                    security rules from README.md. No other code changes.
   ===================================================================== */

const VisitorData = (() => {
  "use strict";

  // ─── Configuration ────────────────────────────────────────────────
  const MODE = "demo"; // "demo" | "firebase"

  // Paste your Firebase web config here when switching to "firebase".
  const firebaseConfig = {
    // apiKey: "…",
    // authDomain: "…",
    // projectId: "…",
    // appId: "…",
  };

  // ─── Seed data (demo mode only) ───────────────────────────────────
  // Approximate city coordinates with placeholder view counts so the map
  // looks alive before real data exists. Remove or keep — in firebase
  // mode these are ignored.
  const SEED = [
    { city: "Irvine",        country: "United States",  lat: 33.68,  lon: -117.83, count: 142 },
    { city: "Toronto",       country: "Canada",         lat: 43.65,  lon:  -79.38, count: 88 },
    { city: "San Francisco", country: "United States",  lat: 37.77,  lon: -122.42, count: 64 },
    { city: "New York",      country: "United States",  lat: 40.71,  lon:  -74.01, count: 57 },
    { city: "Beijing",       country: "China",          lat: 39.90,  lon:  116.41, count: 73 },
    { city: "Shanghai",      country: "China",          lat: 31.23,  lon:  121.47, count: 49 },
    { city: "Hangzhou",      country: "China",          lat: 30.27,  lon:  120.15, count: 31 },
    { city: "London",        country: "United Kingdom", lat: 51.51,  lon:   -0.13, count: 41 },
    { city: "Berlin",        country: "Germany",        lat: 52.52,  lon:   13.40, count: 22 },
    { city: "Zürich",        country: "Switzerland",    lat: 47.37,  lon:    8.54, count: 12 },
    { city: "Tokyo",         country: "Japan",          lat: 35.68,  lon:  139.69, count: 38 },
    { city: "Seoul",         country: "South Korea",    lat: 37.57,  lon:  126.98, count: 19 },
    { city: "Singapore",     country: "Singapore",      lat:  1.35,  lon:  103.82, count: 27 },
    { city: "Bengaluru",     country: "India",          lat: 12.97,  lon:   77.59, count: 34 },
    { city: "Sydney",        country: "Australia",      lat: -33.87, lon:  151.21, count: 18 },
    { city: "São Paulo",     country: "Brazil",         lat: -23.55, lon:  -46.63, count: 15 },
    { city: "Tel Aviv",      country: "Israel",         lat: 32.08,  lon:   34.78, count: 11 },
  ];

  const LS_VISITS = "sz_visits_v1";

  // ─── Helpers ──────────────────────────────────────────────────────
  const keyOf = (city, country) =>
    `${(country || "?").toLowerCase()}|${(city || "?").toLowerCase()}`;

  function fetchWithTimeout(url, ms = 5000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
  }

  // IP-based geolocation with graceful provider fallback. City-level only;
  // no data is persisted beyond an aggregate count.
  async function geolocate() {
    const providers = [
      { url: "https://ipapi.co/json/", map: (d) => ({
          lat: +d.latitude, lon: +d.longitude, city: d.city, country: d.country_name }) },
      { url: "https://ipwho.is/", map: (d) => ({
          lat: +d.latitude, lon: +d.longitude, city: d.city, country: d.country }) },
    ];
    for (const p of providers) {
      try {
        const res = await fetchWithTimeout(p.url, 5000);
        if (!res.ok) continue;
        const data = await res.json();
        const loc = p.map(data);
        if (Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) return loc;
      } catch (_) { /* try next provider */ }
    }
    return null;
  }

  // ─── Demo storage (localStorage, with in-memory fallback) ─────────
  // Some contexts (incognito, sandboxed iframes, headless) block
  // localStorage; fall back to a module-level object so the demo still
  // counts this session's visit consistently.
  const lsOK = (() => {
    try { const k = "__sz_t"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return true; }
    catch (_) { return false; }
  })();
  let memVisits = null;
  const readLocal = () => {
    if (lsOK) { try { return JSON.parse(localStorage.getItem(LS_VISITS)) || {}; } catch (_) { return {}; } }
    return memVisits || {};
  };
  const writeLocal = (obj) => {
    if (lsOK) { try { localStorage.setItem(LS_VISITS, JSON.stringify(obj)); return; } catch (_) {} }
    memVisits = obj;
  };

  function demoAggregate(localOverlay) {
    const map = new Map();
    const add = (p) => {
      const k = keyOf(p.city, p.country);
      if (map.has(k)) map.get(k).count += p.count;
      else map.set(k, { ...p });
    };
    SEED.forEach(add);
    Object.values(localOverlay || readLocal()).forEach(add);
    return [...map.values()];
  }

  function summarize(points) {
    const countries = new Set(points.map((p) => p.country).filter(Boolean));
    const totalViews = points.reduce((s, p) => s + (p.count || 0), 0);
    return { points, totalViews, countries: countries.size, cities: points.length };
  }

  // ─── Firebase (live) ──────────────────────────────────────────────
  let _fb = null;
  async function fb() {
    if (_fb) return _fb;
    const appMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
    const fsMod  = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const app = appMod.initializeApp(firebaseConfig);
    _fb = { db: fsMod.getFirestore(app), fs: fsMod };
    return _fb;
  }

  async function firebaseRecord(loc) {
    const { db, fs } = await fb();
    const id = keyOf(loc.city, loc.country).replace(/[^\w|.-]/g, "_");
    await fs.setDoc(
      fs.doc(db, "visits", id),
      { lat: loc.lat, lon: loc.lon, city: loc.city || "Unknown",
        country: loc.country || "Unknown", count: fs.increment(1),
        updated: fs.serverTimestamp() },
      { merge: true }
    );
  }

  async function firebaseGetAll() {
    const { db, fs } = await fb();
    const snap = await fs.getDocs(fs.collection(db, "visits"));
    const points = [];
    snap.forEach((d) => {
      const v = d.data();
      if (Number.isFinite(v.lat) && Number.isFinite(v.lon)) {
        points.push({ lat: v.lat, lon: v.lon, city: v.city, country: v.country, count: v.count || 1 });
      }
    });
    return summarize(points);
  }

  // ─── Public API ───────────────────────────────────────────────────
  // Records the current page view and returns the visitor's location
  // (or null if geolocation was unavailable).
  async function recordVisit() {
    const loc = await geolocate();

    if (MODE === "firebase") {
      if (loc) { try { await firebaseRecord(loc); } catch (e) { console.warn("[visits] firebase write failed", e); } }
      return loc;
    }

    // demo: accumulate this browser's visit locally (drives the total)
    if (loc) {
      const store = readLocal();
      const k = keyOf(loc.city, loc.country);
      if (store[k]) store[k].count += 1;
      else store[k] = { city: loc.city || "Unknown", country: loc.country || "Unknown",
                        lat: loc.lat, lon: loc.lon, count: 1 };
      writeLocal(store);
    }
    return loc;
  }

  async function getAll() {
    if (MODE === "firebase") {
      try { return await firebaseGetAll(); }
      catch (e) { console.warn("[visits] firebase read failed, using demo", e); }
    }
    return summarize(demoAggregate());
  }

  return { recordVisit, getAll, get mode() { return MODE; } };
})();

window.VisitorData = VisitorData;
