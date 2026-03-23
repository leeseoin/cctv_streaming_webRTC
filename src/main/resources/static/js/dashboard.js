const MAX_CHANNELS = 40;
let activeChannels = 40;  // 현재 연결할 채널 수
const peerConnections = {};
const hlsInstances = {};   // hls.js 인스턴스 관리
let connectedCount = 0;
let streamMode = "webrtc"; // 'webrtc' | 'hls'

// 그리드 생성 (40개 전부 만들어두고, 채널 수에 따라 표시/숨김)
const grid = document.getElementById("grid");
for (let i = 1; i <= MAX_CHANNELS; i++) {
  const id = "emu" + String(i).padStart(2, "0");
  const cell = document.createElement("div");
  cell.className = "cell";
  cell.id = "cell-" + id;
  cell.onclick = () => openFullscreen(id);
  cell.innerHTML = `
        <video id="video-${id}" autoplay muted playsinline></video>
        <div class="label">${id}</div>
        <div class="status-dot dot-disconnected" id="dot-${id}"></div>
        <div class="mode-badge" id="badge-${id}" style="display:none"></div>
    `;
  grid.appendChild(cell);
}

// 채널 수 변경
function updateChannelCount() {
  const count = parseInt(document.getElementById("channelCount").value);
  disconnectAll();
  activeChannels = count;
  // 셀 표시/숨김
  for (let i = 1; i <= MAX_CHANNELS; i++) {
    const cell = document.getElementById("cell-emu" + String(i).padStart(2, "0"));
    if (cell) cell.style.display = i <= count ? "" : "none";
  }
  updateStats();
}

// ── 모드 선택 ──
function setStreamMode(btn) {
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  streamMode = btn.dataset.mode;
}

// ── 카메라 연결 (모드에 따라 분기) ──
async function connectCamera(cameraId) {
  if (streamMode === "hls") {
    await connectHls(cameraId);
  } else {
    await connectWebRTC(cameraId);
  }
}

async function connectWebRTC(cameraId) {
  const dot = document.getElementById("dot-" + cameraId);
  dot.className = "status-dot dot-connecting";
  const t0 = performance.now();

  try {
    const pc = new RTCPeerConnection();
    peerConnections[cameraId] = pc;
    const t1 = performance.now();

    pc.ontrack = (event) => {
      const tTrack = performance.now();
      console.log(`[${cameraId}] ontrack (미디어 수신): +${(tTrack - t0).toFixed(0)}ms`);
      document.getElementById("video-" + cameraId).srcObject = event.streams[0];
      dot.className = "status-dot dot-connected";
      setBadge(cameraId, "webrtc");
      connectedCount++;
      updateStats();
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[${cameraId}] ICE state: ${pc.iceConnectionState} +${(performance.now() - t0).toFixed(0)}ms`);
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        dot.className = "status-dot dot-disconnected";
        setBadge(cameraId, null);
        connectedCount = Math.max(0, connectedCount - 1);
        updateStats();
      }
    };

    pc.addTransceiver("video", { direction: "recvonly" });

    const offer = await pc.createOffer();
    const t2 = performance.now();

    await pc.setLocalDescription(offer);
    const t3 = performance.now();

    const response = await fetch(`/api/cameras/${cameraId}/webrtc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: offer.type,
        sdp: offer.sdp,
      }),
    });
    const t4 = performance.now();

    if (!response.ok) throw new Error("서버 오류: " + response.status);

    const answer = await response.json();
    const t5 = performance.now();

    await pc.setRemoteDescription(answer);
    const t6 = performance.now();

    console.log(
      `[${cameraId}] PeerConnection:${(t1-t0).toFixed(0)}ms | createOffer:${(t2-t1).toFixed(0)}ms | setLocal:${(t3-t2).toFixed(0)}ms | fetch:${(t4-t3).toFixed(0)}ms | parse:${(t5-t4).toFixed(0)}ms | setRemote:${(t6-t5).toFixed(0)}ms | total:${(t6-t0).toFixed(0)}ms`
    );
  } catch (e) {
    console.error(`${cameraId} WebRTC 연결 실패 (+${(performance.now()-t0).toFixed(0)}ms):`, e);
    dot.className = "status-dot dot-disconnected";
  }
}

