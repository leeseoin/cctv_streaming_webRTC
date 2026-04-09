/**
 * embed.js — nexbean 스타일 CCTV 임베딩 플레이어
 *
 * URL 파라미터:
 *   ?cam=cam01           카메라 ID (필수)
 *   ?mode=auto|webrtc|hls 스트리밍 모드 (기본: auto)
 *   ?hls=go2rtc|ffmpeg    HLS 소스 선택 (기본: go2rtc)
 *
 * auto 모드: WebRTC 3회 시도 → 실패 시 HLS fallback + 토스트 알림
 */
const params = new URLSearchParams(location.search);
const cameraId = params.get("cam");
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const statusEl = document.getElementById("status");
const modeBadge = document.getElementById("modeBadge");

let pc = null;
let currentMode = null;
let hlsInstance = null;
const hlsMode = params.get("hls") || "go2rtc"; // "go2rtc" | "ffmpeg"
const streamMode = params.get("mode") || "auto"; // "auto" | "webrtc" | "hls"

// WebRTC 연결 2번 시도
const MAX_WEBRTC_RETRIES = 2;
let webrtcRetryCount = 0;
let webrtcGeneration = 0;

// ── 초기화 ──
if (!cameraId) {
  statusEl.textContent = "카메라 ID 없음 (?cam=xxx)";
  statusEl.classList.add("error");
} else {
  document.title = cameraId + " - CCTV";
  // 모드 배지 초기 표시
  updateModeIndicator();
  connect();
}

// ── 모드 인디케이터 (좌상단에 현재 모드 표시) ──
function updateModeIndicator() {
  const indicator = document.getElementById("modeIndicator");
  if (!indicator) return;
  const labels = { auto: "Auto (WebRTC→HLS)", webrtc: "WebRTC Only", hls: "HLS Only" };
  indicator.textContent = labels[streamMode] || streamMode;
}

// ── 토스트 알림 ──
function showToast(message, duration = 4000) {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);

  // 애니메이션 트리거
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  setTimeout(() => {
    toast.classList.remove("show");
    toast.addEventListener("transitionend", () => toast.remove());
  }, duration);
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

// 초기 상태
setPanel(0);

window.onresize = function () {
  if (window.innerWidth < 1280) {
    setPanel(0);
  }
};

// mode=auto일 시, WebRTC 시도, mode=hls이면 바로 HLS 연결
function connect() {
  disconnect();
  webrtcRetryCount = 0;

  if (streamMode === "hls") {
    startHls(cameraId);
  } else {
    // auto 또는 webrtc: WebRTC 시도
    connectWebRTC(cameraId);
  }
}

// WebRTC 연결 시도
async function connectWebRTC(camId) {
  webrtcRetryCount++;
  const attempt = webrtcRetryCount;
  const generation = ++webrtcGeneration;
  const isAutoMode = streamMode === "auto";

  if (isAutoMode) {
    setStatus(`WebRTC 연결 시도 ${attempt}/${MAX_WEBRTC_RETRIES}...`);
  } else {
    setStatus("WebRTC 연결 중...");
  }
  overlay.classList.remove("hidden");

  // 이전 연결 정리
  if (pc) {
    pc.close();
    pc = null;
  }

  try {
    pc = new RTCPeerConnection();

    pc.ontrack = (event) => {
      video.srcObject = event.streams[0];
      video.onloadeddata = () => {
        if (generation !== webrtcGeneration) return; // stale 체크
        currentMode = "webrtc";
        overlay.classList.add("hidden");
        showBadge("webrtc");
        webrtcRetryCount = 0;
        console.log(`[WebRTC] 영상 수신 확인 (시도 ${attempt})`);
        video.onloadeddata = null;
      };
    };

    let iceTimeout = null;

    pc.oniceconnectionstatechange = () => {
      if (generation !== webrtcGeneration) return; // stale 체크
      const state = pc.iceConnectionState;
      console.log(`[WebRTC] ICE state: ${state} (시도 ${attempt}/${MAX_WEBRTC_RETRIES})`);

      if (state === "connected" || state === "completed") {
        if (iceTimeout) {
          clearTimeout(iceTimeout);
          iceTimeout = null;
        }
      } else if (state === "failed" || state === "disconnected") {
        if (iceTimeout) clearTimeout(iceTimeout);
        if (pc) {
          pc.close();
          pc = null;
        }
        handleWebRTCFailure(camId);
      }
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${CONFIG.API_BASE}/api/cameras/${camId}/webrtc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: offer.type, sdp: offer.sdp }),
      signal: controller.signal,
    });
    clearTimeout(fetchTimeout);

    if (!response.ok) throw new Error("서버 응답 오류: " + response.status);

    const answer = await response.json();
    await pc.setRemoteDescription(answer);

    // ICE 연결 15초 타임아웃
    iceTimeout = setTimeout(() => {
      if (generation !== webrtcGeneration) return; // stale 체크
      if (pc && pc.iceConnectionState !== "connected" && pc.iceConnectionState !== "completed") {
        console.log(`[WebRTC] ICE 타임아웃 (시도 ${attempt})`);
        pc.close();
        pc = null;
        handleWebRTCFailure(camId);
      }
    }, 15000);
  } catch (e) {
    console.error(`[WebRTC] 연결 실패 (시도 ${attempt}):`, e);
    if (pc) {
      pc.close();
      pc = null;
    }
    handleWebRTCFailure(camId);
  }
}

