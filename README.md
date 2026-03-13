# CCTV Streamer

RTSP IP 카메라 영상을 WebRTC로 실시간 스트리밍하는 시스템.

---

## 기술 스택

| 구분 | 기술 |
|------|------|
| Backend | Java 21 + Spring Boot 4.0.3 |
| Media Gateway | go2rtc (remux 방식, 트랜스코딩 없음) |
| Protocol | RTSP (카메라) → WebRTC (브라우저) |
| Camera | Hikvision DS-2DE4A225IWG-E |

---

## 현재 구조 (1단계 - 단일 영상 스트리밍)

```
┌─────────┐      RTSP       ┌─────────┐     WebRTC      ┌──────────┐
│  카메라   │ ──────────────→ │  go2rtc  │ ──────────────→ │  브라우저  │
│(Hikvision)│   H.264 영상    │ (remux)  │   H.264 그대로  │          │
└─────────┘                 └─────────┘                 └──────────┘
                                 ↑
                           ┌─────────────┐
                           │ Java (Spring │
                           │    Boot)     │
                           ├─────────────┤
                           │ 시그널링 프록시│ ← SDP offer/answer 전달
                           │ go2rtc 관리  │ ← 프로세스 시작/종료
                           │ 모니터링 API │ ← CPU/메모리 조회
                           └─────────────┘
```

### 동작 흐름

```
1. 브라우저가 Java에 SDP offer 전송    POST /api/cameras/cam01/webrtc
2. Java가 go2rtc에 SDP 전달            POST http://localhost:1984/api/webrtc?src=cam01
3. go2rtc가 SDP answer 응답
4. Java가 브라우저에 SDP answer 반환
5. 브라우저 ↔ go2rtc 직접 WebRTC 연결   (P2P, 영상은 Java를 거치지 않음)
```

### 포트 구조

```
브라우저 ──:8085──→ Java(Spring Boot)
                        │
                        ├──:1984──→ go2rtc API (시그널링)
                        │
go2rtc ──:8555──→ 브라우저 (WebRTC 미디어)
go2rtc ──:8554──→ FFmpeg (녹화용 RTSP 리스트림)
```

---

## 목표 구조 (최종)

```
                                    ┌──[WebRTC]──→ 브라우저 (정상: P2P)
                                    │
┌─────────┐      RTSP       ┌──────┤
│  카메라   │ ──────────────→ │go2rtc├──[HLS]────→ 브라우저 (Failover: WebRTC 실패 시)
│ (N대)    │                 │      │
└─────────┘                 └──────┤
                                    └──[RTSP]───→ FFmpeg (녹화)

                           ┌──────────────────┐
                           │  Java (Spring Boot) │
                           ├──────────────────┤
                           │ 시그널링 프록시     │
                           │ 카메라 CRUD        │ ← go2rtc 런타임 스트림 관리
                           │ 인증/권한          │ ← Spring Security + JWT
                           │ 녹화 관리          │ ← FFmpeg 프로세스 제어
                           │ Failover 제어      │ ← WebRTC 실패 → HLS 전환
                           │ 모니터링           │ ← 시스템 리소스 + WebRTC 통계
                           └──────────────────┘

                           ┌──────────────────┐
                           │  TURN 서버 (coturn) │ ← P2P 실패 시 중계 (선택)
                           └──────────────────┘
```

### 핵심 변경점

| 항목 | 현재 (1단계) | 목표 (최종) |
|------|-------------|------------|
| 카메라 수 | 1대 | N대 (런타임 CRUD) |
| 프로토콜 | WebRTC만 | WebRTC + HLS Failover |
| 인증 | 없음 (전체 허용) | JWT 기반 인증 |
| 녹화 | 없음 | FFmpeg으로 파일 저장 |
| 모니터링 | JVM + go2rtc 기본 | WebRTC 통계 (RTT, 비트레이트) 포함 |
| TURN | 없음 | coturn (Docker, 선택) |

---

## 빠른 시작

### 사전 조건

- Java 21+
- go2rtc 바이너리 (프로젝트 루트에 위치)

### 실행

```bash
cd /Users/iseoin/SpringBoot_project/webrtc
./gradlew bootRun
```

### 접속

| URL | 설명 |
|-----|------|
| `localhost:8085` | 단일 카메라 플레이어 (WebRTC 통계 포함) |
| `localhost:8085/dashboard.html` | 40채널 대시보드 |
| `localhost:8085/monitor.html` | 시스템 모니터링 (CPU/메모리) |

### 에뮬레이터 테스트 (카메라 없이 40채널)

```bash
# 1. mediamtx 실행
mediamtx mediamtx.yml

# 2. 에뮬레이터 40개 시작
./start-emulators.sh

# 3. Spring Boot + go2rtc 실행
./gradlew bootRun

# 종료
./stop-emulators.sh
```

---

## 프로젝트 구조

```
webrtc/
├── go2rtc                          # go2rtc 바이너리
├── go2rtc.yml                      # go2rtc 설정 (카메라 + 에뮬레이터)
├── mediamtx.yml                    # mediamtx 설정 (에뮬레이터 RTSP 서버)
├── start-emulators.sh              # 에뮬레이터 시작
├── stop-emulators.sh               # 에뮬레이터 종료
│
├── src/main/java/com/cctv/webrtc/
│   ├── config/                     # SecurityConfig, AppProperties
│   ├── controller/                 # WebRtcController, MonitorController
│   └── service/                    # Go2RtcService, ProcessManagerService
│
├── src/main/resources/
│   ├── application.yml
│   └── static/                     # index.html, dashboard.html, monitor.html
│
└── docs/                           # 문서 (CLAUDE.md 참조)
```

---

## 문서

상세 문서는 `docs/` 디렉토리 참조. 주요 문서:

- `docs/architecture/CORE_CONCEPTS.md` — 프로토콜, 코덱, Remux 등 핵심 개념
- `docs/architecture/EMULATOR.md` — 에뮬레이터 구성/실행 가이드
- `docs/reports/go2rtc_검증_보고서.md` — go2rtc CRUD, Remux 검증, HLS Failover 분석
- `docs/TODO.md` — 개발 단계별 할 일 목록
