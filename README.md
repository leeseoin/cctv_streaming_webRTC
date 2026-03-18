# cctv webrtc project

## 프로젝트 구조

```
webrtc/
├── go2rtc                          # go2rtc 바이너리
├── go2rtc.yaml                     # go2rtc 설정 (RTSP 스트림)
├── src/main/java/com/cctv/webrtc/
│   ├── config/                     # 설정 (Security, AppProperties)
│   ├── controller/                 # REST API (WebRtcController)
│   └── service/                    # 비즈니스 로직 (Go2RtcService, ProcessManagerService)
├── src/main/resources/
│   ├── application.yml             # Spring 설정
│   └── static/index.html           # WebRTC 플레이어 UI
```
