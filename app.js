const STORAGE_KEY = "kituennjo:user-spots";
const DEFAULT_CENTER = [35.6812, 139.7671]; // 東京駅

const statusEl = document.getElementById("status");
const listEl = document.getElementById("spot-list");
const segmented = document.getElementById("radius-segmented");
const locateBtn = document.getElementById("locate-btn");
const addSpotBtn = document.getElementById("add-spot-btn");
const itemTemplate = document.getElementById("spot-item-template");
const sheet = document.getElementById("sheet");
const sheetHandle = document.getElementById("sheet-handle");
const fabStack = document.querySelector(".fab-stack");
const osmBtn = document.getElementById("osm-btn");
const searchInput = document.getElementById("search-input");
const searchClear = document.getElementById("search-clear");
const searchResults = document.getElementById("search-results");
const refChip = document.getElementById("ref-chip");
const refChipLabel = document.getElementById("ref-chip-label");
const refChipClear = document.getElementById("ref-chip-clear");

let map;
let userPos = null;
// The point distances are measured from. Normally the user's location, but a
// search result takes over so you can inspect another area's smoking spots.
let searchPos = null;
let searchLabel = "";
let userMarker = null;
let accuracyCircle = null;
let allSpots = [];
let radius = 1000;
const markerLayer = L.layerGroup();
const markerBySpotId = new Map();

function setStatus(msg, isError) {
  statusEl.textContent = msg || "";
  statusEl.style.color = isError ? "var(--danger)" : "var(--primary)";
}

function haversineDistance(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Point that distances and the nearest-first ordering are measured from. */
function refPos() {
  return searchPos || userPos;
}

function isSearchActive() {
  return searchPos !== null;
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

function loadUserSpots() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveUserSpots(spots) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(spots));
}

async function loadSeedSpots() {
  try {
    const res = await fetch("data/smoking-spots.json");
    if (!res.ok) throw new Error("fetch failed");
    return await res.json();
  } catch (e) {
    setStatus(
      "初期データの読み込みに失敗しました（file:// で開いていませんか？ローカルサーバー経由で開いてください）",
      true
    );
    return [];
  }
}

// CARTO basemaps serve @2x tiles via the {r} placeholder, so the map stays
// sharp on high-DPI phone screens instead of looking upscaled.
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
const TILE_URL = {
  light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png",
};

let tileLayer = null;

function currentTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTileLayer(theme) {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILE_URL[theme], {
    attribution: TILE_ATTRIBUTION,
    subdomains: "abcd",
    maxZoom: 20,
    detectRetina: true, // fills {r} with "@2x" on high-DPI displays
  }).addTo(map);
  tileLayer.setZIndex(0);
}

function initMap() {
  map = L.map("map", { zoomControl: false, zoomSnap: 0.5 }).setView(DEFAULT_CENTER, 15);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  applyTileLayer(currentTheme());
  markerLayer.addTo(map);

  const darkQuery = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (darkQuery && darkQuery.addEventListener) {
    darkQuery.addEventListener("change", (e) => applyTileLayer(e.matches ? "dark" : "light"));
  }
}

