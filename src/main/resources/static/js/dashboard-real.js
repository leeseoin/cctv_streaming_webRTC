/**
 * dashboard-real.js — CCTV 실제 카메라 대시보드
 *
 * URL 파라미터:
 *   ?mode=webrtc|mse|auto   스트리밍 모드 (기본: webrtc)
 *   ?count=4|9|16|20        동시 표시 채널 수 (기본: 20)
 *
 * 각 셀 = embed.html iframe. 그 이상의 로직 없음.
 */
const REAL_CAMS = [
  { id: "cam01",  label: "cam01" },
  { id: "cam120", label: "50740 정류장 2번째 가로등" },
  { id: "cam121", label: "읍내삼거리" },
  { id: "cam122", label: "중리네거리" },
  { id: "cam123", label: "한국유체기계앞 가로등" },
  { id: "cam124", label: "오정네거리" },
  { id: "cam125", label: "농수산 오거리" },
  { id: "cam126", label: "모정네거리" },
  { id: "cam127", label: "만년네거리" },
  { id: "cam128", label: "과학공원네거리" },
  { id: "cam129", label: "충대정문 오거리" },
  { id: "cam130", label: "유성네거리" },
  { id: "cam131", label: "45500 정류장 옆" },
  { id: "cam132", label: "도안네거리" },
  { id: "cam133", label: "관저네거리" },
  { id: "cam134", label: "가수원 네거리" },
  { id: "cam135", label: "한국타이어 교각 다리위" },
  { id: "cam136", label: "보문산 오거리" },
  { id: "cam137", label: "대전역 네거리" },
  { id: "cam138", label: "대동오거리" },
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
  const cams = REAL_CAMS.slice(0, count);
  const cols = cams.length <= 4 ? 2 : cams.length <= 9 ? 3 : cams.length <= 16 ? 4 : 5;
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridAutoRows = "1fr";

  cams.forEach((cam) => {
    const cell = document.createElement("div");
    cell.className = "cell";

    const iframe = document.createElement("iframe");
    iframe.src = `/embed.html?cam=${encodeURIComponent(cam.id)}&mode=${encodeURIComponent(mode)}`;
    iframe.allow = "autoplay; fullscreen";

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = cam.label;

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
