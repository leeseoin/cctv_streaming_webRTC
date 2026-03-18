const TOTAL = 40;
const peerConnections = {};
let connectedCount = 0;
let streamMode = "webrtc"; // 'webrtc' | 'hls'

// 그리드 생성
const grid = document.getElementById("grid");
for (let i = 1; i <= TOTAL; i++) {
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

// ── HLS 연결 (Promise로 감싸서 순차 연결 가능) ──
function connectHls(cameraId) {
  return new Promise((resolve) => {
    const video = document.getElementById("video-" + cameraId);
    const dot = document.getElementById("dot-" + cameraId);
    dot.className = "status-dot dot-connecting";

    video.srcObject = null;
    video.src = `/go2rtc/api/stream.mp4?src=${cameraId}`;

    video.addEventListener(
      "loadeddata",
      () => {
        video.play().catch(() => {});
        dot.className = "status-dot dot-connected";
        setBadge(cameraId, "hls");
        connectedCount++;
        updateStats();
        resolve();
      },
      { once: true },
    );

    video.addEventListener(
      "error",
      () => {
        console.error(`[HLS] ${cameraId} 실패`);
        dot.className = "status-dot dot-disconnected";
        setBadge(cameraId, null);
        resolve(); // 실패해도 다음 채널로 진행
      },
      { once: true },
    );
  });
}

function disconnectCamera(cameraId) {
  if (peerConnections[cameraId]) {
    peerConnections[cameraId].close();
    delete peerConnections[cameraId];
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
  if (streamMode === "hls") {
    // HLS: 순차 연결 (브라우저 동시 HTTP 연결 제한)
    for (let i = 1; i <= TOTAL; i++) {
      const id = "emu" + String(i).padStart(2, "0");
      await connectHls(id);
    }
  } else {
    // WebRTC: 순차 연결 + 딜레이 (go2rtc 부하 방지)
    for (let i = 1; i <= TOTAL; i++) {
      const id = "emu" + String(i).padStart(2, "0");
      await connectWebRTC(id);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function disconnectAll() {
  connectedCount = 0;
  for (let i = 1; i <= TOTAL; i++) {
    const id = "emu" + String(i).padStart(2, "0");
    disconnectCamera(id);
  }
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
  document.getElementById("stats").textContent = `연결: ${connectedCount}/${TOTAL}`;
}

// 풀스크린
function openFullscreen(cameraId) {
  const video = document.getElementById("video-" + cameraId);
  const fsVideo = document.getElementById("fullscreen-video");
  if (video && video.srcObject) {
    fsVideo.srcObject = video.srcObject;
  } else if (video && video.src) {
    fsVideo.src = video.src;
  }
  document.getElementById("fullscreen-title").textContent = cameraId;
  document.getElementById("fullscreen").classList.add("active");
}

function closeFullscreen() {
  document.getElementById("fullscreen").classList.remove("active");
  const fsVideo = document.getElementById("fullscreen-video");
  fsVideo.srcObject = null;
  fsVideo.removeAttribute("src");
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeFullscreen();
});
