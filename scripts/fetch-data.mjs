#!/usr/bin/env node
/**
 * Fetch PCN + parks datasets from data.gov.sg → save to /public.
 *
 * data.gov.sg uses a 2-step download API:
 *   1. POST /poll-download → returns a signed URL
 *   2. GET signed URL → actual file (KML / GeoJSON / SHP / CSV)
 *
 * KML responses are converted to GeoJSON via @tmcw/togeojson at runtime.
 * LineString geometries are simplified via Douglas-Peucker to reduce
 * payload size for mobile consumption.
 *
 * Override defaults via env or CLI:
 *   PCN_DATASET_ID=d_xxx PARKS_DATASET_ID=d_yyy node scripts/fetch-data.mjs
 *
 * If a dataset cannot be fetched the script writes an empty FeatureCollection
 * so the app continues to load (with no overlay).
 */

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "public");

// Simplification tolerance in degrees — ~10m at equator
const SIMPLIFY_TOLERANCE = 0.0001;

const DATASETS = [
  {
    label: "PCN",
    id: process.env.PCN_DATASET_ID || "d_a69ef89737379f231d2ae93fd1c5707f",
    out: "pcn.geojson"
  },
  {
    label: "Parks",
    id: process.env.PARKS_DATASET_ID || "",
    out: "parks.geojson"
  }
];

const API_BASE = "https://api-open.data.gov.sg/v1/public/api/datasets";

async function pollSignedUrl(datasetId) {
  const url = `${API_BASE}/${datasetId}/poll-download`;
  const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`poll-download ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const signedUrl = json?.data?.url;
  if (!signedUrl) throw new Error(`no signed url in response: ${JSON.stringify(json).slice(0, 200)}`);
  return { signedUrl, format: detectFormat(signedUrl) };
}

function detectFormat(url) {
  const lower = url.toLowerCase();
  if (lower.includes(".geojson")) return "geojson";
  if (lower.includes(".kml")) return "kml";
  if (lower.includes(".kmz")) return "kmz";
  if (lower.includes(".json")) return "json";
  if (lower.includes(".zip")) return "zip";
  return "unknown";
}

async function downloadAsGeoJSON(signedUrl, format) {
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`download ${res.status}: ${signedUrl}`);

  if (format === "geojson" || format === "json") {
    const text = await res.text();
    const json = JSON.parse(text);
    return simplifyGeoJSON(normalizeGeoJSON(json));
  }

  if (format === "kml") {
    const xml = await res.text();
    return simplifyGeoJSON(await kmlToGeoJSON(xml));
  }

  throw new Error(`unsupported format: ${format} (${signedUrl})`);
}

async function kmlToGeoJSON(xml) {
  const [{ DOMParser }, togeojson] = await Promise.all([
    import("@xmldom/xmldom"),
    import("@tmcw/togeojson")
  ]);
  const dom = new DOMParser().parseFromString(xml, "text/xml");
  return togeojson.kml(dom);
}

function normalizeGeoJSON(input) {
  if (input?.type === "FeatureCollection") return input;
  if (input?.type === "Feature") return { type: "FeatureCollection", features: [input] };
  if (Array.isArray(input?.features)) return { type: "FeatureCollection", features: input.features };
  return { type: "FeatureCollection", features: [] };
}

function emptyCollection() {
  return { type: "FeatureCollection", features: [] };
}

// Douglas-Peucker line simplification
function simplifyGeoJSON(geojson, tolerance = SIMPLIFY_TOLERANCE) {
  const features = geojson.features.map((f) => {
    if (f.geometry?.type === "LineString") {
      f = { ...f, geometry: { ...f.geometry } };
      f.geometry.coordinates = simplifyDP(f.geometry.coordinates, tolerance);
    } else if (f.geometry?.type === "MultiLineString") {
      f = { ...f, geometry: { ...f.geometry } };
      f.geometry.coordinates = f.geometry.coordinates.map((line) =>
        simplifyDP(line, tolerance)
      );
    }
    return f;
  });
  return { ...geojson, features };
}

function simplifyDP(points, tolerance) {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const [start, end] = [points[0], points[points.length - 1]];

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegmentDist(points[i], start, end);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    const left = simplifyDP(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyDP(points.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [start, end];
}

function pointToSegmentDist(p, a, b) {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

async function main() {
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });

  for (const ds of DATASETS) {
    const outPath = join(OUT_DIR, ds.out);

    if (!ds.id) {
      console.warn(`[skip] ${ds.label}: no dataset id set, writing empty file`);
      await writeFile(outPath, JSON.stringify(emptyCollection()));
      continue;
    }

    try {
      console.log(`[fetch] ${ds.label} (${ds.id})`);
      const { signedUrl, format } = await pollSignedUrl(ds.id);
      console.log(`  format: ${format}`);
      const geojson = await downloadAsGeoJSON(signedUrl, format);
      const count = geojson?.features?.length ?? 0;
      await writeFile(outPath, JSON.stringify(geojson));
      console.log(`  wrote ${count} features → public/${ds.out}`);
    } catch (err) {
      console.error(`[fail] ${ds.label}: ${err.message}`);
      if (!existsSync(outPath)) {
        await writeFile(outPath, JSON.stringify(emptyCollection()));
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