function pinIcon(isUserAdded, isOsm) {
  const variant = isUserAdded ? " user-added" : isOsm ? " osm" : "";
  return L.divIcon({
    className: "",
    html: `<div class="smoke-pin${variant}"><span>🚬</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 28],
    popupAnchor: [0, -26],
  });
}

function renderMarkers(spots) {
  markerLayer.clearLayers();
  markerBySpotId.clear();
  spots.forEach((spot) => {
    const marker = L.marker([spot.lat, spot.lng], {
      icon: pinIcon(spot.type === "ユーザー登録", spot.osm),
    });
    marker.bindPopup(popupHtml(spot));
    marker.addTo(markerLayer);
    markerBySpotId.set(spot.id, marker);
  });
}

function popupHtml(spot) {
  const ref = refPos();
  const distText = ref
    ? formatDistance(haversineDistance(ref, [spot.lat, spot.lng]))
    : "";
  const distLabel = isSearchActive() ? escapeHtml(searchLabel) + "から" : "現在地から";
  const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}`;
  return `
    <div>
      <div class="popup-title">${escapeHtml(spot.name)}</div>
      <div class="popup-address">${escapeHtml(spot.address || "")}</div>
      ${distText ? `<div class="popup-distance">${distLabel} ${distText}</div>` : ""}
      <a class="popup-link" href="${dirUrl}" target="_blank" rel="noopener">ルート案内</a>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderList() {
  listEl.innerHTML = "";

  const ref = refPos();
  let spots = allSpots.map((spot) => ({
    ...spot,
    distance: ref ? haversineDistance(ref, [spot.lat, spot.lng]) : null,
  }));

  if (ref) {
    spots.sort((a, b) => a.distance - b.distance);
    if (radius > 0) {
      spots = spots.filter((s) => s.distance <= radius);
    }
  }

  if (spots.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = ref
      ? "この範囲内に喫煙所の登録がありません。範囲を広げるか、🔍でOpenStreetMapから検索してみてください。"
      : "位置情報を取得すると、近い順に喫煙所が表示されます。";
    listEl.appendChild(empty);
    return;
  }

  spots.forEach((spot) => {
    const node = itemTemplate.content.cloneNode(true);
    node.querySelector(".spot-name").textContent = spot.name;
    node.querySelector(".spot-address").textContent = spot.address || "";
    node.querySelector(".spot-distance").textContent =
      spot.distance != null ? formatDistance(spot.distance) : "";
    const dirLink = node.querySelector(".spot-directions");
    dirLink.href = `https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}`;
    const item = node.querySelector(".spot-item");
    item.addEventListener("click", (e) => {
      if (e.target === dirLink) return;
      map.setView([spot.lat, spot.lng], 17);
      const marker = markerBySpotId.get(spot.id);
      if (marker) marker.openPopup();
      setSheetState("half");
    });
    listEl.appendChild(node);
  });
}

function updateUserMarker(lat, lng, accuracy) {
  userPos = [lat, lng];
  if (!userMarker) {
    userMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: "",
        html: '<div class="user-dot-wrap"><div class="user-dot-pulse"></div><div class="user-dot"></div></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
      zIndexOffset: 1000,
    }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lng]);
  }

  if (accuracy) {
    if (!accuracyCircle) {
      // HeroUI primary (#006FEE)
      accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: "#006fee", fillOpacity: 0.08, weight: 1 }).addTo(map);
    } else {
      accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy);
    }
  }
}

// GPS accuracy handling ------------------------------------------------------
// A phone's first fix is often a coarse Wi-Fi/cell estimate (hundreds of
// metres) that gets refined over the next few seconds as the GPS warms up.
// We keep watching and only accept a reading when it is at least as good as
// the best one we already have, so a stale coarse fix can never clobber a
// sharp one.

let bestAccuracy = Infinity;
let lastFixAt = 0;
let watchId = null;
let pendingRecenter = false;

const STALE_FIX_MS = 15000; // after this, accept a worse reading (user moved)

function describeAccuracy(accuracy) {
  if (accuracy <= 20) return "";
  if (accuracy <= 100) return `位置精度 約${Math.round(accuracy)}m`;
  return `位置精度が粗いです（約${Math.round(accuracy)}m）。屋外や窓際で再取得すると改善します`;
}

function onPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  const now = Date.now();
  const isStale = now - lastFixAt > STALE_FIX_MS;

  // Reject a reading that is meaningfully worse than our best recent fix.
  if (accuracy > bestAccuracy * 1.5 && !isStale) return;

  bestAccuracy = isStale ? accuracy : Math.min(bestAccuracy, accuracy);
  lastFixAt = now;

  updateUserMarker(latitude, longitude, accuracy);

  if (pendingRecenter) {
    // Zoom in tighter when the fix is sharp, stay wide when it is fuzzy.
    const zoom = accuracy <= 30 ? 17 : accuracy <= 150 ? 16 : 15;
    map.setView([latitude, longitude], zoom);
    pendingRecenter = false;
  }

  if (!isSearchActive()) setStatus(describeAccuracy(accuracy));
  renderList();
  renderMarkers(allSpots);
}

function onPositionError(err) {
  const msg =
    err.code === err.PERMISSION_DENIED
      ? "位置情報の利用が許可されていません。ブラウザの設定から許可してください。"
      : err.code === err.POSITION_UNAVAILABLE
      ? "位置情報を取得できませんでした。電波の届く場所で再度お試しください。"
      : "位置情報の取得がタイムアウトしました。";
  setStatus(msg, true);
}

function locateUser(recenter) {
  if (!navigator.geolocation) {
    setStatus("この端末は位置情報に対応していません。", true);
    return;
  }

  if (recenter) {
    pendingRecenter = true;
    // Treat an explicit "locate me" tap as a fresh start so a better fix can
    // win even if we are currently holding a sharp but outdated one.
    bestAccuracy = Infinity;
    setStatus("現在地を取得中…");
  }

  // One watcher for the whole session — repeated taps must not stack watchers.
  if (watchId === null) {
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0, // never hand us a cached fix
    });
  } else if (recenter) {
    navigator.geolocation.getCurrentPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0,
    });
  }
}

// ---------- OpenStreetMap lookup ----------
// The bundled dataset is curated by hand and can never cover every smoking
// area in Japan. This pulls whatever OSM knows about the area currently on
// screen, so coverage works anywhere without shipping a huge file.
// Data © OpenStreetMap contributors (ODbL).

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

let osmSpots = [];
let osmLoading = false;

function osmTypeLabel(tags) {
  const covered = tags.covered === "yes" || tags.indoor === "yes" || tags.shelter === "yes";
  const heated =
    tags["smoking:heated_tobacco"] === "only" || tags["smoking:electronic"] === "only";
  return `${covered ? "屋内" : "屋外"}（OSM${heated ? "・加熱式専用" : ""}）`;
}

function osmToSpot(el) {
  const lat = el.lat != null ? el.lat : el.center && el.center.lat;
  const lng = el.lon != null ? el.lon : el.center && el.center.lon;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  const tags = el.tags || {};
  const name =
    tags["name:ja"] || tags.name || tags["operator:ja"] || tags.operator || "喫煙所（OSM）";
  const addrParts = [
    tags["addr:city"],
    tags["addr:suburb"],
    tags["addr:quarter"],
    tags["addr:block_number"],
    tags["addr:housenumber"],
  ].filter(Boolean);
  const note = tags["description:ja"] || tags.description || tags["note:ja"] || tags.note || "";
  return {
    id: `osm-${el.type}-${el.id}`,
    name,
    lat,
    lng,
    address: [addrParts.join(""), note].filter(Boolean).join(" "),
    type: osmTypeLabel(tags),
    sources: [`OpenStreetMap (ODbL) https://www.openstreetmap.org/${el.type}/${el.id}`],
    osm: true,
  };
}