/**
 * WebRTC 실패 처리
 * - auto 모드: 3회 미만이면 즉시 재시도, 3회 도달하면 HLS fallback + 토스트
 * - webrtc 모드: 그냥 실패 표시
 */
function handleWebRTCFailure(camId) {
  if (streamMode === "auto") {
    if (webrtcRetryCount < MAX_WEBRTC_RETRIES) {
      console.log(`[Failover] WebRTC 실패 ${webrtcRetryCount}/${MAX_WEBRTC_RETRIES}, 즉시 재시도`);
      connectWebRTC(camId);
    } else {
      console.log(`[Failover] WebRTC ${MAX_WEBRTC_RETRIES}회 실패 → HLS 전환`);
      showToast("WebRTC 연결 실패, HLS로 전환합니다");
      startHls(camId);
    }
  } else {
    // webrtc 전용 모드
    setStatus("WebRTC 연결 실패");
  }
}

function startHls(camId) {
  setStatus("HLS 연결 중...");
  overlay.classList.remove("hidden");

  video.onloadeddata = null; // WebRTC의 stale 콜백 제거
  video.pause();
  video.srcObject = null;
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  const hlsUrl = hlsMode === "ffmpeg" ? `/hls/${camId}.m3u8` : `${CONFIG.GO2RTC_BASE}/api/stream.m3u8?src=${camId}`;

  function createHls() {
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    if (Hls.isSupported()) {
      hlsInstance = new Hls({
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 2,
        maxBufferLength: 1.5,
        maxMaxBufferLength: 3,
        levelLoadingMaxRetry: 10,
        manifestLoadingMaxRetry: 10,
        backBufferLength: 0,
        lowLatencyMode: true,
        highBufferWatchdogPeriod: 1,
      });
      hlsInstance.loadSource(hlsUrl);
      hlsInstance.attachMedia(video);

      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        currentMode = "hls";
        overlay.classList.add("hidden");
        showBadge("hls");
      });
      hlsInstance.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          hlsInstance.destroy();
          hlsInstance = null;
          setTimeout(createHls, 500);
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl;
      video.addEventListener(
        "loadeddata",
        () => {
          video.play().catch(() => {});
          currentMode = "hls";
          overlay.classList.add("hidden");
          showBadge("hls");
        },
        { once: true },
      );
      video.addEventListener(
        "error",
        () => {
          setTimeout(createHls, 500);
        },
        { once: true },
      );
    }
  }

  createHls();
}

function disconnect() {
  if (pc) {
    pc.close();
    pc = null;
  }
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
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

// ── PTZ 제어 ──
function ptzCtrl(pan, tilt, zoom) {
  fetch(`${CONFIG.API_BASE}/api/ptz/${cameraId}/move`, {
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
