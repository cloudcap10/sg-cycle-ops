// SG Cycle Ops — main app
// Loads MapLibre, paints a warm cream basemap, draws PCN with a flowing
// dash animation, watches GPS, records a ride trail.

const SG_CENTER = [103.8198, 1.3521];
const SG_BOUNDS = [
  [103.59, 1.15],
  [104.10, 1.48]
];

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const PCN_URL = "./public/pcn.geojson";
const PARKS_URL = "./public/parks.geojson";

const $ = (sel) => document.querySelector(sel);
const statusText = $("#status-text");
const statusPill = $("#status");

function setStatus(msg, state) {
  statusText.textContent = msg;
  if (state) statusPill.dataset.state = state;
  else delete statusPill.dataset.state;
}

const map = new maplibregl.Map({
  container: "map",
  style: STYLE_URL,
  center: SG_CENTER,
  zoom: 11,
  minZoom: 9,
  maxZoom: 19,
  maxBounds: SG_BOUNDS,
  attributionControl: false,
  cooperativeGestures: false,
  pitchWithRotate: false
});

map.on("error", (e) => console.warn("Map error:", e?.error?.message || e));

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

// Repaint Positron's grey palette into a warm cream/leaf scheme.
// We touch only fill/line color paint props on existing layers — no new layers.
function applyWarmPalette() {
  const cream = "#fdf8ed";
  const sand = "#f1e8d3";
  const buildingFill = "#ece1c4";
  const buildingStroke = "#d9caa3";
  const water = "#cfe7ed";
  const road = "#e6dcc1";
  const roadCasing = "#d2c39d";
  const motorway = "#f7d2a2";
  const motorwayCasing = "#e3a86b";
  const park = "#dff0c4";
  const text = "#3a4a3a";
  const textHalo = "#fdf8ed";

  const recolor = [
    { match: /background/i, type: "background", paint: { "background-color": cream } },
    { match: /landcover|earth|land/i, paint: { "fill-color": sand, "fill-opacity": 0.6 } },
    { match: /park|green|forest|wood|grass|nature/i, paint: { "fill-color": park, "fill-opacity": 0.85 } },
    { match: /water/i, paint: { "fill-color": water, "fill-opacity": 1 } },
    { match: /waterway/i, paint: { "line-color": "#9bcfd8" } },
    { match: /building/i, paint: { "fill-color": buildingFill, "fill-outline-color": buildingStroke } },
    { match: /tunnel/i, paint: { "line-color": road, "line-opacity": 0.5 } },
    { match: /motorway|highway-trunk|trunk/i, paint: { "line-color": motorway } },
    { match: /motorway.*casing|trunk.*casing/i, paint: { "line-color": motorwayCasing } },
    { match: /road|street|primary|secondary|tertiary|residential|service/i, paint: { "line-color": road } },
    { match: /casing/i, paint: { "line-color": roadCasing } },
    { match: /rail/i, paint: { "line-color": "#a89876" } }
  ];

  const layers = map.getStyle()?.layers || [];
  for (const layer of layers) {
    const id = layer.id;
    for (const rule of recolor) {
      if (!rule.match.test(id)) continue;
      if (rule.type && layer.type !== rule.type) continue;
      for (const [prop, val] of Object.entries(rule.paint)) {
        if (!isPaintPropForType(layer.type, prop)) continue;
        try { map.setPaintProperty(id, prop, val); } catch (_) { /* skip */ }
      }
      break;
    }

    // Symbol/text recolor — soften labels
    if (layer.type === "symbol") {
      try {
        map.setPaintProperty(id, "text-color", text);
        map.setPaintProperty(id, "text-halo-color", textHalo);
        map.setPaintProperty(id, "text-halo-width", 1.2);
      } catch (_) { /* skip */ }
    }
  }
}

function isPaintPropForType(layerType, prop) {
  if (prop.startsWith("fill-") && layerType === "fill") return true;
  if (prop.startsWith("line-") && layerType === "line") return true;
  if (prop.startsWith("background-") && layerType === "background") return true;
  return false;
}

