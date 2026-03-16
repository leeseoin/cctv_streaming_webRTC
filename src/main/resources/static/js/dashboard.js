const TOTAL = 40;
const peerConnections = {};
let connectedCount = 0;

// 그리드 생성
const grid = document.getElementById('grid');
for (let i = 1; i <= TOTAL; i++) {
    const id = 'emu' + String(i).padStart(2, '0');
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.id = 'cell-' + id;
    cell.onclick = () => openFullscreen(id);
    cell.innerHTML = `
        <video id="video-${id}" autoplay muted playsinline></video>
        <div class="label">${id}</div>
        <div class="status-dot dot-disconnected" id="dot-${id}"></div>
        <div class="mode-badge" id="badge-${id}" style="display:none"></div>
    `;
    grid.appendChild(cell);
}

async function connectCamera(cameraId) {
    const dot = document.getElementById('dot-' + cameraId);
    dot.className = 'status-dot dot-connecting';

    try {
        const pc = new RTCPeerConnection();
        peerConnections[cameraId] = pc;

        pc.ontrack = (event) => {
            document.getElementById('video-' + cameraId).srcObject = event.streams[0];
            dot.className = 'status-dot dot-connected';
            setBadge(cameraId, 'webrtc');
            connectedCount++;
            updateStats();
        };

        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'failed') {
                // WebRTC 실패 → HLS Failover
                console.log(`[Failover] ${cameraId}: WebRTC 실패 → HLS 전환`);
                pc.close();
                delete peerConnections[cameraId];
                fallbackToHls(cameraId);
            } else if (pc.iceConnectionState === 'disconnected') {
                dot.className = 'status-dot dot-disconnected';
                setBadge(cameraId, null);
                connectedCount = Math.max(0, connectedCount - 1);
                updateStats();
            }
        };

        pc.addTransceiver('video', { direction: 'recvonly' });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        if (pc.iceGatheringState !== 'complete') {
            await new Promise(resolve => {
                pc.onicegatheringstatechange = () => {
                    if (pc.iceGatheringState === 'complete') resolve();
                };
            });
        }

        const response = await fetch(`/api/cameras/${cameraId}/webrtc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: pc.localDescription.type,
                sdp: pc.localDescription.sdp
            })
        });

        if (!response.ok) throw new Error('서버 오류: ' + response.status);

        const answer = await response.json();
        await pc.setRemoteDescription(answer);

    } catch (e) {
        console.error(`${cameraId} 연결 실패:`, e);
        dot.className = 'status-dot dot-disconnected';
    }
}

function disconnectCamera(cameraId) {
    if (peerConnections[cameraId]) {
        peerConnections[cameraId].close();
        delete peerConnections[cameraId];
    }
    const video = document.getElementById('video-' + cameraId);
    if (video) {
        video.srcObject = null;
        video.removeAttribute('src');
        video.load();
    }
    const dot = document.getElementById('dot-' + cameraId);
    if (dot) dot.className = 'status-dot dot-disconnected';
    setBadge(cameraId, null);
}

/**
 * HLS Failover: WebRTC 실패 시 go2rtc MP4 스트림으로 전환
 */
function fallbackToHls(cameraId) {
    const video = document.getElementById('video-' + cameraId);
    const dot = document.getElementById('dot-' + cameraId);

    video.srcObject = null;
    video.src = `/go2rtc/api/stream.mp4?src=${cameraId}`;

    video.addEventListener('loadeddata', () => {
        video.play().catch(() => {});
        dot.className = 'status-dot dot-connected';
        setBadge(cameraId, 'hls');
        connectedCount++;
        updateStats();
    }, { once: true });

    video.addEventListener('error', () => {
        console.error(`[HTTP Stream] ${cameraId} 실패`);
        dot.className = 'status-dot dot-disconnected';
        setBadge(cameraId, null);
    }, { once: true });
}

/**
 * 모드 뱃지 표시 (WebRTC / HLS / 없음)
 */
function setBadge(cameraId, mode) {
    const badge = document.getElementById('badge-' + cameraId);
    if (!badge) return;
    if (!mode) {
        badge.style.display = 'none';
        return;
    }
    badge.style.display = 'block';
    if (mode === 'webrtc') {
        badge.textContent = 'WebRTC';
        badge.className = 'mode-badge badge-webrtc';
    } else {
        badge.textContent = 'HLS';
        badge.className = 'mode-badge badge-hls';
    }
}

async function connectAll() {
    // 순차적으로 연결 (동시에 40개 요청하면 부하 큼)
    for (let i = 1; i <= TOTAL; i++) {
        const id = 'emu' + String(i).padStart(2, '0');
        await connectCamera(id);
        // 약간의 딜레이로 서버 부하 분산
        await new Promise(r => setTimeout(r, 200));
    }
}

function disconnectAll() {
    connectedCount = 0;
    for (let i = 1; i <= TOTAL; i++) {
        const id = 'emu' + String(i).padStart(2, '0');
        disconnectCamera(id);
    }
    updateStats();
}

function updateStats() {
    document.getElementById('stats').textContent = `연결: ${connectedCount}/${TOTAL}`;
}

// 풀스크린
function openFullscreen(cameraId) {
    const video = document.getElementById('video-' + cameraId);
    const fsVideo = document.getElementById('fullscreen-video');
    if (video && video.srcObject) {
        fsVideo.srcObject = video.srcObject;
    }
    document.getElementById('fullscreen-title').textContent = cameraId;
    document.getElementById('fullscreen').classList.add('active');
}

function closeFullscreen() {
    document.getElementById('fullscreen').classList.remove('active');
    document.getElementById('fullscreen-video').srcObject = null;
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFullscreen();
});
