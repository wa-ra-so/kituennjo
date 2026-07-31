#!/usr/bin/env node
// Import designated/public smoking-area lists published by Japanese
// municipalities as open-data CSV into data/smoking-spots.json.
//
//   node tools/import-opendata.mjs --taito                       # known source
//   node tools/import-opendata.mjs --taito --show-headers        # inspect columns only, no write
//   node tools/import-opendata.mjs --url <csv-url> --city 台東区 --dry-run
//
// Curated/OSM entries are never overwritten: rows that duplicate an existing
// spot (same id, or within 60 m) are skipped — same rule as import-osm.mjs.
//
// Add more known sources to KNOWN_SOURCES below as they're found. Municipal
// CSVs vary in encoding (often Shift_JIS) and column names; opendata.mjs
// auto-detects both, but always run --show-headers first on a new source to
// confirm it guessed the right columns before writing.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodeCsvBuffer, parseCsv, rowsToObjects, rowsToSpots } from "./opendata.mjs";
import { mergeSpots } from "./osm.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "smoking-spots.json");

const KNOWN_SOURCES = {
  taito: {
    city: "台東区",
    idPrefix: "od-taito",
    url: "https://www.city.taito.lg.jp/kusei/online/opendata/seikatu/shisethutizujouhou.files/20230601_koshukitsuenjo_shuseigo.csv",
    type: "屋外（公衆喫煙所・オープンデータ）",
    sourceLabel:
      "台東区オープンデータ「公衆喫煙所」 https://www.city.taito.lg.jp/kenchiku/machibika/kosyu/webmap.html",
  },
};

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const showHeaders = argv.includes("--show-headers");

  const knownKey = Object.keys(KNOWN_SOURCES).find((k) => argv.includes(`--${k}`));
  const urlIdx = argv.indexOf("--url");
  const cityIdx = argv.indexOf("--city");

  let source;
  if (knownKey) {
    source = KNOWN_SOURCES[knownKey];
  } else if (urlIdx >= 0) {
    const city = cityIdx >= 0 ? argv[cityIdx + 1] : "自治体";
    const url = argv[urlIdx + 1];
    source = {
      city,
      idPrefix: `od-${city}`,
      url,
      type: "屋外（公衆喫煙所・オープンデータ）",
      sourceLabel: `${city}オープンデータ「公衆喫煙所」 ${url}`,
    };
  } else {
    console.error(
      "使い方: node tools/import-opendata.mjs --taito | --url <csv-url> --city <自治体名> [--dry-run] [--show-headers]"
    );
    process.exit(1);
  }

  console.log(`取得中: ${source.url}`);
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const text = decodeCsvBuffer(buffer);
  const rows = parseCsv(text);
  const objs = rowsToObjects(rows);
  console.log(`CSV: ${objs.length}行`);

  const { spots, skipped, columns } = rowsToSpots(objs, {
    idPrefix: source.idPrefix,
    sourceLabel: source.sourceLabel,
    typeLabel: source.type,
    cityLabel: source.city,
  });

  console.log(
    `列の自動判定: 名称=${columns.nameKey ?? "(不明)"} / 住所=${columns.addrKey ?? "(不明)"} / 緯度=${columns.latKey ?? "(不明)"} / 経度=${columns.lngKey ?? "(不明)"}`
  );

  if (showHeaders) {
    console.log("\nヘッダー一覧:", objs[0] ? Object.keys(objs[0]) : "(データなし)");
    console.log("先頭2行:", objs.slice(0, 2));
    return;
  }

  console.log(`座標のある${spots.length}件 / 座標なしでスキップ${skipped.length}件`);

  const curated = JSON.parse(await readFile(DATA, "utf8"));
  const { merged, added, dupId, dupNear } = mergeSpots(curated, spots);
  console.log(`重複スキップ: id一致 ${dupId}件 / 60m以内 ${dupNear}件`);
  console.log(`追加: ${added}件  →  合計 ${merged.length}件`);

  if (dryRun) {
    console.log("\n--dry-run のため書き込みませんでした。");
    return;
  }
  if (added === 0) {
    console.log("\n追加分がないため書き込みをスキップしました。");
    return;
  }

  await writeFile(DATA, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(`\n${DATA} を更新しました。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