// PCN flowing dash animation — gives lines a sense of movement without breaking visual hierarchy
function startPCNFlow() {
  if (!map.getLayer("pcn-line")) return;
  let step = 0;
  const dashSequence = [
    [0, 4, 3, 2],
    [0.5, 4, 3, 1.5],
    [1, 4, 3, 1],
    [1.5, 4, 3, 0.5],
    [2, 4, 3, 0],
    [3, 3, 3, 0],
    [4, 2, 3, 0],
    [4, 1, 3, 0.5],
    [4, 0, 3, 1],
    [3.5, 0, 3, 1.5],
    [3, 0, 3, 2],
    [2.5, 0, 3, 2.5],
    [2, 0, 3, 3],
    [1, 0, 3, 4],
    [0, 0, 3, 5],
    [0, 0.5, 3, 4.5],
    [0, 1, 3, 4],
    [0, 1.5, 3, 3.5],
    [0, 2, 3, 3],
    [0, 2.5, 3, 2.5],
    [0, 3, 3, 2]
  ];
  setInterval(() => {
    step = (step + 1) % dashSequence.length;
    if (map.getLayer("pcn-flow")) {
      try { map.setPaintProperty("pcn-flow", "line-dasharray", dashSequence[step]); } catch (_) {}
    }
  }, 90);
}

map.on("load", async () => {
  setStatus("Loading PCN…", "loading");
  applyWarmPalette();
  map.on("styledata", applyWarmPalette);

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
    paint: { "fill-color": "#bfe0a0", "fill-opacity": 0.55 }
  });

  // PCN — soft glow halo + sharp top line + animated flow dashes
  map.addSource("pcn", { type: "geojson", data: pcn });
  map.addLayer({
    id: "pcn-glow",
    type: "line",
    source: "pcn",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#2eb573",
      "line-blur": 8,
      "line-opacity": 0.28,
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 14, 14, 17, 22]
    }
  });
  map.addLayer({
    id: "pcn-line",
    type: "line",
    source: "pcn",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#2eb573",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.4, 14, 4.5, 17, 7],
      "line-opacity": 0.95
    }
  });
  map.addLayer({
    id: "pcn-flow",
    type: "line",
    source: "pcn",
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: {
      "line-color": "#fdf8ed",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.8, 14, 1.6, 17, 2.4],
      "line-opacity": 0.7,
      "line-dasharray": [0, 4, 3, 2]
    }
  });

  // Ride trail
  map.addSource("trail", {
    type: "geojson",
    data: emptyLine()
  });
  map.addLayer({
    id: "trail-glow",
    type: "line",
    source: "trail",
    layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
    paint: { "line-color": "#f7a440", "line-blur": 6, "line-opacity": 0.4, "line-width": 10 }
  });
  map.addLayer({
    id: "trail-line",
    type: "line",
    source: "trail",
    layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
    paint: { "line-color": "#ec8624", "line-width": 4.5, "line-opacity": 0.95 }
  });

  // Me marker
  map.addSource("me", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "me-accuracy",
    type: "circle",
    source: "me",
    filter: ["==", ["get", "kind"], "accuracy"],
    paint: {
      "circle-radius": ["get", "radius"],
      "circle-color": "#ec8624",
      "circle-opacity": 0.10,
      "circle-stroke-color": "#ec8624",
      "circle-stroke-opacity": 0.35,
      "circle-stroke-width": 1
    }
  });
  map.addLayer({
    id: "me-pulse",
    type: "circle",
    source: "me",
    filter: ["==", ["get", "kind"], "me"],
    paint: {
      "circle-radius": 14,
      "circle-color": "#ec8624",
      "circle-opacity": 0.18
    }
  });
  map.addLayer({
    id: "me-dot",
    type: "circle",
    source: "me",
    filter: ["==", ["get", "kind"], "me"],
    paint: {
      "circle-radius": 8,
      "circle-color": "#ec8624",
      "circle-stroke-color": "#fffaf0",
      "circle-stroke-width": 3
    }
  });

  startPCNFlow();

  const pcnCount = pcn.features?.length ?? 0;
  const parksCount = parks.features?.length ?? 0;
  if (pcnCount === 0 && parksCount === 0) {
    setStatus("No data — run npm run fetch:data", "warn");
  } else if (parksCount === 0) {
    setStatus(`${pcnCount.toLocaleString()} PCN segments`, "ready");
  } else {
    setStatus(`${pcnCount.toLocaleString()} PCN · ${parksCount} parks`, "ready");
  }

  // PCN tap → friendly popup
  map.on("click", "pcn-line", (e) => openPCNPopup(e));
  map.on("click", "pcn-glow", (e) => openPCNPopup(e));
  map.on("mouseenter", "pcn-line", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "pcn-line", () => { map.getCanvas().style.cursor = ""; });
});

