# SG Cycle Ops

Singapore Park Connector Network (PCN) cycling map with live GPS tracking. Open-source PWA. No Google Maps. No login. Just a map you can open and ride with.

> Built because custom layers in Google My Maps keep losing markers, and Google Maps cycling routing in Singapore is weak. This app uses official `data.gov.sg` data on top of community OpenStreetMap tiles, all rendered with MapLibre GL.

## Features

- **Park Connector Network** rendered as glowing green lines with flowing dash animation
- **Parks** rendered as soft green polygons
- **Live GPS** dot with accuracy halo (`watchPosition`, high-accuracy, throttled to ~4 Hz)
- **Ride trail** (locally drawn breadcrumb) with speed + distance HUD
- **Follow-me camera** that auto-disables when you pan
- **Wake Lock** so your screen stays on while riding
- **Installable PWA** — add to home screen, runs full-screen
- **Offline-ready**: tiles, datasets, and app shell are cached by the service worker
- **Pure HTML/CSS/JS** — no build step, no framework, no API key
- **Cycling paths overlay** — red lines from data.gov.sg / Google My Maps, 1,400+ curated routes
- **GPX export** — download your recorded trail as a `.gpx` file
- **Strava sync** — connect your account and upload rides directly (OAuth2 via Netlify Function)
- **Unit toggle** — switch between metric (km/h, km) and imperial (mph, mi)
- **Graceful failure** — fallback UI if MapLibre fails to load
- **Auto-updates** — service worker detects new deploys and refreshes
- **Keyboard accessible** — full Tab/Enter/Escape support
- **Dark mode** — respects `prefers-color-scheme`

## Stack

- [MapLibre GL JS](https://maplibre.org) — open-source map renderer
- [OpenFreeMap](https://openfreemap.org) — free OSM-based vector tiles
- [data.gov.sg](https://data.gov.sg) — official PCN + parks + cycling datasets
- Native `Geolocation`, `Wake Lock`, `Service Worker`, `Cache Storage` APIs

## Quick start

```bash
git clone git@github.com:cloudcap10/sg-cycle-ops.git
cd sg-cycle-ops

# Pull latest PCN + parks + cycling data from data.gov.sg
npm install
npm run fetch:data

# Serve locally (any static server works)
npm run dev
# → http://localhost:5173
```

Open the URL on your phone (must be on the same network), then **Add to Home Screen** for full-screen PWA mode.

> Geolocation requires HTTPS on production. Locally `http://localhost` is exempt.

## Configuration

The fetcher uses these dataset IDs from `data.gov.sg`. Override via env vars if you find better ones:

```bash
PCN_DATASET_ID=d_xxxxxxxx \
PARKS_DATASET_ID=d_yyyyyyyy \
CYCLING_DATASET_ID=d_zzzzzzzzzz \
npm run fetch:data
```

Confirm IDs at https://data.gov.sg/datasets — search for *park connector*, *parks*, and *cycling*.

## Strava sync

1. Create a Strava API app at https://www.strava.com/settings/api
2. Set redirect URI to: `https://YOUR-SITE/.netlify/functions/strava/callback`
3. Add these environment variables in Netlify → Site settings → Environment variables:
   - `STRAVA_CLIENT_ID`
   - `STRAVA_CLIENT_SECRET`
   - `SITE_URL` (e.g., `https://your-site.netlify.app`)
4. Redeploy — the **Connect** button appears in the layers panel
5. Click **Connect** → authorize in the Strava popup → done!
6. After a ride, click **Upload** to send the GPX to Strava

## Project layout

```
.
├── index.html              # Page shell, controls, HUD
├── styles.css              # Warm cream UI with dark mode
├── app.js                  # Map init, GPS, layers, trail, Strava
├── sw.js                   # Service worker (cache-first tiles, SWR data)
├── manifest.json           # PWA manifest
├── package.json            # Scripts including `build` for Netlify
├── netlify.toml            # Netlify config (Functions + build)
├── public/
│   ├── icon.svg            # App icon
│   ├── pcn.geojson         # Park Connector lines (fetched)
│   ├── parks.geojson       # Parks polygons (fetched)
│   ├── cycling.geojson     # Cycling paths (fetched, ~1,500 segments)
│   └── cycling.kml         # Original KML backup
├── scripts/
│   └── fetch-data.mjs      # data.gov.sg → GeoJSON + KML filter pipeline
└── netlify/
    └── functions/
        └── strava.js       # Strava OAuth2 + upload serverless function
```

## How offline works

1. First visit: service worker caches the app shell + map tiles you've panned across + the GeoJSON files
2. Subsequent visits: everything loads from cache instantly
3. Lose signal mid-ride: tiles you've already viewed stay rendered; GPS continues to work natively

To pre-cache an area, pan and zoom across it once before you ride.

## Deploy

Any static host works. Recommended:

- **Netlify** — `npm run build` fetches fresh data, then drag the folder or push to GitHub for auto-deploys
- **Vercel** — `vercel deploy` (zero config)
- **GitHub Pages** — push, then enable Pages on the `main` branch
- **Cloudflare Pages** — connect the GitHub repo, framework preset *None*

For Strava sync, use Netlify (it supports serverless functions out of the box).

## Roadmap (maybe)

- [ ] Hazard / closure reports (community-submitted, time-decayed)
- [ ] Water-point / toilet / bike-shop POIs
- [ ] Snap-to-PCN routing using PostGIS
- [x] GPX export of recorded trails ✅
- [x] Strava sync ✅

Driven by actual riding pain. Not adding anything until I miss it on a ride.

## License

MIT — see [LICENSE](./LICENSE).

## Attribution

- Park Connector + parks data © Singapore Government, [Singapore Open Data License](https://beta.data.gov.sg/open-data-license)
- Basemap tiles © [OpenFreeMap](https://openfreemap.org), data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
- Cycling paths data exported from [Google My Maps](https://www.google.com/maps/d/viewer?mid=13PRb7OmKXskuiAm_a5bujIIDO3NK4Gn9)

## Contributing

Issues and PRs welcome. Keep changes small and rideable. If it doesn't make a ride better, it doesn't ship.