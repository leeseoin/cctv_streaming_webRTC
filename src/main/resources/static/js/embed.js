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
let hlsBaseUrl = `${CONFIG.GO2RTC_BASE}/api`;
const hlsMode = params.get("hls") || "go2rtc"; // "go2rtc" | "ffmpeg"

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
async function connect() {
  disconnect();

  // network-check 1회 호출
  let isLocal = true;
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/nms/network-check`);
    const info = await res.json();
    isLocal = info.local;
    hlsBaseUrl = `${CONFIG.GO2RTC_BASE}/api`;
  } catch (e) {
    console.warn("[embed] network-check 실패:", e);
  }

  if (streamMode === "hls" || (streamMode === "webrtc-hls" && !isLocal)) {
    startHls(cameraId);
  } else if (streamMode === "webrtc" || (streamMode === "webrtc-hls" && isLocal)) {
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

    let iceTimeout = null;

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === "connected" || state === "completed") {
        if (iceTimeout) {
          clearTimeout(iceTimeout);
          iceTimeout = null;
        }
      } else if (state === "failed" || state === "disconnected") {
        // disconnected도 5초 후 fallback (failed로 안 넘어가는 경우 대비)
        if (iceTimeout) clearTimeout(iceTimeout);
        iceTimeout = setTimeout(
          () => {
            if (pc) {
              pc.close();
              pc = null;
            }
            if (streamMode === "webrtc-hls") {
              setStatus("WebRTC 실패 → HLS 전환 중...");
              startHls(camId);
            } else {
              setStatus("WebRTC 연결 실패");
            }
          },
          state === "failed" ? 0 : 5000,
        );
      }
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const response = await fetch(`${CONFIG.API_BASE}/api/cameras/${camId}/webrtc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: offer.type, sdp: offer.sdp }),
    });

    if (!response.ok) throw new Error("서버 응답 오류: " + response.status);

    const answer = await response.json();
    await pc.setRemoteDescription(answer);

    // ICE 연결 10초 타임아웃 (SDP 교환 성공했지만 ICE가 안 되는 경우)
    iceTimeout = setTimeout(() => {
      if (pc && pc.iceConnectionState !== "connected" && pc.iceConnectionState !== "completed") {
        pc.close();
        pc = null;
        if (streamMode === "webrtc-hls") {
          setStatus("WebRTC 타임아웃 → HLS 전환 중...");
          startHls(camId);
        } else {
          setStatus("WebRTC 연결 타임아웃");
        }
      }
    }, 10000);
  } catch (e) {
    console.error("[embed] WebRTC 실패:", e);
    if (pc) {
      pc.close();
      pc = null;
    }
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
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  const hlsUrl = hlsMode === "ffmpeg"
    ? `/hls/${camId}.m3u8`                          // FFmpeg HLS (4초 segment)
    : `${hlsBaseUrl}/stream.m3u8?src=${camId}`;     // go2rtc HLS (2초 segment)

  function createHls() {
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    if (Hls.isSupported()) {
      // Chrome/Android — hls.js
      hlsInstance = new Hls({
        liveSyncDurationCount: 1,        // 라이브 edge에서 1 segment 뒤 (최소)
        liveMaxLatencyDurationCount: 2,   // 최대 2 segment 뒤 (넘으면 seek)
        maxBufferLength: 1.5,             // 최대 1.5초 버퍼 (segment 1개분)
        maxMaxBufferLength: 3,            // 절대 최대 3초
        levelLoadingMaxRetry: 10,
        manifestLoadingMaxRetry: 10,
        backBufferLength: 0,              // 뒤로감기 버퍼 없음
        lowLatencyMode: true,             // 저지연 모드
        highBufferWatchdogPeriod: 1,      // 버퍼 감시 주기 1초
      });
      hlsInstance.loadSource(hlsUrl);
      hlsInstance.attachMedia(video);

      // 디버그: 단계별 타이밍 로그
      const hlsStart = Date.now();
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log(`[HLS] ⏱ manifest parsed: +${Date.now() - hlsStart}ms`);
        video.play().catch(() => {});
        currentMode = "hls";
        overlay.classList.add("hidden");
        showBadge("hls");
      });
      hlsInstance.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
        console.log(`[HLS] ⏱ playlist loaded: +${Date.now() - hlsStart}ms, segments: ${data.details.fragments.length}, live: ${data.details.live}`);
      });
      hlsInstance.on(Hls.Events.FRAG_LOADED, (_e, data) => {
        console.log(`[HLS] ⏱ segment ${data.frag.sn} loaded: +${Date.now() - hlsStart}ms, size: ${(data.frag.stats.total/1024).toFixed(1)}KB`);
      });
      hlsInstance.on(Hls.Events.FRAG_BUFFERED, (_e, data) => {
        const buffered = video.buffered;
        const bufferEnd = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
        const bufferLen = bufferEnd - video.currentTime;
        console.log(`[HLS] ⏱ segment ${data.frag.sn} buffered: +${Date.now() - hlsStart}ms, buffer: ${bufferLen.toFixed(1)}s`);
      });
      hlsInstance.on(Hls.Events.ERROR, (_event, data) => {
        console.warn(`[HLS] error: ${data.type} ${data.details} fatal: ${data.fatal}`);
        if (data.fatal) {
          hlsInstance.destroy();
          hlsInstance = null;
          setTimeout(createHls, 500);
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // hls.js 미지원 브라우저 — 네이티브 HLS fallback
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

// ── 스트리밍 모드 전환 ──
function switchMode(btn) {
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  streamMode = btn.dataset.mode;
  connect();
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
