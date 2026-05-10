// SG Cycle Ops — main app
// Loads MapLibre, paints a warm cream basemap, draws PCN with a flowing
// dash animation, watches GPS, records a ride trail.

const CONFIG = {
  MAX_TRAIL_POINTS: 5000,
  MIN_GPS_ACCURACY: 25, // meters — ignore fixes worse than this for distance
  MIN_SEGMENT_DISTANCE: 100, // meters — minimum between counted segments
  FLOW_INTERVAL_MS: 90,
  FOLLOW_DURATION_MS: 600,
  RECENTER_DURATION_MS: 700,
  HUD_THROTTLE_MS: 250, // ~4 Hz visual cap
  MAP_MIN_ZOOM: 9,
  MAP_MAX_ZOOM: 19,
};

const SG_CENTER = [103.8198, 1.3521];
const SG_BOUNDS = [
  [103.59, 1.15],
  [104.10, 1.48]
];

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const PCN_URL = "./public/pcn.geojson";
const PARKS_URL = "./public/parks.geojson";
const CYCLING_URL = "./public/cycling.geojson";

const $ = (sel) => document.querySelector(sel);
const statusText = $("#status-text");
const statusPill = $("#status");

function setStatus(msg, state) {
  statusText.textContent = msg;
  if (state) statusPill.dataset.state = state;
  else delete statusPill.dataset.state;
}

// ---------- Map init with graceful failure ----------

let map;
try {
map = new maplibregl.Map({
    container: "map",
    style: STYLE_URL,
    center: SG_CENTER,
    zoom: 11,
    minZoom: CONFIG.MAP_MIN_ZOOM,
    maxZoom: CONFIG.MAP_MAX_ZOOM,
    maxBounds: SG_BOUNDS,
    attributionControl: false,
    cooperativeGestures: false,
    pitchWithRotate: false
  });
  map.on("error", (e) => {
    console.warn("Map error:", e?.error?.message || e);
    showFallback("Map failed to load — check your connection and try again.");
  });
} catch (err) {
  showFallback("Map library failed to load — check your connection or disable ad blockers.");
}

function showFallback(msg) {
  const el = document.getElementById("map");
  if (el) {
    el.innerHTML =
      `<div class="fallback">
         <h2>Map unavailable</h2>
         <p>${msg}</p>
         <button onclick="location.reload()">Retry</button>
       </div>`;
  }
}

// ---------- helpers ----------

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

// ---------- Warm palette recolor ----------

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

// ---------- PCN flowing dash animation (rAF) ----------

let flowRAF = null;
let flowStep = 0;
let lastFlowStepTime = 0;

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

function animateFlow(now) {
  if (now - lastFlowStepTime >= CONFIG.FLOW_INTERVAL_MS) {
    flowStep = (flowStep + 1) % dashSequence.length;
    if (map.getLayer("pcn-flow")) {
      try { map.setPaintProperty("pcn-flow", "line-dasharray", dashSequence[flowStep]); } catch (_) {}
    } else {
      flowRAF = null;
      return;
    }
    lastFlowStepTime = now;
  }
  flowRAF = requestAnimationFrame(animateFlow);
}

function startPCNFlow() {
  if (!map.getLayer("pcn-line")) return;
  if (flowRAF) cancelAnimationFrame(flowRAF);
  flowStep = 0;
  lastFlowStepTime = performance.now();
  flowRAF = requestAnimationFrame(animateFlow);
}

// ---------- Layers & map setup ----------

map.on("load", async () => {
  setStatus("Loading PCN…", "loading");
  applyWarmPalette();
  map.on("styledata", applyWarmPalette);

  // Cycling paths — red overlay
  const cycling = await loadGeoJSON(CYCLING_URL);

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
      "line-dasharray": dashSequence[0]
    }
  });

  // Cycling paths — red overlay
  const cyclingCount = cycling.features?.length ?? 0;
  map.addSource("cycling", { type: "geojson", data: cycling });
  ["cycling-line", "cycling-glow"].forEach((id, i) => {
    map.addLayer({
      id,
      type: "line",
      source: "cycling",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: i === 0
        ? { "line-color": "#e63946", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2, 16, 5], "line-opacity": 0.7, "line-blur": 2 }
        : { "line-color": "#e63946", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 6, 16, 14], "line-opacity": 0.15, "line-blur": 6 }
    });
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
  const parts = [];
  if (pcnCount) parts.push(`${pcnCount.toLocaleString()} PCN`);
  if (parksCount) parts.push(`${parksCount} parks`);
  if (cyclingCount) parts.push(`${cyclingCount} cycling paths`);
  if (parts.length === 0) {
    setStatus("No data — run npm run fetch:data", "warn");
  } else {
    setStatus(parts.join(" · "), "ready");
  }

  // Cycling path tap → simple popup
  map.on("click", "cycling-line", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const name = f.properties?.name || f.properties?.Name || "Cycling Path";
    new maplibregl.Popup({ closeButton: true, maxWidth: "200px", offset: 12 })
      .setLngLat(e.lngLat)
      .setHTML(`<div class="pop"><div class="pop-title">${escapeHtml(name)}</div></div>`)
      .addTo(map);
  });
  map.on("mouseenter", "cycling-line", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "cycling-line", () => { map.getCanvas().style.cursor = ""; });

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

// ---------- Unit helpers ----------

let imperial = false;

