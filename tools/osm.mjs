// Shared helpers for turning OpenStreetMap smoking-area data into the shape
// used by data/smoking-spots.json.
//
// OSM tags we care about (https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dsmoking_area):
//   amenity=smoking_area   — a dedicated smoking place
//   smoking=isolated|yes   — on shops/stations that provide a smoking room
//
// Kept dependency-free so it runs under plain `node` and can be unit-tested.

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

/** Overpass QL for every smoking area inside a bounding box. */
export function buildBboxQuery({ south, west, north, east }, timeout = 60) {
  const bbox = `${south},${west},${north},${east}`;
  return `[out:json][timeout:${timeout}];
(
  node["amenity"="smoking_area"](${bbox});
  way["amenity"="smoking_area"](${bbox});
  relation["amenity"="smoking_area"](${bbox});
);
out center tags;`;
}

/** Overpass QL for a named administrative area (e.g. "東京都", "千葉県"). */
export function buildAreaQuery(areaName, timeout = 180) {
  return `[out:json][timeout:${timeout}];
area["name"="${areaName}"]["boundary"="administrative"]->.a;
(
  node["amenity"="smoking_area"](area.a);
  way["amenity"="smoking_area"](area.a);
  relation["amenity"="smoking_area"](area.a);
);
out center tags;`;
}

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function pick(tags, keys) {
  for (const k of keys) if (tags[k]) return tags[k];
  return "";
}

/** Human-readable name for an OSM element, falling back to a generic label. */
export function osmName(tags = {}) {
  const n = pick(tags, ["name:ja", "name", "operator:ja", "operator", "brand"]);
  return n || "喫煙所（OpenStreetMap）";
}

/** Best-effort address from OSM addr:* tags. */
export function osmAddress(tags = {}) {
  const parts = [
    tags["addr:province"] || tags["addr:state"],
    tags["addr:city"],
    tags["addr:suburb"],
    tags["addr:quarter"],
    tags["addr:neighbourhood"],
    tags["addr:block_number"],
    tags["addr:housenumber"],
  ].filter(Boolean);
  const addr = parts.join("");
  const note = pick(tags, ["description:ja", "description", "note:ja", "note"]);
  return [addr, note].filter(Boolean).join(" ").trim();
}

/** Coverage/shelter wording matching the rest of the dataset. */
export function osmType(tags = {}) {
  const covered = tags.covered === "yes" || tags.indoor === "yes" || tags.shelter === "yes";
  const base = covered ? "屋内" : "屋外";
  const heated = tags["smoking:heated_tobacco"] === "only" || tags["smoking:electronic"] === "only";
  return `${base}（OpenStreetMap${heated ? "・加熱式専用" : ""}）`;
}

/**
 * Convert raw Overpass elements into dataset entries.
 * Elements without usable coordinates are dropped.
 */
export function elementsToSpots(elements = []) {
  const out = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    const tags = el.tags || {};
    out.push({
      id: `osm-${el.type}-${el.id}`,
      name: osmName(tags),
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      address: osmAddress(tags),
      type: osmType(tags),
      sources: [
        `OpenStreetMap (ODbL) https://www.openstreetmap.org/${el.type}/${el.id}`,
      ],
    });
  }
  return out;
}

/**
 * Merge OSM spots into the curated dataset.
 * Curated entries always win: an OSM spot is dropped when it duplicates an
 * existing id or sits within `radius` metres of a curated one.
 */
export function mergeSpots(curated, osmSpots, radius = 60) {
  const byId = new Set(curated.map((s) => s.id));
  const kept = [];
  let dupId = 0;
  let dupNear = 0;

  for (const s of osmSpots) {
    if (byId.has(s.id)) {
      dupId++;
      continue;
    }
    const near = curated.some((c) => haversine(c, s) <= radius);
    if (near) {
      dupNear++;
      continue;
    }
    byId.add(s.id);
    kept.push(s);
  }

  return { merged: [...curated, ...kept], added: kept.length, dupId, dupNear };
}
