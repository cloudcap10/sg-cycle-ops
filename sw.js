// SG Cycle Ops — service worker
// Caches app shell + map tiles for offline cycling.

const VERSION = new Date().toISOString().slice(0, 10); // e.g. "2026-05-10"
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;
const TILE_CACHE = `tiles-${VERSION}`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./public/icon.svg",
  "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css",
  "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => ![SHELL_CACHE, DATA_CACHE, TILE_CACHE].includes(k))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

const TILE_HOSTS = ["tiles.openfreemap.org", "openfreemap.org"];

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Map tiles → cache-first
  if (TILE_HOSTS.some((h) => url.host.endsWith(h))) {
    event.respondWith(cacheFirst(request, TILE_CACHE, 500));
    return;
  }

  // PCN/parks GeoJSON → stale-while-revalidate
  if (url.pathname.endsWith(".geojson")) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  // App shell → cache-first
  if (SHELL_ASSETS.some((path) => request.url.endsWith(path.replace("./", "")))) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // Default → network, fall back to cache
  event.respondWith(
    fetch(request).catch(() => caches.match(request).then((r) => r || new Response("", { status: 504 })))
  );
});

async function cacheFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      cache.put(request, fresh.clone());
      if (maxEntries) trimCache(cacheName, maxEntries);
    }
    return fresh;
  } catch (err) {
    return cached || new Response("", { status: 504 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || networkPromise;
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  for (let i = 0; i < keys.length - maxEntries; i++) {
    await cache.delete(keys[i]);
  }
}
