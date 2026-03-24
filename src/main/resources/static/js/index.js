let pc = null;
let currentMode = null;     // 'webrtc' 또는 'hls'
let statsInterval = null;
let prevBytesReceived = 0;
let prevTimestamp = 0;
let hlsInstance = null;     // hls.js 인스턴스
const video = document.getElementById('video');
const status = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statsPanel = document.getElementById('statsPanel');

// 스트리밍 모드에 따라 ICE 설정 패널 표시/숨김
document.querySelectorAll('input[name="streamMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
        const mode = document.querySelector('input[name="streamMode"]:checked').value;
        document.getElementById('iceModePanel').style.display = (mode === 'hls') ? 'none' : 'flex';
    });
});

async function connect() {
    const cameraId = document.getElementById('cameraSelect').value;
    const streamMode = document.querySelector('input[name="streamMode"]:checked').value;

    setStatus('연결 중...', 'connecting');
    connectBtn.disabled = true;

    // HLS 전용 모드
    if (streamMode === 'hls') {
        fallbackToHls(cameraId);
        return;
    }

    try {
        // ICE 모드에 따라 설정 결정
        const iceMode = document.querySelector('input[name="iceMode"]:checked').value;
        const rtcConfig = {};

        if (iceMode === 'turn') {
            rtcConfig.iceServers = [
                { urls: 'stun:192.168.0.83:3478' },
                {
                    urls: 'turn:192.168.0.83:3478',
                    username: 'cctv',
                    credential: 'cctv1234'
                }
            ];
        }
        // relay 모드: TURN만 사용 (STUN 불필요, P2P 차단)
        if (iceMode === 'relay') {
            rtcConfig.iceServers = [
                {
                    urls: [
                        'turn:192.168.0.83:3478?transport=udp',
                        'turn:192.168.0.83:3478?transport=tcp'
                    ],
                    username: 'cctv',
                    credential: 'cctv1234'
                }
            ];
            rtcConfig.iceTransportPolicy = 'relay';
        }
        // 공개 TURN 테스트용 (coturn 문제 분리용)
        if (iceMode === 'test') {
            rtcConfig.iceServers = [
                {
                    urls: 'turn:standard.relay.metered.ca:443?transport=tcp',
                    username: 'b093c0673684ba88af1de99b',
                    credential: '2X3OoXjOqLgjRGWY'
                }
            ];
            rtcConfig.iceTransportPolicy = 'relay';
        }

        console.log('ICE 모드:', iceMode, 'RTCConfig:', JSON.stringify(rtcConfig));

        pc = new RTCPeerConnection(rtcConfig);

        pc.ontrack = (event) => {
            video.srcObject = event.streams[0];
            disconnectBtn.disabled = false;
        };

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            console.log('ICE 상태:', state);
            if (state === 'connected' || state === 'completed') {
                currentMode = 'webrtc';
                setStatus('연결됨 - ' + cameraId + ' <span class="webrtc-badge">WebRTC</span>', 'connected');
            } else if (state === 'checking') {
                setStatus('ICE 연결 확인 중... (' + iceMode + ')', 'connecting');
            } else if (state === 'failed') {
                if (pc) { pc.close(); pc = null; }
                // WebRTC + HLS Failover 모드일 때만 자동 전환
                if (streamMode === 'webrtc-hls') {
                    console.log('[Failover] WebRTC 실패 → HLS 전환 시도');
                    fallbackToHls(cameraId);
                } else {
                    setStatus('WebRTC 연결 실패', 'disconnected');
                    connectBtn.disabled = false;
                }
            } else if (state === 'disconnected') {
                setStatus('연결 끊김', 'disconnected');
                disconnect();
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('ICE 후보:', event.candidate.type, event.candidate.candidate);
            }
        };

        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        // ICE 후보 수집 핸들러 (setLocalDescription 전에 등록)
        let gatherResolve = null;
        const gatherPromise = new Promise(resolve => { gatherResolve = resolve; });

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('[ICE 후보]', event.candidate.type, event.candidate.address, event.candidate.protocol);
            } else {
                console.log('[ICE] 후보 수집 완료 (null candidate)');
                gatherResolve();
            }
        };
        pc.onicegatheringstatechange = () => {
            console.log('[ICE] gathering 상태:', pc.iceGatheringState);
            if (pc.iceGatheringState === 'complete') gatherResolve();
        };

        console.log('[1] offer 생성 시작');
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log('[2] setLocalDescription 완료, ICE gathering 대기...');

        // gathering 완료 또는 15초 타임아웃
        await Promise.race([
            gatherPromise,
            new Promise(resolve => setTimeout(() => {
                console.log('[ICE] gathering 타임아웃 (15초), 현재 후보로 진행');
                resolve();
            }, 15000))
        ]);

        // 수집된 ICE 후보 확인
        const sdp = pc.localDescription.sdp;
        const candidates = sdp.match(/a=candidate:.*/g) || [];
        console.log('[3] ICE gathering 완료, 후보 수:', candidates.length);
        candidates.forEach(c => console.log('  ', c));

        // Java 서버에 SDP offer 전송
        console.log('[4] SDP offer 전송 시작');
        const response = await fetch(`/api/cameras/${cameraId}/webrtc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: pc.localDescription.type,
                sdp: pc.localDescription.sdp
            })
        });

        if (!response.ok) {
            throw new Error('서버 응답 오류: ' + response.status);
        }

        const answer = await response.json();
        console.log('[5] SDP answer 수신, type:', answer.type);
        console.log('[5-1] answer SDP 후보:', (answer.sdp.match(/a=candidate:.*/g) || []).length, '개');

        await pc.setRemoteDescription(answer);
        console.log('[6] setRemoteDescription 완료, ICE 상태:', pc.iceConnectionState);

        // WebRTC 통계 수집 시작
        startStats();

    } catch (e) {
        console.error('연결 실패:', e);
        setStatus('연결 실패: ' + e.message, 'disconnected');
        connectBtn.disabled = false;
        disconnect();
    }
}

function disconnect() {
    stopStats();
    if (pc) {
        pc.close();
        pc = null;
    }
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
    currentMode = null;
    setStatus('연결 안 됨', 'disconnected');
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    statsPanel.style.display = 'none';
}

function setStatus(text, className) {
    status.innerHTML = text;
    status.className = className;
}

/**
 * HLS Failover: WebRTC 실패 시 go2rtc HLS 스트림으로 전환
 * go2rtc의 HLS 출력(/api/stream.m3u8)을 hls.js로 재생
 */
function fallbackToHls(cameraId) {
    setStatus('HLS 스트림 전환 중...', 'connecting');

    // 이전 재생 상태 정리
    video.pause();
    video.srcObject = null;
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

    const hlsUrl = `/go2rtc/api/stream.m3u8?src=${cameraId}`;

    if (Hls.isSupported()) {
        hlsInstance = new Hls();
        hlsInstance.loadSource(hlsUrl);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => {});
            currentMode = 'hls';
            setStatus('연결됨 - ' + cameraId + ' <span class="hls-badge">HLS</span>', 'connected');
            disconnectBtn.disabled = false;
            startStats();
        });
        hlsInstance.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                console.error('[HLS] 치명적 오류:', data);
                setStatus('HLS 스트림 연결 실패', 'disconnected');
                connectBtn.disabled = false;
            }
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari 네이티브 HLS
        video.src = hlsUrl;
        video.addEventListener('loadeddata', () => {
            video.play().catch(() => {});
            currentMode = 'hls';
            setStatus('연결됨 - ' + cameraId + ' <span class="hls-badge">HLS</span>', 'connected');
            disconnectBtn.disabled = false;
            startStats();
        }, { once: true });
        video.addEventListener('error', () => {
            setStatus('HLS 스트림 연결 실패', 'disconnected');
            connectBtn.disabled = false;
        }, { once: true });
    }
}

// 통계 수집
function startStats() {
    prevBytesReceived = 0;
    prevTimestamp = 0;
    statsPanel.style.display = 'block';
    statsInterval = setInterval(collectStats, 1000);
}

function stopStats() {
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }
}

let prevTotalFrames = 0;

async function collectStats() {
    // HTTP Stream 모드: video 엘리먼트에서 직접 통계 수집
    if (currentMode === 'hls') {
        document.getElementById('statsTitle').textContent = 'HTTP Stream 통계 (1초마다 갱신)';

        // 해상도
        if (video.videoWidth && video.videoHeight) {
            document.getElementById('stat-resolution').textContent =
                video.videoWidth + '×' + video.videoHeight;
        }

        // 프레임 통계 (getVideoPlaybackQuality)
        const quality = video.getVideoPlaybackQuality?.();
        if (quality) {
            // 드롭 프레임
            document.getElementById('stat-dropped').textContent = quality.droppedVideoFrames;

            // FPS 추정 (1초간 렌더된 프레임 수)
            const currentTotal = quality.totalVideoFrames;
            if (prevTotalFrames > 0) {
                const fps = currentTotal - prevTotalFrames;
                document.getElementById('stat-fps').textContent = fps > 0 ? fps : '-';
            }
            prevTotalFrames = currentTotal;
        }

        // WebRTC 전용 지표는 N/A 표시
        document.getElementById('stat-rtt').textContent = '-';
        document.getElementById('stat-jitter').textContent = '-';
        document.getElementById('stat-bitrate').textContent = '-';
        document.getElementById('stat-packetloss').textContent = '-';
        document.getElementById('stat-connection').textContent = '연결 방식: HLS';
        return;
    }

    // WebRTC 모드
    if (!pc) return;
    document.getElementById('statsTitle').textContent = 'WebRTC 연결 통계 (1초마다 갱신)';

    try {
        const stats = await pc.getStats();

        stats.forEach(report => {
            // 연결 후보쌍 (RTT, 연결 방식)
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                const rtt = report.currentRoundTripTime;
                if (rtt !== undefined) {
                    document.getElementById('stat-rtt').textContent = (rtt * 1000).toFixed(1);
                }

                // 연결 방식 표시 (P2P인지 TURN인지)
                const localId = report.localCandidateId;
                const remoteId = report.remoteCandidateId;
                stats.forEach(c => {
                    if (c.id === localId && c.type === 'local-candidate') {
                        const type = c.candidateType; // host, srflx, relay
                        let label = 'P2P 직접 연결';
                        if (type === 'relay') label = 'TURN 중계 연결';
                        else if (type === 'srflx') label = 'STUN 반사 연결';
                        document.getElementById('stat-connection').textContent =
                            `연결 방식: ${label} (${type}) | ${c.protocol?.toUpperCase() || ''}`;
                    }
                });
            }

            // 수신 영상 통계 (비트레이트, 프레임, 해상도, 패킷손실, jitter)
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
                // 비트레이트 계산
                if (prevTimestamp > 0) {
                    const byteDiff = report.bytesReceived - prevBytesReceived;
                    const timeDiff = (report.timestamp - prevTimestamp) / 1000;
                    if (timeDiff > 0) {
                        const kbps = Math.round((byteDiff * 8) / timeDiff / 1000);
                        document.getElementById('stat-bitrate').textContent = kbps;
                    }
                }
                prevBytesReceived = report.bytesReceived;
                prevTimestamp = report.timestamp;

                // 프레임률
                if (report.framesPerSecond !== undefined) {
                    document.getElementById('stat-fps').textContent = report.framesPerSecond;
                }

                // 해상도
                if (report.frameWidth && report.frameHeight) {
                    document.getElementById('stat-resolution').textContent =
                        report.frameWidth + '×' + report.frameHeight;
                }

                // 패킷 손실률
                if (report.packetsLost !== undefined && report.packetsReceived > 0) {
                    const lossRate = (report.packetsLost / (report.packetsReceived + report.packetsLost) * 100);
                    document.getElementById('stat-packetloss').textContent = lossRate.toFixed(2);
                }

                // Jitter
                if (report.jitter !== undefined) {
                    document.getElementById('stat-jitter').textContent = (report.jitter * 1000).toFixed(1);
                }
            }
        });

        // WebRTC 드롭 프레임
        const quality = video.getVideoPlaybackQuality?.();
        if (quality) {
            document.getElementById('stat-dropped').textContent = quality.droppedVideoFrames;
        }
    } catch (e) {
        console.error('통계 수집 실패:', e);
    }
}
