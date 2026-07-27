const STORAGE_KEY = "kituennjo:user-spots";
const DEFAULT_CENTER = [35.6812, 139.7671]; // 東京駅

const statusEl = document.getElementById("status");
const listEl = document.getElementById("spot-list");
const radiusSelect = document.getElementById("radius-select");
const locateBtn = document.getElementById("locate-btn");
const addSpotBtn = document.getElementById("add-spot-btn");
const itemTemplate = document.getElementById("spot-item-template");

let map;
let userPos = null;
let userMarker = null;
let accuracyCircle = null;
let allSpots = [];
const markerLayer = L.layerGroup();

function setStatus(msg, isError) {
  statusEl.textContent = msg || "";
  statusEl.style.color = isError ? "#c62828" : "#b45309";
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

function initMap() {
  map = L.map("map").setView(DEFAULT_CENTER, 15);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
  markerLayer.addTo(map);
}

function renderMarkers(spots) {
  markerLayer.clearLayers();
  spots.forEach((spot) => {
    const icon = L.divIcon({
      className: "",
      html: '<div class="smoke-pin">🚬</div>',
      iconSize: [24, 24],
      iconAnchor: [12, 20],
    });
    const marker = L.marker([spot.lat, spot.lng], { icon });
    marker.bindPopup(popupHtml(spot));
    marker.addTo(markerLayer);
  });
}

function popupHtml(spot) {
  const distText = userPos
    ? formatDistance(haversineDistance(userPos, [spot.lat, spot.lng]))
    : "";
  const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}`;
  return `
    <div>
      <strong>${escapeHtml(spot.name)}</strong><br>
      <span style="font-size:12px;color:#777">${escapeHtml(spot.address || "")}</span><br>
      ${distText ? `<span style="font-size:12px;color:#2e7d32">現在地から ${distText}</span><br>` : ""}
      <a href="${dirUrl}" target="_blank" rel="noopener">Googleマップでルート案内</a>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderList() {
  const radius = Number(radiusSelect.value);
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
    empty.style.padding = "0 4px";
    empty.style.fontSize = "13px";
    empty.style.color = "#777";
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
      markerLayer.eachLayer((m) => {
        const ll = m.getLatLng();
        if (ll.lat === spot.lat && ll.lng === spot.lng) m.openPopup();
      });
    });
    listEl.appendChild(node);
  });
}

function updateUserMarker(lat, lng, accuracy) {
  userPos = [lat, lng];
  if (!userMarker) {
    userMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: "", html: '<div class="user-dot"></div>', iconSize: [16, 16] }),
    }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lng]);
  }

  if (accuracy) {
    if (!accuracyCircle) {
      accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: "#1565c0", fillOpacity: 0.08, weight: 1 }).addTo(map);
    } else {
      accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy);
    }
  }
}

function locateUser(recenter) {
  if (!navigator.geolocation) {
    setStatus("この端末は位置情報に対応していません。", true);
    return;
  }
  setStatus("現在地を取得中…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      updateUserMarker(latitude, longitude, accuracy);
      if (recenter) map.setView([latitude, longitude], 16);
      setStatus("");
      renderList();
      renderMarkers(allSpots);
    },
    (err) => {
      setStatus("位置情報を取得できませんでした：" + err.message, true);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );

  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      updateUserMarker(latitude, longitude, accuracy);
      renderList();
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 10000 }
  );
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
    source: "自分で追加",
  };
  const userSpots = loadUserSpots();
  userSpots.push(spot);
  saveUserSpots(userSpots);
  allSpots.push(spot);
  renderMarkers(allSpots);
  renderList();
  setStatus("喫煙所を追加しました。");
}

async function main() {
  initMap();
  const seedSpots = await loadSeedSpots();
  const userSpots = loadUserSpots();
  allSpots = [...seedSpots, ...userSpots];
  renderMarkers(allSpots);
  renderList();

  radiusSelect.addEventListener("change", renderList);
  locateBtn.addEventListener("click", () => locateUser(true));
  addSpotBtn.addEventListener("click", addSpotAtMapCenter);

  locateUser(true);
}

main();