function formatSpeed(ms) {
  return imperial ? (ms * 2.23694).toFixed(1) : (ms * 3.6).toFixed(1);
}
function formatDist(m) {
  return imperial ? (m / 1609.344).toFixed(2) : (m / 1000).toFixed(2);
}
function speedUnit() { return imperial ? "mph" : "km/h"; }
function distUnit() { return imperial ? "mi" : "km"; }

function updateHUD(pos) {
  const kmh = pos?.coords?.speed ? formatSpeed(pos.coords.speed) : "0.0";
  $("#hud-speed").textContent = kmh;
  $("#hud-speed-unit").textContent = speedUnit();
  $("#hud-dist").textContent = formatDist(totalDistMeters);
  $("#hud-dist-unit").textContent = distUnit();
  $("#hud-acc").textContent = Math.round(pos?.coords?.accuracy ?? 0);
}

function rebuildHUD() {
  const spdEl = $("#hud-speed");
  const dstEl = $("#hud-dist");
  const spdUnitEl = $("#hud-speed-unit");
  const dstUnitEl = $("#hud-dist-unit");

  if (!spdUnitEl) {
    spdEl.insertAdjacentHTML("afterend", `<span class="hud-u" id="hud-speed-unit">${speedUnit()}</span>`);
  } else {
    spdUnitEl.textContent = speedUnit();
  }
  if (!dstUnitEl) {
    dstEl.insertAdjacentHTML("afterend", `<span class="hud-u" id="hud-dist-unit">${distUnit()}</span>`);
  } else {
    dstUnitEl.textContent = distUnit();
  }
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

// Trail dirty flag for rAF batching
let trailDirty = false;
let lastFixRender = 0;

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

  // Distance tracking — only count good fixes
  if (lastFix && accuracy < CONFIG.MIN_GPS_ACCURACY) {
    const d = haversine(lastFix, coord);
    if (d >= CONFIG.MIN_SEGMENT_DISTANCE) totalDistMeters += d;
  }
  lastFix = coord;

  // Accumulate trail points
  trail.push(coord);
  if (trail.length > CONFIG.MAX_TRAIL_POINTS) trail.shift();
  trailDirty = true;

  // Update GPS marker source immediately for responsiveness
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

  // Throttled HUD + map trail render (~4 Hz)
  const now = performance.now();
  if (now - lastFixRender >= CONFIG.HUD_THROTTLE_MS) {
    lastFixRender = now;

    // Batch trail source update with rAF
    if (trailDirty) {
      trailDirty = false;
      requestAnimationFrame(() => {
        const trailSrc = map.getSource("trail");
        if (trailSrc) {
          trailSrc.setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: trail },
            properties: {}
          });
        }
      });
    }

    const kmh = speed && speed > 0 ? formatSpeed(speed) : "0.0";
    $("#hud-speed").textContent = kmh;
    $("#hud-dist").textContent = formatDist(totalDistMeters);
    $("#hud-acc").textContent = Math.round(accuracy);
    setStatus("Tracking", "tracking");
  }

  if (followMode) map.easeTo({ center: coord, duration: CONFIG.FOLLOW_DURATION_MS });
}

map.on("dragstart", () => { followMode = false; });
map.on("zoomstart", () => { followMode = false; });

trackBtn.addEventListener("click", toggleTrack);
recenterBtn.addEventListener("click", () => {
  followMode = true;
  if (lastFix) map.easeTo({ center: lastFix, zoom: Math.max(map.getZoom(), 15), duration: CONFIG.RECENTER_DURATION_MS });
  else map.easeTo({ center: SG_CENTER, zoom: 11, duration: CONFIG.RECENTER_DURATION_MS });
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
$("#toggle-cycling").addEventListener("change", (e) => {
  const v = e.target.checked ? "visible" : "none";
  for (const id of ["cycling-line", "cycling-glow"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
  }
});
$("#clear-trail").addEventListener("click", () => {
  trail = [];
  totalDistMeters = 0;
  const src = map.getSource("trail");
  if (src) src.setData(emptyLine());
  $("#hud-dist").textContent = "0.00";
  $("#hud-dist-unit").textContent = distUnit();
});

// ---------- Unit toggle ----------
$("#toggle-imperial").addEventListener("change", (e) => {
  imperial = e.target.checked;
  rebuildHUD();
  updateHUD(lastFix);
});

// ---------- GPX export ----------
$("#export-gpx").addEventListener("click", () => {
  if (trail.length < 2) {
    setStatus("No trail to export", "warn");
    return;
  }
  const now = new Date();
  const header = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="SG Cycle Ops">',
    `<trk><name>Ride ${now.toISOString()}</name><trkseg>`
  ].join("\n");
  const points = trail.map(([lon, lat]) =>
    `    <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><time>${now.toISOString()}</time></trkpt>`
  ).join("\n");
  const gpx = header + "\n" + points + "\n  </trkseg></trk></gpx>";

  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ride-${now.toISOString().slice(0, 19).replace(/:/g, "-")}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Trail exported as GPX", "ready");
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

// ---------- Keyboard accessibility ----------

layersBtn.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    layersBtn.click();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !layersPanel.hidden) {
    layersPanel.hidden = true;
    layersBtn.setAttribute("aria-expanded", "false");
    layersBtn.focus();
  }
});

// ---------- Service worker ----------

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    reg.addEventListener("updatefound", () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          setStatus("Update available — refreshing…", "warn");
          setTimeout(() => window.location.reload(), 2000);
        }
      });
    });
  }).catch((err) => {
    console.warn("SW registration failed:", err.message);
  });
}
