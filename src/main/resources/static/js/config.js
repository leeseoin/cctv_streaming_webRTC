/**
 * config.js — 프론트엔드 환경 설정
 *
 * 프론트/백 분리 시 이 파일만 수정하면 됨
 * - API_BASE: Spring Boot (시그널링, PTZ, NMS) 서버 주소
 * - GO2RTC_BASE: go2rtc HTTPS (영상 HLS/WebRTC) 서버 주소
 */
const CONFIG = {
  API_BASE: "https://iptest.devsp.kr",
  GO2RTC_BASE: "https://stream1.devsp.kr:8443",
};
