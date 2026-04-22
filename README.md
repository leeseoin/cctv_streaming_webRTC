# CCTV Streamer

RTSP IP 카메라 영상을 WebRTC / HLS로 실시간 스트리밍하는 시스템.

---

## 전체 아키텍처

```
                      ┌─────────────────────────────────────────────────┐
                      │                  On-Premise 서버                  │
                      │                                                   │
 카메라 40대           │  ┌──────────┐   ┌──────────────────────────────┐ │
 (Hikvision RTSP) ────┼─▶│  go2rtc  │   │  Nginx (호스트 설치, :8443)  │ │
                      │  │          │◀──│  - SSL 종단 (Let's Encrypt)   │ │
                      │  │ WebRTC   │   │  - /api/ptz → ptz-service     │ │
                      │  │ HLS      │   │  - 나머지   → go2rtc:1984     │ │
                      │  │ :1984    │   │  - 정적파일 → /static/        │ │
                      │  └──────────┘   └──────────────────────────────┘ │
                      │                         ▲ :8443 TCP/UDP           │
                      │  ┌────────────────────┐ │                         │
                      │  │  ptz-service       │ │                         │
                      │  │  Spring Boot :8086 │ │ 공유기 포트포워딩        │
                      │  │  profile=onprem    │ │ 외부 8443 → 내부 8443   │
                      │  └────────────────────┘ │                         │
                      │                         │                         │
                      │  모니터링 스택            │                         │
                      │  go2rtc-exporter :1985   │                         │
                      │  camera-label-exporter :1986                       │
                      │  node-exporter (host)    │                         │
                      │  prometheus :9090        │                         │
                      │        │                 │                         │
                      │        │ autossh Reverse Tunnel                    │
                      │        └─────────────────────────────────────────┼─┐
                      └─────────────────────────────────────────────────┘ │
                                                                           │
         ┌─────────────────────────┐          ┌──────────────────────┐    │
         │   AWS-A (iptest.devsp.kr)│          │  AWS-B (Grafana)      │    │
         │   Spring Boot :8085     │          │  Grafana :3000        │◀──┘
         │   profile=docker        │          │  Prometheus ← :29090  │
         │   ─ EmbedRedirectCtrl   │          │  (Reverse Tunnel)     │
         │     /embed.html → 302   │          └──────────────────────┘
         │     → stream1:8443      │
         └─────────────────────────┘
```

---

## 서버 구성

### On-Premise 서버 (스트리밍 + PTZ + 모니터링)

| 서비스 | 실행 방식 | 포트 | 역할 |
|--------|-----------|------|------|
| **Nginx** | 호스트 직접 설치 | `:80`, `:8443 TCP` | SSL 종단, 리버스 프록시, 정적 파일 서빙 |
| **go2rtc** | Docker | `:1984` (HTTP API), `:8443 UDP` (WebRTC) | RTSP 수신, WebRTC/HLS 변환 |
| **ptz-service** | Docker (`profile=onprem`) | `:8086` | ONVIF PTZ 제어 |
| **mediamtx** | Docker | `:8553` | 에뮬레이터 RTSP 서버 |
| **go2rtc-exporter** | Docker | `:1985` | go2rtc API → Prometheus 메트릭 |
| **camera-label-exporter** | Docker | `:1986` | cameras.yml → `camera_info` 메트릭 |
| **node-exporter** | Docker (host 네트워크) | `:9100` | 서버 시스템 메트릭 |
| **prometheus** | Docker | `:9090` | 메트릭 수집/저장 |

**정적 파일 위치**: `/home/softpuzzle/static/` (Nginx가 직접 서빙)

```bash
# On-Premise 실행
cd ~/webrtc
docker compose up -d

# 서비스 상태 확인
docker compose ps
docker logs -f ptz-service   # PTZ 로그
docker logs -f go2rtc        # go2rtc 로그
```

---

### Nginx 라우팅 (On-Premise, :8443 TCP)