async function fetchOsmForCurrentView() {
  if (osmLoading) return;
  const b = map.getBounds();
  const bbox = `${b.getSouth().toFixed(5)},${b.getWest().toFixed(5)},${b
    .getNorth()
    .toFixed(5)},${b.getEast().toFixed(5)}`;
  const query = `[out:json][timeout:25];(node["amenity"="smoking_area"](${bbox});way["amenity"="smoking_area"](${bbox});relation["amenity"="smoking_area"](${bbox}););out center tags;`;

  osmLoading = true;
  osmBtn.classList.add("loading");
  setStatus("OpenStreetMap から周辺の喫煙所を検索中…");

  let json = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      json = await res.json();
      break;
    } catch (e) {
      /* try the next mirror */
    }
  }

  osmLoading = false;
  osmBtn.classList.remove("loading");

  if (!json) {
    setStatus("OpenStreetMap に接続できませんでした。通信環境をご確認ください。", true);
    return;
  }

  const known = new Set(allSpots.map((s) => s.id));
  const fetched = (json.elements || []).map(osmToSpot).filter(Boolean);
  const fresh = fetched.filter((s) => {
    if (known.has(s.id)) return false;
    // Drop anything already covered by a curated pin at the same place.
    return !allSpots.some((c) => haversineDistance([c.lat, c.lng], [s.lat, s.lng]) <= 60);
  });

  if (fresh.length === 0) {
    setStatus("この範囲に OpenStreetMap の追加データはありませんでした。");
    return;
  }

  osmSpots = osmSpots.concat(fresh);
  allSpots = allSpots.concat(fresh);
  renderMarkers(allSpots);
  renderList();
  setStatus(`OpenStreetMap から ${fresh.length}件を追加しました（データ © OSM contributors）`);
}