// ── HLS 연결 (hls.js 사용) ──
const hlsRetryCount = {};  // 채널별 자동 재연결 횟수
const HLS_MAX_RETRY = 5;   // 최대 자동 재연결 횟수

function connectHls(cameraId) {
  return new Promise((resolve) => {
    const video = document.getElementById("video-" + cameraId);
    const dot = document.getElementById("dot-" + cameraId);
    dot.className = "status-dot dot-connecting";

    video.srcObject = null;
    // 기존 hls 인스턴스 정리
    if (hlsInstances[cameraId]) {
      hlsInstances[cameraId].destroy();
      delete hlsInstances[cameraId];
    }

    const hlsUrl = `/api/stream.m3u8?src=${cameraId}`;

    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 5,
        maxMaxBufferLength: 10,
        maxBufferSize: 2 * 1024 * 1024,
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 1000,
        levelLoadingMaxRetry: 6,
        levelLoadingRetryDelay: 1000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
      });
      hlsInstances[cameraId] = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        dot.className = "status-dot dot-connected";
        setBadge(cameraId, "hls");
        hlsRetryCount[cameraId] = 0;  // 성공하면 카운터 리셋
        connectedCount++;
        updateStats();
        resolve();
      });
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          const retries = hlsRetryCount[cameraId] || 0;
          if (retries < HLS_MAX_RETRY) {
            // 세션 만료 → 자동 재연결 (새 세션 ID 발급)
            hlsRetryCount[cameraId] = retries + 1;
            console.warn(`[HLS] ${cameraId} 세션 만료, 재연결 ${retries + 1}/${HLS_MAX_RETRY}`);
            dot.className = "status-dot dot-connecting";
            hls.destroy();
            delete hlsInstances[cameraId];
            setTimeout(() => {
              connectHls(cameraId).then(resolve);
            }, 2000);
          } else {
            console.error(`[HLS] ${cameraId} 재연결 ${HLS_MAX_RETRY}회 초과, 포기`);
            dot.className = "status-dot dot-disconnected";
            setBadge(cameraId, null);
            resolve();
          }
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari 네이티브 HLS
      video.src = hlsUrl;
      video.addEventListener("loadeddata", () => {
        video.play().catch(() => {});
        dot.className = "status-dot dot-connected";
        setBadge(cameraId, "hls");
        connectedCount++;
        updateStats();
        resolve();
      }, { once: true });
      video.addEventListener("error", () => {
        console.error(`[HLS] ${cameraId} 실패`);
        dot.className = "status-dot dot-disconnected";
        setBadge(cameraId, null);
        resolve();
      }, { once: true });
    }
  });
}

function disconnectCamera(cameraId) {
  if (peerConnections[cameraId]) {
    peerConnections[cameraId].close();
    delete peerConnections[cameraId];
  }
  if (hlsInstances[cameraId]) {
    hlsInstances[cameraId].destroy();
    delete hlsInstances[cameraId];
  }
  const video = document.getElementById("video-" + cameraId);
  if (video) {
    video.srcObject = null;
    video.removeAttribute("src");
    video.load();
  }
  const dot = document.getElementById("dot-" + cameraId);
  if (dot) dot.className = "status-dot dot-disconnected";
  setBadge(cameraId, null);
}

/**
 * 모드 뱃지 표시 (WebRTC / HLS / 없음)
 */
function setBadge(cameraId, mode) {
  const badge = document.getElementById("badge-" + cameraId);
  if (!badge) return;
  if (!mode) {
    badge.style.display = "none";
    return;
  }
  badge.style.display = "block";
  if (mode === "webrtc") {
    badge.textContent = "WebRTC";
    badge.className = "mode-badge badge-webrtc";
  } else {
    badge.textContent = "HLS";
    badge.className = "mode-badge badge-hls";
  }
}