| 경로 | 목적지 | 비고 |
|------|--------|------|
| `/embed.html`, `/css/*`, `/js/*`, `/img/*` | `/home/softpuzzle/static/` | 정적 파일 직접 서빙 |
| `/api/ptz/**` | `127.0.0.1:8086` (ptz-service) | Spring Boot onprem 프로파일 |
| 나머지 (`/api/ws`, `/api/stream.m3u8` 등) | `127.0.0.1:1984` (go2rtc) | WebSocket Upgrade 지원 |

> **WebRTC UDP (:8443)는 Nginx 우회** — Docker가 직접 go2rtc 컨테이너로 전달 (UDP는 Nginx 미지원)

---

### AWS-A (iptest.devsp.kr, 시그널링/리다이렉트)

Spring Boot JAR (`profile=docker`) 단독 실행.

| 역할 | 설명 |
|------|------|
| `EmbedRedirectController` | `/embed.html?to=<base64>` → On-Premise `stream1.flexformular.com:8443` 302 리다이렉트 |
| `Go2RtcProxyController` | `/go2rtc/api/**` → go2rtc 프록시 (내부 접속용) |
| `MonitorController` | `/api/monitor` JVM 상태 |
| `/actuator/prometheus` | Spring Boot JVM 메트릭 (Prometheus 스크랩) |

```bash
# AWS-A 실행
SPRING_PROFILES_ACTIVE=docker java -jar webrtc.jar
# 또는
./scripts/start.sh
```

---

### AWS-B (Grafana)

Docker로 Grafana 단독 실행. On-Premise Prometheus를 autossh Reverse Tunnel로 연결.

```
On-Premise Prometheus:9090
    └── autossh -R 29090:localhost:9090 → AWS-B:29090
                                              └── Grafana 데이터소스 http://172.17.0.1:29090
```

---

## autossh Reverse Tunnel

On-Premise에서 AWS-B로 Prometheus를 노출하는 Reverse Tunnel. systemd 서비스로 등록되어 서버 재부팅 시 자동 시작.

### 설정 파일

`/etc/systemd/system/autossh-prometheus.service`:

```ini
[Unit]
Description=AutoSSH Reverse Tunnel - Prometheus to AWS-B Grafana
After=network.target

[Service]
Environment="AUTOSSH_GATETIME=0"
ExecStart=/usr/bin/autossh -M 0 -N \
  -o "ServerAliveInterval=30" \
  -o "ServerAliveCountMax=3" \
  -o "ExitOnForwardFailure=yes" \
  -R 29090:localhost:9090 \
  ubuntu@{aws-b-ip}
Restart=always
RestartSec=5
User=ubuntu

[Install]
WantedBy=multi-user.target
```

### 관리 명령어

```bash
# On-Premise에서
sudo systemctl status autossh-prometheus
sudo systemctl restart autossh-prometheus
journalctl -u autossh-prometheus -f   # 실시간 로그

# 터널 연결 확인 (AWS-B에서)
curl http://localhost:29090/-/healthy   # Prometheus is Healthy
```

### AWS-B sshd 설정 확인

```bash
# /etc/ssh/sshd_config
GatewayPorts yes
```

---

## 요청 흐름

### 외부 사용자 → 영상 시청

```
브라우저
  │ HTTPS https://iptest.devsp.kr/embed.html?cam=cam01
  ▼
AWS-A Spring Boot
  │ 302 → https://stream1.flexformular.com:8443/embed.html?cam=cam01
  ▼
브라우저 (주소창이 stream1로 변경)
  │ HTTPS :8443 TCP
  ▼
공유기 포트포워딩 → On-Premise Nginx
  │ /embed.html → /static/embed.html 반환
  ▼
브라우저 (HTML/JS 로드 완료)
  │ WebSocket wss://stream1.flexformular.com:8443/api/ws?src=cam01
  ▼
Nginx → go2rtc:1984 (WebRTC 시그널링)
  │ SDP offer/answer 교환
  ▼
브라우저 ◀──── WebRTC UDP :8443 ────▶ go2rtc
                (영상 P2P, AWS 미경유)
```

