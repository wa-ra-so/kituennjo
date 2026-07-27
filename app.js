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

let map;
let userPos = null;
let userMarker = null;
let accuracyCircle = null;
let allSpots = [];
let radius = 1000;
const markerLayer = L.layerGroup();
const markerBySpotId = new Map();

function setStatus(msg, isError) {
  statusEl.textContent = msg || "";
  statusEl.style.color = isError ? "#ff3b30" : "var(--accent-blue)";
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

function pinIcon(isUserAdded) {
  return L.divIcon({
    className: "",
    html: `<div class="smoke-pin${isUserAdded ? " user-added" : ""}"><span>🚬</span></div>`,
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
      icon: pinIcon(spot.type === "ユーザー登録"),
    });
    marker.bindPopup(popupHtml(spot));
    marker.addTo(markerLayer);
    markerBySpotId.set(spot.id, marker);
  });
}

function popupHtml(spot) {
  const distText = userPos
    ? formatDistance(haversineDistance(userPos, [spot.lat, spot.lng]))
    : "";
  const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}`;
  return `
    <div>
      <div class="popup-title">${escapeHtml(spot.name)}</div>
      <div class="popup-address">${escapeHtml(spot.address || "")}</div>
      ${distText ? `<div class="popup-distance">現在地から ${distText}</div>` : ""}
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

  let spots = allSpots.map((spot) => ({
    ...spot,
    distance: userPos ? haversineDistance(userPos, [spot.lat, spot.lng]) : null,
  }));

  if (userPos) {
    spots.sort((a, b) => a.distance - b.distance);
    if (radius > 0) {
      spots = spots.filter((s) => s.distance <= radius);
    }
  }

  if (spots.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = userPos
      ? "この範囲内に喫煙所の登録がありません。範囲を広げてみてください。"
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
      accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: "#007aff", fillOpacity: 0.08, weight: 1 }).addTo(map);
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

  setStatus(describeAccuracy(accuracy));
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

  const seedSpots = await loadSeedSpots();
  const userSpots = loadUserSpots();
  allSpots = [...seedSpots, ...userSpots];
  renderMarkers(allSpots);
  renderList();

  locateBtn.addEventListener("click", () => locateUser(true));
  addSpotBtn.addEventListener("click", addSpotAtMapCenter);

  locateUser(true);
}

main();