async function connectAll() {
  console.log(`[Stress Test] ${streamMode} 모드, ${activeChannels}채널 연결 시작`);
  const t0 = performance.now();

  if (streamMode === "hls") {
    for (let i = 1; i <= activeChannels; i++) {
      const id = "emu" + String(i).padStart(2, "0");
      await connectHls(id);
    }
  } else {
    for (let i = 1; i <= activeChannels; i++) {
      const id = "emu" + String(i).padStart(2, "0");
      await connectWebRTC(id);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[Stress Test] ${activeChannels}채널 연결 완료: ${elapsed}초, 성공: ${connectedCount}/${activeChannels}`);
}

function disconnectAll() {
  connectedCount = 0;
  for (let i = 1; i <= MAX_CHANNELS; i++) {
    const id = "emu" + String(i).padStart(2, "0");
    hlsRetryCount[id] = HLS_MAX_RETRY;  // 재연결 방지 (의도적 해제)
    disconnectCamera(id);
  }
  // 카운터 초기화 (다음 연결을 위해)
  for (const key in hlsRetryCount) delete hlsRetryCount[key];
  updateStats();
}

/**
 * Failover 테스트: WebRTC 연결을 강제 종료 → HLS로 전환
 * WebRTC로 연결된 채널만 대상
 */
async function testFailover() {
  const webrtcIds = Object.keys(peerConnections);
  if (webrtcIds.length === 0) {
    alert("WebRTC로 연결된 채널이 없습니다.\nWebRTC 모드로 전체 연결 후 테스트하세요.");
    return;
  }

  console.log(`[Failover 테스트] ${webrtcIds.length}개 WebRTC → HLS 전환 시작`);

  for (const id of webrtcIds) {
    const pc = peerConnections[id];
    if (pc) {
      pc.close();
      delete peerConnections[id];
      connectedCount = Math.max(0, connectedCount - 1);
      updateStats();
    }

    // HLS로 재연결 (순차적으로 — 브라우저 동시 연결 제한 우회)
    console.log(`[Failover] ${id}: WebRTC → HLS 전환`);
    await connectHls(id);
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("[Failover 테스트] 완료");
}

function updateStats() {
  document.getElementById("stats").textContent = `연결: ${connectedCount}/${activeChannels}`;
}

// 풀스크린
let fullscreenHls = null;

function openFullscreen(cameraId) {
  const video = document.getElementById("video-" + cameraId);
  const fsVideo = document.getElementById("fullscreen-video");

  // 기존 풀스크린 HLS 정리
  if (fullscreenHls) {
    fullscreenHls.destroy();
    fullscreenHls = null;
  }
  fsVideo.srcObject = null;
  fsVideo.removeAttribute("src");

  if (video && video.srcObject) {
    // WebRTC: srcObject 복사
    fsVideo.srcObject = video.srcObject;
  } else if (hlsInstances[cameraId]) {
    // HLS: 새 hls.js 인스턴스로 풀스크린 비디오에 연결
    const hlsUrl = `/api/stream.m3u8?src=${cameraId}`;
    fullscreenHls = new Hls({
      maxBufferLength: 10,
      maxMaxBufferLength: 30,
    });
    fullscreenHls.loadSource(hlsUrl);
    fullscreenHls.attachMedia(fsVideo);
    fullscreenHls.on(Hls.Events.MANIFEST_PARSED, () => {
      fsVideo.play().catch(() => {});
    });
  }

  document.getElementById("fullscreen-title").textContent = cameraId;
  document.getElementById("fullscreen").classList.add("active");
}

function closeFullscreen() {
  document.getElementById("fullscreen").classList.remove("active");
  if (fullscreenHls) {
    fullscreenHls.destroy();
    fullscreenHls = null;
  }
  const fsVideo = document.getElementById("fullscreen-video");
  fsVideo.srcObject = null;
  fsVideo.removeAttribute("src");
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeFullscreen();
});