// ---------- Search by station / area name ----------
// Deliberately NOT a search over the smoking-spot dataset's own names — the
// box is for finding a station or area, then browsing whatever is nearby.
// Two Japan-focused sources, queried in parallel:
//   1. HeartRails Express — a free, keyless API purpose-built for Japanese
//      train stations. Called via JSONP so it works regardless of whatever
//      CORS policy it happens to send (its docs offer `callback` explicitly
//      for cross-domain browser use, which is the reliable signal here).
//   2. Nominatim (OpenStreetMap) — general place/address geocoding, for
//      neighbourhoods, wards, landmarks and anything not literally a station.

const HEARTRAILS_URL = "https://express.heartrails.com/api/json";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

/** Load a JSONP endpoint. Needed for HeartRails since we can't confirm its
 *  CORS headers from this sandbox; a <script> tag sidesteps that entirely. */
function jsonp(url, param = "callback") {
  return new Promise((resolve, reject) => {
    const cbName = `__jsonp_cb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, 8000);

    function cleanup() {
      clearTimeout(timer);
      delete window[cbName];
      script.remove();
    }

    window[cbName] = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("script load failed"));
    };
    script.src = `${url}${url.includes("?") ? "&" : "?"}${param}=${cbName}`;
    document.head.appendChild(script);
  });
}

/** Japanese train stations matching `query`, via HeartRails Express. */
async function searchStations(query) {
  const url = `${HEARTRAILS_URL}?${new URLSearchParams({
    method: "getStations",
    name: query,
  })}`;
  const data = await jsonp(url);
  const stations = data && data.response && Array.isArray(data.response.station)
    ? data.response.station
    : [];
  return stations
    .filter((s) => typeof s.y === "number" && typeof s.x === "number")
    .map((s) => ({
      label: `${s.name}駅`,
      detail: [s.prefecture, s.line].filter(Boolean).join(" ・ "),
      lat: s.y, // HeartRails: y = latitude, x = longitude
      lng: s.x,
      badge: "駅",
    }));
}

/** General place/address matches for anything not literally a station. */
async function searchAreas(query) {
  const url = `${NOMINATIM_URL}?${new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "5",
    countrycodes: "jp",
    "accept-language": "ja",
  })}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const list = await res.json();
  return list.map((r) => ({
    label: (r.display_name || "").split(",")[0].trim() || query,
    detail: r.display_name || "",
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    badge: "地名",
  }));
}

function closeSearchResults() {
  searchResults.hidden = true;
  searchResults.innerHTML = "";
  searchInput.setAttribute("aria-expanded", "false");
}

function addResultRow({ title, subtitle, badge, onPick }) {
  const li = document.createElement("li");
  li.className = "search-result";
  li.setAttribute("role", "option");
  li.tabIndex = -1;

  const text = document.createElement("div");
  text.className = "search-result-text";
  const t = document.createElement("div");
  t.className = "search-result-title";
  t.textContent = title;
  text.appendChild(t);
  if (subtitle) {
    const s = document.createElement("div");
    s.className = "search-result-sub";
    s.textContent = subtitle;
    text.appendChild(s);
  }
  li.appendChild(text);

  if (badge) {
    const b = document.createElement("span");
    b.className = "search-result-badge";
    b.textContent = badge;
    li.appendChild(b);
  }

  li.addEventListener("click", onPick);
  searchResults.appendChild(li);
  return li;
}

/** Move the reference point to a searched station/place and re-centre on it. */
function gotoPlace(place) {
  searchPos = [place.lat, place.lng];
  searchLabel = place.label;
  refChipLabel.textContent = place.label;
  refChip.hidden = false;
  map.setView(searchPos, 16);
  searchInput.value = "";
  searchClear.hidden = true;
  closeSearchResults();
  renderMarkers(allSpots);
  renderList();
  setSheetState("half");

  // Tell the user what to do next: within range, just confirm. Out of range,
  // say how far the nearest recorded spot actually is so they can widen the
  // radius instead of assuming there is nothing at all.
  const limit = radius > 0 ? radius : Infinity;
  let nearest = Infinity;
  for (const s of allSpots) {
    nearest = Math.min(nearest, haversineDistance(searchPos, [s.lat, s.lng]));
  }
  if (nearest <= limit) {
    setStatus(`${place.label} を基準に表示しています。`);
  } else if (nearest !== Infinity) {
    setStatus(
      `${place.label} の${formatDistance(limit)}以内に収録データがありません（最も近いのは${formatDistance(
        nearest
      )}先）。範囲を広げるか🔍でOpenStreetMapから検索できます。`
    );
  } else {
    setStatus(`${place.label} 周辺に収録データがありません。🔍でOpenStreetMapから検索できます。`);
  }
}

