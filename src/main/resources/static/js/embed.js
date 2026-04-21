/**
 * embed.js — nexbean 스타일 CCTV 임베딩 플레이어 (video-stream 기반)
 *
 * URL 파라미터:
 *   ?cam=cam01            카메라 ID (필수)
 *   ?mode=auto|webrtc|hls 스트리밍 모드 (기본: auto)
 *
 * video-stream 웹컴포넌트가 WebRTC → MSE → HLS 자동 Failover 처리.
 */
const params = new URLSearchParams(location.search);
const cameraId = params.get("cam");
const streamMode = params.get("mode") || "auto";
let video = null; // video-stream 엘리먼트 (connect에서 동적 생성)
const viewer = document.getElementById("viewer");
const overlay = document.getElementById("overlay");
const statusEl = document.getElementById("status");
const modeBadge = document.getElementById("modeBadge"); // 배지 비활성화됨 (null)

// mode 파라미터 → video-rtc mode 속성 매핑
const modeMap = {
  auto: "webrtc,mse,hls",
  webrtc: "webrtc",
  mse: "mse",
  hls: "hls",
};

// ── 초기화 ──
if (!cameraId) {
  statusEl.textContent = "카메라 ID 없음 (?cam=xxx)";
  statusEl.classList.add("error");
} else {
  document.title = cameraId + " - CCTV";
  updateModeIndicator();
  // video-stream 커스텀 엘리먼트 등록 대기 후 연결
  customElements
    .whenDefined("video-stream")
    .then(connect)
    .catch((e) => {
      console.error("[video-stream] 로드 실패:", e);
      setStatus("플레이어 로드 실패");
      statusEl.classList.add("error");
    });
}

let fallbackTimer = null;

function createPlayer(mode) {
  // 기존 엘리먼트 제거
  if (video) {
    video.remove();
    video = null;
  }
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }

  console.log(`[embed] createPlayer mode=${mode}`);
  setStatus(`${mode.toUpperCase()} 연결 중...`);
  overlay.classList.remove("hidden");

  // stream.html 패턴: 생성 → 속성 설정 → DOM 삽입
  video = document.createElement("video-stream");
  video.id = "video";
  video.background = true;
  video.muted = true;
  video.mode = mode;
  video.src = new URL(`api/ws?src=${encodeURIComponent(cameraId)}&media=video`, CONFIG.GO2RTC_BASE + "/");
  viewer.appendChild(video);

  // native controls 비활성화 (클릭 시 pause 방지, 좌측 상단 풀스크린 버튼 사용)
  const disableControls = () => {
    const v = video?.video || video?.querySelector?.("video");
    if (v) {
      v.controls = false;
      v.removeAttribute("controls");
      return true;
    }
    return false;
  };
  if (!disableControls()) {
    const tid = setInterval(() => {
      if (disableControls()) clearInterval(tid);
    }, 200);
    setTimeout(() => clearInterval(tid), 5000);
  }

  const inner = video.video || video.querySelector("video");
  if (inner) {
    inner.addEventListener(
      "loadeddata",
      () => {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        overlay.classList.add("hidden");
        showBadge(mode);
        disableControls(); // loadeddata 시점에 한 번 더 native controls 비활성화
        console.log(`[embed] 영상 수신 성공 — mode=${mode}`);
      },
      { once: true },
    );
  }
}

function connect() {
  if (streamMode === "auto") {
    // WebRTC 4초 시도 → 실패 시 MSE 4초 → 실패 시 HLS
    createPlayer("webrtc");
    fallbackTimer = setTimeout(() => {
      console.log("[embed] WebRTC 타임아웃 → MSE fallback");
      createPlayer("mse");
      fallbackTimer = setTimeout(() => {
        console.log("[embed] MSE 타임아웃 → HLS fallback");
        createPlayer("hls");
      }, 4000);
    }, 4000);
  } else {
    createPlayer(modeMap[streamMode] || "webrtc");
  }
}

// ── 모드 인디케이터 ──
function updateModeIndicator() {
  const indicator = document.getElementById("modeIndicator");
  if (!indicator) return;
  const labels = { auto: "Auto (WebRTC→MSE→HLS)", webrtc: "WebRTC Only", mse: "MSE Only", hls: "HLS Only" };
  indicator.textContent = labels[streamMode] || streamMode;
}

// ── 상태 표시 ──
function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.remove("error");
  overlay.classList.remove("hidden");
}

function showBadge(mode) {
  if (!modeBadge) return;
  const m = mode.startsWith("webrtc") ? "webrtc" : mode;
  modeBadge.className = "mode-badge " + m;
  modeBadge.textContent = m === "webrtc" ? "WebRTC" : m.toUpperCase();
}

// ── 패널 3단계 제어 (nexbean setbtn 동일) ──
function setPanel(stage) {
  const openBtn = document.getElementById("openBtn");
  const closeBtn = document.getElementById("closeBtn");
  const refreshBtn = document.getElementById("refreshBtn");
  const modeIndicatorWrap = document.getElementById("modeIndicatorWrap");
  const angleUp = document.getElementById("angleUp");
  const angleDown = document.getElementById("angleDown");
  const panel = document.getElementById("controlPanel");
  const boxes = document.querySelectorAll(".func-box1");

  if (stage === 0) {
    openBtn.style.display = "block";
    closeBtn.style.display = "none";
    refreshBtn.style.display = "none";
    if (modeIndicatorWrap) modeIndicatorWrap.style.display = "none";
    angleUp.style.display = "none";
    angleDown.style.display = "none";
    panel.style.display = "none";
    boxes.forEach((b) => (b.style.display = "none"));
  } else if (stage === 2) {
    openBtn.style.display = "none";
    closeBtn.style.display = "none";
    refreshBtn.style.display = "block";
    if (modeIndicatorWrap) modeIndicatorWrap.style.display = "flex";
    angleUp.style.display = "block";
    angleDown.style.display = "none";
    panel.style.display = "none";
    boxes.forEach((b) => (b.style.display = "none"));
  } else if (stage === 3) {
    openBtn.style.display = "none";
    closeBtn.style.display = "block";
    refreshBtn.style.display = "block";
    if (modeIndicatorWrap) modeIndicatorWrap.style.display = "flex";
    angleUp.style.display = "none";
    angleDown.style.display = "block";
    panel.style.display = "block";
    boxes.forEach((b) => (b.style.display = "block"));
  }
}

setPanel(0);

window.onresize = function () {
  if (window.innerWidth < 1280) setPanel(0);
};

// ── PTZ 제어 ──
function ptzCtrl(pan, tilt, zoom) {
  fetch(`${CONFIG.GO2RTC_BASE}/api/ptz/${cameraId}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pan, tilt, zoom }),
  }).catch((e) => console.warn("[PTZ]", e));
}

// ── 전체화면 ──
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
}
