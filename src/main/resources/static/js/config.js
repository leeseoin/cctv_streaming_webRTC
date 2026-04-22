/**
 * config.js — 프론트엔드 환경 설정
 *
 * - API_BASE: Spring Boot (시그널링, PTZ, NMS) 서버 주소
 * - GO2RTC_BASE: go2rtc HTTPS (영상 HLS/WebRTC) 서버 주소
 *
 * embed.html은 On-Premise(stream1)에서 서빙되어 same-origin으로 동작.
 * 그 외 페이지(dashboard 등)는 AWS-A(iptest)에서 서빙.
 */
const ONPREM_BASE = "https://stream1.flexformular.com:8443";
const AWS_BASE = "https://iptest.devsp.kr";

const CONFIG = {
  API_BASE: location.origin === ONPREM_BASE ? ONPREM_BASE : AWS_BASE,
  GO2RTC_BASE: ONPREM_BASE,
};