function clearSearchRef() {
  if (!isSearchActive()) return;
  searchPos = null;
  searchLabel = "";
  refChip.hidden = true;
  renderMarkers(allSpots);
  renderList();
  setStatus("");
}

let searchSeq = 0;

async function runSearch(query) {
  const q = query.trim();
  searchClear.hidden = q.length === 0;
  if (!q) {
    closeSearchResults();
    return;
  }

  const seq = ++searchSeq;
  searchResults.innerHTML = "";
  const loading = addResultRow({ title: "検索中…", subtitle: `「${q}」の駅・地名を探しています` });
  loading.classList.add("search-result-action");
  searchResults.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");

  const [stationResult, areaResult] = await Promise.allSettled([
    searchStations(q),
    searchAreas(q),
  ]);
  if (seq !== searchSeq) return; // a newer query superseded this one
  loading.remove();

  const stations = stationResult.status === "fulfilled" ? stationResult.value : [];
  const areas = areaResult.status === "fulfilled" ? areaResult.value : [];

  // Stations first — that's the more precise, purpose-built match — then
  // general areas, deduping places that landed on effectively the same spot.
  const rows = [...stations, ...areas].filter((place, i, arr) => {
    return !arr
      .slice(0, i)
      .some((p) => haversineDistance([p.lat, p.lng], [place.lat, place.lng]) < 30);
  });

  if (rows.length === 0) {
    const stationFailed = stationResult.status === "rejected";
    const areaFailed = areaResult.status === "rejected";
    if (stationFailed && areaFailed) {
      addResultRow({
        title: "検索に接続できませんでした",
        subtitle: "通信環境をご確認のうえ、もう一度お試しください",
      });
    } else {
      addResultRow({ title: "見つかりませんでした", subtitle: "別の駅名・地域名でお試しください" });
    }
    return;
  }

  for (const place of rows) {
    addResultRow({
      title: place.label,
      subtitle: place.detail,
      badge: place.badge,
      onPick: () => gotoPlace(place),
    });
  }

  // One of the two sources failed but the other still had results — say so
  // briefly rather than silently showing a partial list.
  if (stationResult.status === "rejected" || areaResult.status === "rejected") {
    const which = stationResult.status === "rejected" ? "駅名検索" : "地名検索";
    addResultRow({ title: `${which}に接続できませんでした`, subtitle: "上記は別ソースの結果です" });
  }
}

function setupSearch() {
  let timer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(timer);
    const v = searchInput.value;
    searchClear.hidden = v.trim().length === 0;
    timer = setTimeout(() => runSearch(v), 250);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSearchResults();
      searchInput.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(timer);
      const first = searchResults.querySelector(".search-result:not(.search-result-action)");
      if (first) first.click();
      else runSearch(searchInput.value);
    }
  });

  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchClear.hidden = true;
    closeSearchResults();
    searchInput.focus();
  });

  refChipClear.addEventListener("click", () => {
    clearSearchRef();
    if (userPos) map.setView(userPos, 16);
  });

  // Tapping the map dismisses the dropdown.
  map.on("click dragstart", closeSearchResults);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) closeSearchResults();
  });
}

function addSpotAtMapCenter() {
  const name = prompt("喫煙所の名前を入力してください（例：〇〇駅前 喫煙所）");
  if (!name) return;
  const center = map.getCenter();
  const spot = {
    id: "user-" + Date.now(),
    name,
    lat: center.lat,
    lng: center.lng,
    address: "",
    type: "ユーザー登録",
    sources: ["自分で追加"],
  };
  const userSpots = loadUserSpots();
  userSpots.push(spot);
  saveUserSpots(userSpots);
  allSpots.push(spot);
  renderMarkers(allSpots);
  renderList();
  setStatus("喫煙所を追加しました。");
}

