/**
 * embed.js — iframe 임베딩용 CCTV 플레이어
 *
 * 사용법: /embed.html?cam=cam01
 * - WebRTC + HLS Failover (Auto)
 * - WebRTC 전용
 * - HLS(MP4) 전용
 * - PTZ 컨트롤 (ONVIF 백엔드 연동 시 동작)
 */
const params = new URLSearchParams(location.search);
const cameraId = params.get('cam');
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const modeBadge = document.getElementById('modeBadge');

let pc = null;
let currentMode = null;       // 'webrtc' | 'hls'
let streamMode = 'webrtc-hls'; // 'webrtc' | 'hls' | 'webrtc-hls'

// ── 초기화 ──
if (!cameraId) {
    statusEl.textContent = '카메라 ID 없음 (?cam=xxx)';
    statusEl.classList.add('error');
} else {
    document.title = cameraId + ' - CCTV';
    connect();
}

// ── 연결 ──
function connect() {
    disconnect();
    if (streamMode === 'hls') {
        startMp4(cameraId);
    } else {
        connectWebRTC(cameraId);
    }
}

async function connectWebRTC(camId) {
    setStatus('WebRTC 연결 중...');
    overlay.classList.remove('hidden');

    try {
        pc = new RTCPeerConnection();

        pc.ontrack = (event) => {
            video.srcObject = event.streams[0];
            currentMode = 'webrtc';
            overlay.classList.add('hidden');
            showBadge('webrtc');
        };

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            if (state === 'failed') {
                if (pc) { pc.close(); pc = null; }
                if (streamMode === 'webrtc-hls') {
                    // Auto 모드: HLS로 전환
                    startMp4(camId);
                } else {
                    setStatus('WebRTC 연결 실패');
                }
            } else if (state === 'disconnected') {
                setStatus('연결 끊김');
                overlay.classList.remove('hidden');
            }
        };

        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        // ICE gathering
        let gatherResolve;
        const gatherPromise = new Promise(resolve => { gatherResolve = resolve; });

        pc.onicecandidate = (event) => {
            if (!event.candidate) gatherResolve();
        };
        pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') gatherResolve();
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await Promise.race([
            gatherPromise,
            new Promise(resolve => setTimeout(resolve, 10000))
        ]);

        const response = await fetch(`/api/cameras/${camId}/webrtc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: pc.localDescription.type,
                sdp: pc.localDescription.sdp
            })
        });

        if (!response.ok) throw new Error('서버 응답 오류: ' + response.status);

        const answer = await response.json();
        await pc.setRemoteDescription(answer);

    } catch (e) {
        console.error('[embed] WebRTC 실패:', e);
        if (pc) { pc.close(); pc = null; }
        if (streamMode === 'webrtc-hls') {
            startMp4(camId);
        } else {
            setStatus('WebRTC 연결 실패: ' + e.message);
        }
    }
}

function startMp4(camId) {
    setStatus('HTTP Stream 연결 중...');
    overlay.classList.remove('hidden');

    video.pause();
    video.srcObject = null;
    video.src = `/go2rtc/api/stream.mp4?src=${camId}`;

    video.addEventListener('loadeddata', () => {
        video.play().catch(() => {});
        currentMode = 'hls';
        overlay.classList.add('hidden');
        showBadge('hls');
    }, { once: true });

    video.addEventListener('error', () => {
        setStatus('스트림 연결 실패');
        statusEl.classList.add('error');
    }, { once: true });
}

function disconnect() {
    if (pc) { pc.close(); pc = null; }
    video.pause();
    video.srcObject = null;
    video.removeAttribute('src');
    currentMode = null;
    modeBadge.classList.add('hidden');
}

// ── 상태 표시 ──
function setStatus(text) {
    statusEl.textContent = text;
    statusEl.classList.remove('error');
    overlay.classList.remove('hidden');
}

function showBadge(mode) {
    modeBadge.classList.remove('hidden', 'webrtc', 'hls');
    modeBadge.classList.add(mode);
    modeBadge.textContent = mode === 'webrtc' ? 'WebRTC' : 'HTTP Stream';
}

// ── 스트리밍 모드 전환 ──
function switchMode(btn) {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    streamMode = btn.dataset.mode;
    connect();
}

// ── PTZ 제어 ──
function ptzCtrl(pan, tilt, zoom) {
    fetch(`/api/ptz/${cameraId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pan, tilt, zoom })
    }).catch(e => console.warn('[PTZ]', e));
}

// ── 하단 패널 토글 ──
function togglePanel(open) {
    const panel = document.getElementById('controlPanel');
    const openBtn = document.getElementById('openBtn');
    const closeBtn = document.getElementById('closeBtn');

    if (open) {
        panel.classList.remove('hidden');
        openBtn.classList.add('hidden');
        closeBtn.classList.remove('hidden');
    } else {
        panel.classList.add('hidden');
        openBtn.classList.remove('hidden');
        closeBtn.classList.add('hidden');
    }
}

// ── 전체화면 ──
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen();
    }
}