function openPCNPopup(e) {
  const f = e.features?.[0];
  if (!f) return;
  const name = f.properties?.PARK || "Park Connector";
  const loop = f.properties?.PCN_LOOP;
  const more = f.properties?.MORE_INFO;
  const html = `
    <div class="pop">
      <div class="pop-eyebrow">Park Connector</div>
      <div class="pop-title">${escapeHtml(name)}</div>
      ${loop && loop !== name ? `<div class="pop-sub">${escapeHtml(loop)}</div>` : ""}
      ${more ? `<a class="pop-link" href="${escapeAttr(more)}" target="_blank" rel="noopener">More on NParks →</a>` : ""}
    </div>`;
  new maplibregl.Popup({ closeButton: true, maxWidth: "260px", offset: 12 })
    .setLngLat(e.lngLat)
    .setHTML(html)
    .addTo(map);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
function emptyLine() {
  return { type: "Feature", geometry: { type: "LineString", coordinates: [] }, properties: {} };
}

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
let followMode = true;

function toggleTrack() {
  if (watchId !== null) stopTrack();
  else startTrack();
}

async function startTrack() {
  if (!("geolocation" in navigator)) {
    setStatus("Geolocation unsupported", "warn");
    return;
  }
  trackBtn.setAttribute("aria-pressed", "true");
  trackBtn.querySelector(".ride-label").textContent = "Stop";
  hud.hidden = false;
  setStatus("Locating…", "tracking");

  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (_) { /* ignore */ }

  watchId = navigator.geolocation.watchPosition(
    onFix,
    (err) => {
      console.warn("GPS error:", err.message);
      setStatus(`GPS: ${err.message}`, "warn");
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function stopTrack() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  trackBtn.setAttribute("aria-pressed", "false");
  trackBtn.querySelector(".ride-label").textContent = "Ride";
  hud.hidden = true;
  setStatus("Idle", "ready");
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function onFix(pos) {
  const { longitude, latitude, accuracy, speed } = pos.coords;
  const coord = [longitude, latitude];

  if (lastFix && accuracy < 25) {
    const d = haversine(lastFix, coord);
    if (d < 100) totalDistMeters += d;
  }
  lastFix = coord;

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

  const kmh = speed && speed > 0 ? (speed * 3.6).toFixed(1) : "0.0";
  $("#hud-speed").textContent = kmh;
  $("#hud-dist").textContent = (totalDistMeters / 1000).toFixed(2);
  $("#hud-acc").textContent = Math.round(accuracy);
  setStatus("Tracking", "tracking");

  if (followMode) map.easeTo({ center: coord, duration: 600 });
}

map.on("dragstart", () => { followMode = false; });
map.on("zoomstart", () => { followMode = false; });

trackBtn.addEventListener("click", toggleTrack);
recenterBtn.addEventListener("click", () => {
  followMode = true;
  if (lastFix) map.easeTo({ center: lastFix, zoom: Math.max(map.getZoom(), 15), duration: 700 });
  else map.easeTo({ center: SG_CENTER, zoom: 11, duration: 700 });
});

layersBtn.addEventListener("click", () => {
  const open = !layersPanel.hidden;
  layersPanel.hidden = open;
  layersBtn.setAttribute("aria-expanded", String(!open));
});

document.addEventListener("click", (e) => {
  if (layersPanel.hidden) return;
  if (layersPanel.contains(e.target) || layersBtn.contains(e.target)) return;
  layersPanel.hidden = true;
  layersBtn.setAttribute("aria-expanded", "false");
});

$("#toggle-pcn").addEventListener("change", (e) => {
  const v = e.target.checked ? "visible" : "none";
  for (const id of ["pcn-line", "pcn-glow", "pcn-flow"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
  }
});
$("#toggle-parks").addEventListener("change", (e) => {
  const v = e.target.checked ? "visible" : "none";
  if (map.getLayer("parks-fill")) map.setLayoutProperty("parks-fill", "visibility", v);
});
$("#toggle-trail").addEventListener("change", (e) => {
  const v = e.target.checked ? "visible" : "none";
  for (const id of ["trail-line", "trail-glow"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
  }
});
$("#clear-trail").addEventListener("click", () => {
  trail = [];
  totalDistMeters = 0;
  const src = map.getSource("trail");
  if (src) src.setData(emptyLine());
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
