#!/usr/bin/env node
// Import smoking areas from OpenStreetMap into data/smoking-spots.json.
//
//   node tools/import-osm.mjs 東京都 千葉県          # by administrative area
//   node tools/import-osm.mjs --all-japan            # every prefecture
//   node tools/import-osm.mjs --dry-run 東京都        # show counts, write nothing
//   node tools/import-osm.mjs --from response.json   # use a saved Overpass reply
//
// Curated entries in the file are never overwritten: OSM results that duplicate
// an existing spot (same id, or within 60 m) are skipped.
//
// Data © OpenStreetMap contributors, licensed under the ODbL.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  OVERPASS_ENDPOINTS,
  buildAreaQuery,
  elementsToSpots,
  mergeSpots,
} from "./osm.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "smoking-spots.json");

const PREFECTURES = [
  "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県",
  "埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県",
  "岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
  "鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県",
  "佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${endpoint}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn(`  ! ${endpoint} failed: ${err.message}`);
    }
  }
  throw lastErr ?? new Error("all Overpass endpoints failed");
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const fromIdx = argv.indexOf("--from");
  const fromFile = fromIdx >= 0 ? argv[fromIdx + 1] : null;
  const areas = argv.includes("--all-japan")
    ? PREFECTURES
    : argv.filter((a, i) => !a.startsWith("--") && i !== fromIdx + 1);

  const curated = JSON.parse(await readFile(DATA, "utf8"));
  console.log(`既存データ: ${curated.length}件`);

  let elements = [];

  if (fromFile) {
    console.log(`保存済みレスポンスを読み込み: ${fromFile}`);
    const saved = JSON.parse(await readFile(fromFile, "utf8"));
    elements = saved.elements ?? saved;
  } else {
    if (areas.length === 0) {
      console.error(
        "使い方: node tools/import-osm.mjs <都道府県名...> | --all-japan | --from <file>"
      );
      process.exit(1);
    }
    for (const [i, area] of areas.entries()) {
      process.stdout.write(`[${i + 1}/${areas.length}] ${area} …`);
      try {
        const json = await overpass(buildAreaQuery(area));
        const n = json.elements?.length ?? 0;
        elements.push(...(json.elements ?? []));
        console.log(` ${n}件`);
      } catch (err) {
        console.log(` 失敗 (${err.message})`);
      }
      if (i < areas.length - 1) await sleep(2000); // be polite to Overpass
    }
  }

  const spots = elementsToSpots(elements);
  console.log(`\nOSMから取得: ${elements.length}要素 → 座標のある${spots.length}件`);

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
  console.log("データ © OpenStreetMap contributors (ODbL)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
