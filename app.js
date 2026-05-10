// SG Cycle Ops — main app
// Loads MapLibre, PCN GeoJSON, watches GPS, draws ride trail.

const SG_CENTER = [103.8198, 1.3521];
const SG_BOUNDS = [
  [103.59, 1.15],
  [104.10, 1.48]
];

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const PCN_URL = "./public/pcn.geojson";
const PARKS_URL = "./public/parks.geojson";

const $ = (sel) => document.querySelector(sel);
const setStatus = (msg) => { $("#status").textContent = msg; };

const map = new maplibregl.Map({
  container: "map",
  style: STYLE_URL,
  center: SG_CENTER,
  zoom: 11,
  minZoom: 9,
  maxZoom: 19,
  maxBounds: SG_BOUNDS,
  attributionControl: false,
  cooperativeGestures: false
});

map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "bottom-right");
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-right");

map.on("error", (e) => {
  console.warn("Map error:", e?.error?.message || e);
});

async function loadGeoJSON(url) {
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    console.warn(`Failed to load ${url}:`, err.message);
    return { type: "FeatureCollection", features: [] };
  }
}

map.on("load", async () => {
  setStatus("Loading PCN…");

  const [pcn, parks] = await Promise.all([
    loadGeoJSON(PCN_URL),
    loadGeoJSON(PARKS_URL)
  ]);

  // Parks (polygons)
  map.addSource("parks", { type: "geojson", data: parks });
  map.addLayer({
    id: "parks-fill",
    type: "fill",
    source: "parks",
    paint: {
      "fill-color": "#0c5e3a",
      "fill-opacity": 0.18
    }
  });

  // PCN (linestrings)
  map.addSource("pcn", { type: "geojson", data: pcn });
  map.addLayer({
    id: "pcn-glow",
    type: "line",
    source: "pcn",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#00d27a",
      "line-blur": 6,
      "line-opacity": 0.35,
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 16]
    }
  });
  map.addLayer({
    id: "pcn-line",
    type: "line",
    source: "pcn",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#00ffa1",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.4, 16, 5]
    }
  });

  // Ride trail
  map.addSource("trail", {
    type: "geojson",
    data: { type: "Feature", geometry: { type: "LineString", coordinates: [] }, properties: {} }
  });
  map.addLayer({
    id: "trail-line",
    type: "line",
    source: "trail",
    layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
    paint: {
      "line-color": "#3aa0ff",
      "line-width": 4,
      "line-opacity": 0.9
    }
  });

  // Me dot
  map.addSource("me", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] }
  });
  map.addLayer({
    id: "me-accuracy",
    type: "circle",
    source: "me",
    filter: ["==", ["get", "kind"], "accuracy"],
    paint: {
      "circle-radius": ["get", "radius"],
      "circle-color": "#3aa0ff",
      "circle-opacity": 0.12,
      "circle-stroke-color": "#3aa0ff",
      "circle-stroke-opacity": 0.4,
      "circle-stroke-width": 1
    }
  });
  map.addLayer({
    id: "me-dot",
    type: "circle",
    source: "me",
    filter: ["==", ["get", "kind"], "me"],
    paint: {
      "circle-radius": 8,
      "circle-color": "#3aa0ff",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3
    }
  });

  const featureCount = (pcn.features?.length ?? 0) + (parks.features?.length ?? 0);
  if (featureCount === 0) {
    setStatus("No PCN data — run npm run fetch:data");
  } else {
    setStatus(`${pcn.features.length} PCN · ${parks.features.length} parks`);
  }
});

// ---------- Geolocation tracking ----------

const trackBtn = $("#locate");
const recenterBtn = $("#recenter");
const layersBtn = $("#layers");
const layersPanel = $("#layers-panel");
const hud = $("#hud");

let watchId = null;
let wakeLock = null;
let trail = [];
let lastFix = null;
let totalDistMeters = 0;

function toggleTrack() {
  if (watchId !== null) stopTrack();
  else startTrack();
}

