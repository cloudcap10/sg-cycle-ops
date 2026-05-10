#!/usr/bin/env node
/**
 * Fetch PCN + parks datasets from data.gov.sg → save to /public.
 *
 * data.gov.sg uses a 2-step download API:
 *   1. POST /poll-download → returns a signed URL
 *   2. GET signed URL → actual file (KML / GeoJSON / SHP / CSV)
 *
 * KML responses are converted to GeoJSON via @tmcw/togeojson at runtime.
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
    return normalizeGeoJSON(json);
  }

  if (format === "kml") {
    const xml = await res.text();
    return await kmlToGeoJSON(xml);
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
