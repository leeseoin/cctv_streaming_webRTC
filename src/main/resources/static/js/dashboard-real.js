/**
 * dashboard-real.js — CCTV 실제 카메라 대시보드
 *
 * URL 파라미터:
 *   ?mode=webrtc|mse|auto   스트리밍 모드 (기본: webrtc)
 *   ?count=4|9|16|20        동시 표시 채널 수 (기본: 20)
 *
 * 각 셀 = embed.html iframe. 그 이상의 로직 없음.
 */
const REAL_IDS = [
  "cam01",
  "cam120", "cam121", "cam122", "cam123", "cam124",
  "cam125", "cam126", "cam127", "cam128", "cam129",
  "cam130", "cam131", "cam132", "cam133", "cam134",
  "cam135", "cam136", "cam137", "cam138",
];

const modeSel = document.getElementById("modeSel");
const countSel = document.getElementById("countSel");
const grid = document.getElementById("grid");

const qs = new URLSearchParams(location.search);
let mode = qs.get("mode") || "webrtc";
let count = parseInt(qs.get("count") || "20", 10);

modeSel.value = mode;
countSel.value = String(Math.min(count, 20));

function render() {
  grid.innerHTML = "";
  const ids = REAL_IDS.slice(0, count);
  const cols = ids.length <= 4 ? 2 : ids.length <= 9 ? 3 : ids.length <= 16 ? 4 : 5;
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridAutoRows = "1fr";

  ids.forEach((id) => {
    const cell = document.createElement("div");
    cell.className = "cell";

    const iframe = document.createElement("iframe");
    iframe.src = `/embed.html?cam=${encodeURIComponent(id)}&mode=${encodeURIComponent(mode)}`;
    iframe.allow = "autoplay; fullscreen";

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = id;

    cell.appendChild(iframe);
    cell.appendChild(label);
    grid.appendChild(cell);
  });
}

modeSel.addEventListener("change", () => {
  mode = modeSel.value;
  render();
});
countSel.addEventListener("change", () => {
  count = parseInt(countSel.value, 10);
  render();
});

render();