function setupSegmentedControl() {
  segmented.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    segmented.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    radius = Number(btn.dataset.value);
    renderList();
  });
}

// ---------- Bottom sheet drag (collapsed / peek / half / full) ----------

// "collapsed" leaves only the grab handle on screen so the map is almost
// full-height; drag it back up to bring the list in.
const COLLAPSED_HEIGHT = 34;

let sheetHeights = { collapsed: COLLAPSED_HEIGHT, peek: 150, half: 0, full: 0 };
let sheetState = "half";
let dragStartY = 0;
let dragStartHeight = 0;
let isDragging = false;
let dragMoved = false;

function computeSheetHeights() {
  const vh = window.innerHeight;
  const half = Math.round(vh * 0.5);

  // Leave room so the floating buttons (which sit just above the sheet)
  // never climb up far enough to overlap the title/segmented-control panel.
  const titlePanel = document.querySelector(".title-panel");
  const titleBottom = titlePanel ? titlePanel.getBoundingClientRect().bottom : 0;
  const fabStackHeight = 44 * 2 + 12; // two 44px buttons + gap
  const margin = 32; // breathing room above the title panel and below the fabs
  const maxFullBySpace = vh - titleBottom - fabStackHeight - margin;

  sheetHeights = {
    collapsed: COLLAPSED_HEIGHT,
    peek: 150,
    half,
    full: Math.max(half + 40, Math.min(Math.round(vh * 0.82), maxFullBySpace)),
  };
}

function applySheetHeight(px) {
  sheet.style.height = px + "px";
  document.documentElement.style.setProperty("--sheet-height", px + "px");
}

function setSheetState(state) {
  sheetState = state;
  sheet.classList.remove("dragging");
  fabStack.classList.remove("dragging");
  sheet.classList.toggle("collapsed", state === "collapsed");
  applySheetHeight(sheetHeights[state]);
}

function setSheetHeightPx(px) {
  const clamped = Math.min(sheetHeights.full, Math.max(sheetHeights.collapsed, px));
  applySheetHeight(clamped);
}

function nearestState(px) {
  const entries = Object.entries(sheetHeights);
  let best = entries[0];
  let bestDist = Infinity;
  for (const [name, h] of entries) {
    const d = Math.abs(h - px);
    if (d < bestDist) {
      bestDist = d;
      best = [name, h];
    }
  }
  return best[0];
}

function setupSheetDrag() {
  computeSheetHeights();
  setSheetState("half");

  const onPointerDown = (e) => {
    isDragging = true;
    dragMoved = false;
    dragStartY = e.clientY;
    dragStartHeight = sheet.getBoundingClientRect().height;
    sheet.classList.add("dragging");
    fabStack.classList.add("dragging");
    sheetHandle.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    const delta = dragStartY - e.clientY;
    if (Math.abs(delta) > 4) dragMoved = true;
    setSheetHeightPx(dragStartHeight + delta);
  };

  const onPointerUp = () => {
    if (!isDragging) return;
    isDragging = false;

    // A tap (no real movement) cycles the sheet instead of snapping back.
    if (!dragMoved) {
      const order = ["collapsed", "peek", "half", "full"];
      const next = order[(order.indexOf(sheetState) + 1) % order.length];
      setSheetState(next);
      return;
    }

    setSheetState(nearestState(sheet.getBoundingClientRect().height));
  };

  sheetHandle.addEventListener("pointerdown", onPointerDown);
  sheetHandle.addEventListener("pointermove", onPointerMove);
  sheetHandle.addEventListener("pointerup", onPointerUp);
  sheetHandle.addEventListener("pointercancel", onPointerUp);

  window.addEventListener("resize", () => {
    computeSheetHeights();
    setSheetState(sheetState);
  });
}

async function main() {
  initMap();
  setupSegmentedControl();
  setupSheetDrag();
  setupSearch();

  const seedSpots = await loadSeedSpots();
  const userSpots = loadUserSpots();
  allSpots = [...seedSpots, ...userSpots];
  renderMarkers(allSpots);
  renderList();

  locateBtn.addEventListener("click", () => {
    clearSearchRef();
    locateUser(true);
  });
  addSpotBtn.addEventListener("click", addSpotAtMapCenter);
  osmBtn.addEventListener("click", fetchOsmForCurrentView);

  locateUser(true);
}

main();
