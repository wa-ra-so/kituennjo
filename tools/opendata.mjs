// Shared helpers for importing Japanese municipal open-data CSVs (指定喫煙場所 /
// 公衆喫煙所 lists) into the shape used by data/smoking-spots.json.
//
// Municipal open-data portals publish these as plain CSV, often encoded as
// Shift_JIS rather than UTF-8, with inconsistent column names between cities.
// Kept dependency-free so it runs under plain `node`.

export function decodeCsvBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** Minimal RFC4180-ish CSV parser: quoted fields, embedded commas/newlines, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // skip; \n follows
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function rowsToObjects(rows) {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = (r[i] ?? "").trim();
    });
    return obj;
  });
}

const NAME_KEYS = ["施設名称", "公衆喫煙所名", "喫煙所名", "施設名", "名称", "名前"];
const ADDR_KEYS = ["所在地住所", "設置場所住所", "所在地", "住所", "設置場所"];
const LAT_KEYS = ["緯度", "lat", "latitude", "Lat"];
const LNG_KEYS = ["経度", "lon", "lng", "longitude", "Lon", "Lng"];

function findKey(obj, candidates) {
  const keys = Object.keys(obj);
  for (const c of candidates) {
    const hit = keys.find((k) => k === c || k.includes(c));
    if (hit) return hit;
  }
  return null;
}

/**
 * Convert parsed CSV row-objects into dataset entries.
 * Rows without parseable lat/lng are dropped (returned separately as `skipped`)
 * since a name/address-only row can't be placed on the map without geocoding.
 */
export function rowsToSpots(objs, { idPrefix, sourceLabel, typeLabel, cityLabel }) {
  const spots = [];
  const skipped = [];
  if (objs.length === 0) return { spots, skipped, columns: {} };

  const sample = objs[0];
  const nameKey = findKey(sample, NAME_KEYS);
  const addrKey = findKey(sample, ADDR_KEYS);
  const latKey = findKey(sample, LAT_KEYS);
  const lngKey = findKey(sample, LNG_KEYS);

  objs.forEach((obj, i) => {
    const lat = latKey ? parseFloat(obj[latKey]) : NaN;
    const lng = lngKey ? parseFloat(obj[lngKey]) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      skipped.push(obj);
      return;
    }
    const name = (nameKey && obj[nameKey]) || `喫煙所（${cityLabel}）`;
    const address = (addrKey && obj[addrKey]) || "";
    spots.push({
      id: `${idPrefix}-${i}`,
      name,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      address,
      type: typeLabel,
      sources: [sourceLabel],
    });
  });

  return { spots, skipped, columns: { nameKey, addrKey, latKey, lngKey } };
}