async function startTrack() {
  if (!("geolocation" in navigator)) {
    setStatus("Geolocation unsupported");
    return;
  }
  trackBtn.setAttribute("aria-pressed", "true");
  trackBtn.querySelector(".label").textContent = "Tracking…";
  hud.hidden = false;
  setStatus("Locating…");

  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) { /* ignore */ }

  watchId = navigator.geolocation.watchPosition(
    onFix,
    (err) => {
      console.warn("GPS error:", err.message);
      setStatus(`GPS: ${err.message}`);
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function stopTrack() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  trackBtn.setAttribute("aria-pressed", "false");
  trackBtn.querySelector(".label").textContent = "Track me";
  hud.hidden = true;
  setStatus("Idle");
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function onFix(pos) {
  const { longitude, latitude, accuracy, speed } = pos.coords;
  const coord = [longitude, latitude];

  // Distance accumulator (filter low-accuracy jumps)
  if (lastFix && accuracy < 25) {
    const d = haversine(lastFix, coord);
    if (d < 100) totalDistMeters += d;
  }
  lastFix = coord;

  // Trail
  trail.push(coord);
  if (trail.length > 5000) trail.shift();
  const trailSrc = map.getSource("trail");
  if (trailSrc) {
    trailSrc.setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: trail },
      properties: {}
    });
  }

  // Me marker
  const meSrc = map.getSource("me");
  if (meSrc) {
    const radiusPx = metersToPixelsAtLat(accuracy, latitude, map.getZoom());
    meSrc.setData({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: coord }, properties: { kind: "accuracy", radius: radiusPx } },
        { type: "Feature", geometry: { type: "Point", coordinates: coord }, properties: { kind: "me" } }
      ]
    });
  }

  // HUD
  const kmh = speed && speed > 0 ? (speed * 3.6).toFixed(1) : "0.0";
  $("#hud-speed").textContent = kmh;
  $("#hud-dist").textContent = (totalDistMeters / 1000).toFixed(2);
  $("#hud-acc").textContent = Math.round(accuracy);
  setStatus("Tracking");

  // Follow
  if (followMode) map.easeTo({ center: coord, duration: 600 });
}

let followMode = true;
map.on("dragstart", () => { followMode = false; });
map.on("zoomstart", () => { followMode = false; });

trackBtn.addEventListener("click", toggleTrack);
recenterBtn.addEventListener("click", () => {
  followMode = true;
  if (lastFix) map.easeTo({ center: lastFix, zoom: Math.max(map.getZoom(), 15), duration: 700 });
  else map.easeTo({ center: SG_CENTER, zoom: 11, duration: 700 });
});

// ---------- Layers panel ----------

layersBtn.addEventListener("click", () => {
  const open = !layersPanel.hidden;
  layersPanel.hidden = open;
  layersBtn.setAttribute("aria-expanded", String(!open));
});

$("#toggle-pcn").addEventListener("change", (e) => {
  const v = e.target.checked ? "visible" : "none";
  if (map.getLayer("pcn-line")) map.setLayoutProperty("pcn-line", "visibility", v);
  if (map.getLayer("pcn-glow")) map.setLayoutProperty("pcn-glow", "visibility", v);
});
$("#toggle-parks").addEventListener("change", (e) => {
  const v = e.target.checked ? "visible" : "none";
  if (map.getLayer("parks-fill")) map.setLayoutProperty("parks-fill", "visibility", v);
});
$("#toggle-trail").addEventListener("change", (e) => {
  const v = e.target.checked ? "visible" : "none";
  if (map.getLayer("trail-line")) map.setLayoutProperty("trail-line", "visibility", v);
});
$("#clear-trail").addEventListener("click", () => {
  trail = [];
  totalDistMeters = 0;
  const src = map.getSource("trail");
  if (src) src.setData({ type: "Feature", geometry: { type: "LineString", coordinates: [] }, properties: {} });
  $("#hud-dist").textContent = "0.00";
});

// ---------- Helpers ----------

function haversine([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function metersToPixelsAtLat(meters, lat, zoom) {
  const earthCircumference = 40075016.686;
  const metersPerPixel = (earthCircumference * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom + 8);
  return meters / metersPerPixel;
}

// ---------- Service worker ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("SW registration failed:", err.message);
    });
  });
}