### PTZ 제어

```
브라우저 embed.html
  │ POST https://stream1.flexformular.com:8443/api/ptz/cam01/move
  ▼
Nginx → ptz-service:8086 (Spring Boot, profile=onprem)
  │ ONVIF SOAP ContinuousMove
  ▼
카메라 192.168.0.80
```

---

## 포트 매트릭스

| 포트 | 프로토콜 | 위치 | 용도 |
|------|----------|------|------|
| 8443 TCP | HTTPS/WSS | 공유기 → On-Premise Nginx | 웹페이지, HLS, WebSocket 시그널링 |
| 8443 UDP | DTLS | 공유기 → go2rtc 컨테이너 | WebRTC 미디어 (Nginx 우회) |
| 80 TCP | HTTP | 공유기 → On-Premise Nginx | HTTPS 리다이렉트 |
| 1984 | HTTP | 내부 전용 | go2rtc API (Nginx 경유) |
| 8086 | HTTP | 내부 전용 | ptz-service (Nginx 경유) |
| 9090 | HTTP | 내부 전용 | Prometheus Web UI |
| 1985 | HTTP | 내부 전용 | go2rtc-exporter 스크랩 엔드포인트 |
| 1986 | HTTP | 내부 전용 | camera-label-exporter 스크랩 |
| 29090 | HTTP | AWS-B | autossh Reverse Tunnel (Prometheus) |
| 3000 | HTTP | AWS-B | Grafana |
| 8085 | HTTP | AWS-A | Spring Boot (docker 프로파일) |

---

## Spring Boot 프로파일

| 프로파일 | 실행 서버 | 활성 컴포넌트 |
|----------|-----------|---------------|
| `local` | 로컬 개발 | ProcessManagerService (go2rtc 바이너리 직접 실행) |
| `docker` | AWS-A | EmbedRedirectController |
| `onprem` | On-Premise | PtzController, PtzService |

---

## 모니터링

Prometheus scrape 대상 (On-Premise):

| 대상 | 주소 | 간격 |
|------|------|------|
| go2rtc-exporter | `go2rtc-exporter:1985` | 5초 |
| node-exporter | `localhost:9100` | 15초 |
| Spring Boot (AWS-A) | `{aws-a-ip}:8085/actuator/prometheus` | 10초 |

Grafana 대시보드: `http://{aws-b-ip}:3000`

---

## 로컬 개발 환경 (로컬 단독)

```bash
# 사전 조건: Java 21, .env 파일

# Spring Boot + go2rtc 자동 시작
./gradlew bootRun

# 카메라 없이 에뮬레이터 40채널 테스트
mediamtx mediamtx.yml       # RTSP 서버
./start-emulators.sh        # FFmpeg 40채널 RTSP 송출
./gradlew bootRun
./stop-emulators.sh         # 종료
```

접속:

| URL | 설명 |
|-----|------|
| `localhost:8085` | 단일 카메라 플레이어 |
| `localhost:8085/embed.html?cam=cam01` | 임베드 뷰어 (PTZ 포함) |
| `localhost:8085/dashboard-real.html` | 다중 카메라 대시보드 |

---

## 문서

| 문서 | 내용 |
|------|------|
| `docs/architecture/REQUEST_FLOW.md` | TCP/UDP 흐름, 포트 매트릭스 상세 |
| `docs/architecture/PRODUCTION_ARCHITECTURE.md` | 프로덕션 아키텍처 설계 배경 |
| `docs/architecture/MONITORING_METRICS.md` | Prometheus 메트릭 목록 (33개) |
| `docs/architecture/AUTOSSH_PROMETHEUS_PLAN.md` | autossh Reverse Tunnel 설정 가이드 |
| `docs/architecture/HIKVISION_AUTH.md` | ONVIF/ISAPI 인증 체계 |
| `docs/TODO.md` | 개발 단계별 할 일 목록 |
