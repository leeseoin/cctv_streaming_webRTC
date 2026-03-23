/**
 * embed.js — nexbean 스타일 CCTV 임베딩 플레이어
 *
 * 사용법: /embed.html?cam=cam01
 * 3단계 패널: 닫힘(0) → 화살표(2) → 전체 패널(3)
 */
const params = new URLSearchParams(location.search);
const cameraId = params.get("cam");
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const statusEl = document.getElementById("status");
const modeBadge = document.getElementById("modeBadge");

let pc = null;
let currentMode = null;
let streamMode = "webrtc-hls";
let hlsInstance = null;

// ── 초기화 ──
if (!cameraId) {
  statusEl.textContent = "카메라 ID 없음 (?cam=xxx)";
  statusEl.classList.add("error");
} else {
  document.title = cameraId + " - CCTV";
  connect();
}

// ── 패널 3단계 제어 (nexbean setbtn 동일) ──
function setPanel(stage) {
  const openBtn = document.getElementById("openBtn");
  const closeBtn = document.getElementById("closeBtn");
  const refreshBtn = document.getElementById("refreshBtn");
  const modeSelector = document.getElementById("modeSelector");
  const angleUp = document.getElementById("angleUp");
  const angleDown = document.getElementById("angleDown");
  const panel = document.getElementById("controlPanel");
  const boxes = document.querySelectorAll(".func-box1");

  if (stage === 0) {
    // 닫힘: 우하단 열기 버튼만
    openBtn.style.display = "block";
    closeBtn.style.display = "none";
    refreshBtn.style.display = "none";
    modeSelector.style.display = "none";
    angleUp.style.display = "none";
    angleDown.style.display = "none";
    panel.style.display = "none";
    boxes.forEach((b) => (b.style.display = "none"));
  } else if (stage === 2) {
    // 화살표만: 하단 중앙 위쪽 화살표
    openBtn.style.display = "none";
    closeBtn.style.display = "none";
    refreshBtn.style.display = "block";
    modeSelector.style.display = "flex";
    angleUp.style.display = "block";
    angleDown.style.display = "none";
    panel.style.display = "none";
    boxes.forEach((b) => (b.style.display = "none"));
  } else if (stage === 3) {
    // 전체 패널: 모든 기능 박스 표시
    openBtn.style.display = "none";
    closeBtn.style.display = "block";
    refreshBtn.style.display = "block";
    modeSelector.style.display = "flex";
    angleUp.style.display = "none";
    angleDown.style.display = "block";
    panel.style.display = "block";
    boxes.forEach((b) => (b.style.display = "block"));
  }
}

// 초기 상태
setPanel(0);

// 창 크기 변경 시 패널 닫기
window.onresize = function () {
  if (window.innerWidth < 1280) {
    setPanel(0);
  }
};

// ── 연결 ──
function connect() {
  disconnect();
  if (streamMode === "hls") {
    startHls(cameraId);
  } else {
    connectWebRTC(cameraId);
  }
}

async function connectWebRTC(camId) {
  setStatus("WebRTC 연결 중...");
  overlay.classList.remove("hidden");

  try {
    pc = new RTCPeerConnection();

    pc.ontrack = (event) => {
      video.srcObject = event.streams[0];
      currentMode = "webrtc";
      overlay.classList.add("hidden");
      showBadge("webrtc");
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === "failed") {
        if (pc) { pc.close(); pc = null; }
        if (streamMode === "webrtc-hls") {
          startHls(camId);
        } else {
          setStatus("WebRTC 연결 실패");
        }
      } else if (state === "disconnected") {
        setStatus("연결 끊김");
        overlay.classList.remove("hidden");
      }
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const response = await fetch(`/api/cameras/${camId}/webrtc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: offer.type, sdp: offer.sdp }),
    });

    if (!response.ok) throw new Error("서버 응답 오류: " + response.status);

    const answer = await response.json();
    await pc.setRemoteDescription(answer);
  } catch (e) {
    console.error("[embed] WebRTC 실패:", e);
    if (pc) { pc.close(); pc = null; }
    if (streamMode === "webrtc-hls") {
      startHls(camId);
    } else {
      setStatus("WebRTC 연결 실패: " + e.message);
    }
  }
}

function startHls(camId) {
  setStatus("HLS 연결 중...");
  overlay.classList.remove("hidden");

  video.pause();
  video.srcObject = null;
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

  const hlsUrl = `/api/stream.m3u8?src=${camId}`;

  if (Hls.isSupported()) {
    hlsInstance = new Hls();
    hlsInstance.loadSource(hlsUrl);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
      currentMode = "hls";
      overlay.classList.add("hidden");
      showBadge("hls");
    });
    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        setStatus("HLS 연결 실패");
        statusEl.classList.add("error");
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Safari 네이티브 HLS
    video.src = hlsUrl;
    video.addEventListener("loadeddata", () => {
      video.play().catch(() => {});
      currentMode = "hls";
      overlay.classList.add("hidden");
      showBadge("hls");
    }, { once: true });
    video.addEventListener("error", () => {
      setStatus("HLS 연결 실패");
      statusEl.classList.add("error");
    }, { once: true });
  }
}

function disconnect() {
  if (pc) { pc.close(); pc = null; }
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  video.pause();
  video.srcObject = null;
  video.removeAttribute("src");
  currentMode = null;
  modeBadge.className = "mode-badge";
}

// ── 상태 표시 ──
function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.remove("error");
  overlay.classList.remove("hidden");
}

function showBadge(mode) {
  modeBadge.className = "mode-badge " + mode;
  modeBadge.textContent = mode === "webrtc" ? "WebRTC" : "HLS";
}

// ── 스트리밍 모드 전환 ──
function switchMode(btn) {
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  streamMode = btn.dataset.mode;
  connect();
}

// ── PTZ 제어 ──
function ptzCtrl(pan, tilt, zoom) {
  fetch(`/api/ptz/${cameraId}/move`, {
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
