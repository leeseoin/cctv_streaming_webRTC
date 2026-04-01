"""
go2rtc Prometheus Exporter (Enhanced)
go2rtc /api/streams 폴링 → 세션 추적 + IP 수집 + 프로토콜 분류 → Prometheus 메트릭

메트릭:
  [기본]
  go2rtc_up                          - go2rtc 정상 여부
  go2rtc_streams_total               - 전체 스트림 수
  go2rtc_stream_producers            - 스트림별 producer 수
  go2rtc_stream_consumers            - 스트림별 consumer 수

  [실시간]
  go2rtc_active_ips                  - 현재 접속 고유 IP 수
  go2rtc_active_cameras              - 시청자 있는 카메라 수
  go2rtc_consumers_by_protocol       - 프로토콜별 현재 consumer 수
  go2rtc_ip_connections              - IP별 현재 연결 수
  go2rtc_consumer_bytes_total        - 스트림별 consumer 전송 바이트 합계

  [세션 추적]
  go2rtc_sessions_closed_total       - 종료된 세션 총 수 (누적)
  go2rtc_sessions_closed_by_protocol - 프로토콜별 종료 세션 (누적)

  [Daily - 자정 리셋]
  go2rtc_daily_closed_sessions       - 오늘 종료 세션 수
  go2rtc_daily_closed_webrtc         - 오늘 종료 WebRTC 세션
  go2rtc_daily_closed_hls            - 오늘 종료 HLS 세션
  go2rtc_daily_closed_rtsp           - 오늘 종료 RTSP 세션
  go2rtc_daily_unique_ips            - 오늘 접속한 고유 IP 수
  go2rtc_daily_peak_sessions         - 오늘 최대 동시 세션
  go2rtc_daily_peak_ips              - 오늘 최대 동시 IP
  go2rtc_daily_peak_cameras          - 오늘 최대 동시 카메라
  go2rtc_daily_total_duration_sec    - 오늘 총 시청 시간(초)
  go2rtc_daily_avg_duration_sec      - 오늘 평균 세션 시간(초)
  go2rtc_daily_max_duration_sec      - 오늘 최장 세션 시간(초)
  go2rtc_daily_min_duration_sec      - 오늘 최단 세션 시간(초)
  go2rtc_daily_total_bytes           - 오늘 총 전송 바이트
"""

import time
import requests
from datetime import datetime, timezone, timedelta, date
from prometheus_client import start_http_server, Gauge, Counter

GO2RTC_API = "http://go2rtc:1984"
EXPORTER_PORT = 1985
POLL_INTERVAL = 5  # seconds
KST = timezone(timedelta(hours=9))

# ════════════════════════════════════════
# Prometheus Metrics
# ════════════════════════════════════════

# 기본
go2rtc_up = Gauge("go2rtc_up", "go2rtc is reachable (1=up, 0=down)")
streams_total = Gauge("go2rtc_streams_total", "Total number of configured streams")
stream_producers = Gauge("go2rtc_stream_producers", "Producers per stream", ["stream"])
stream_consumers = Gauge("go2rtc_stream_consumers", "Consumers per stream", ["stream"])

# 실시간
active_ips = Gauge("go2rtc_active_ips", "Number of unique active client IPs")
active_cameras = Gauge("go2rtc_active_cameras", "Number of streams with at least 1 consumer")
consumers_by_protocol = Gauge("go2rtc_consumers_by_protocol", "Active consumers by protocol", ["protocol"])
ip_connections = Gauge("go2rtc_ip_connections", "Active connections per IP", ["ip"])
consumer_bytes = Gauge("go2rtc_consumer_bytes_total", "Total bytes sent to consumers per stream", ["stream"])

# 세션 추적 (누적 - 프로세스 시작 이후)
sessions_closed_total = Counter("go2rtc_sessions_closed_total", "Total closed sessions since exporter start")
sessions_closed_by_protocol = Counter("go2rtc_sessions_closed_by_protocol_total", "Closed sessions by protocol", ["protocol"])

# Daily (자정 리셋)
daily_closed = Gauge("go2rtc_daily_closed_sessions", "Closed sessions today")
daily_closed_webrtc = Gauge("go2rtc_daily_closed_webrtc", "Closed WebRTC sessions today")
daily_closed_hls = Gauge("go2rtc_daily_closed_hls", "Closed HLS sessions today")
daily_closed_rtsp = Gauge("go2rtc_daily_closed_rtsp", "Closed RTSP sessions today")
daily_unique_ips = Gauge("go2rtc_daily_unique_ips", "Unique IPs today")
daily_peak_sessions = Gauge("go2rtc_daily_peak_sessions", "Peak concurrent sessions today")
daily_peak_ips = Gauge("go2rtc_daily_peak_ips", "Peak concurrent IPs today")
daily_peak_cameras = Gauge("go2rtc_daily_peak_cameras", "Peak concurrent cameras today")
daily_total_duration = Gauge("go2rtc_daily_total_duration_sec", "Total viewing duration today (seconds)")
daily_avg_duration = Gauge("go2rtc_daily_avg_duration_sec", "Average session duration today (seconds)")
daily_max_duration = Gauge("go2rtc_daily_max_duration_sec", "Longest session today (seconds)")
daily_min_duration = Gauge("go2rtc_daily_min_duration_sec", "Shortest session today (seconds)")
daily_total_bytes = Gauge("go2rtc_daily_total_bytes", "Total bytes sent today")

# ════════════════════════════════════════
# State
# ════════════════════════════════════════

# 활성 세션: "stream:consumer_id" -> {stream, ip, protocol, start_time, user_agent, bytes}
active_sessions = {}

# Daily 집계 상태
daily_state = {
    "date": None,
    "closed": 0,
    "closed_webrtc": 0,
    "closed_hls": 0,
    "closed_rtsp": 0,
    "unique_ips": set(),
    "peak_sessions": 0,
    "peak_ips": 0,
    "peak_cameras": 0,
    "total_duration": 0.0,
    "durations": [],
    "total_bytes": 0,
}


def reset_daily():
    """자정에 Daily 상태 초기화."""
    daily_state["date"] = datetime.now(KST).date()
    daily_state["closed"] = 0
    daily_state["closed_webrtc"] = 0
    daily_state["closed_hls"] = 0
    daily_state["closed_rtsp"] = 0
    daily_state["unique_ips"] = set()
    daily_state["peak_sessions"] = 0
    daily_state["peak_ips"] = 0
    daily_state["peak_cameras"] = 0
    daily_state["total_duration"] = 0.0
    daily_state["durations"] = []
    daily_state["total_bytes"] = 0
    print(f"[INFO] Daily stats reset for {daily_state['date']}")


def normalize_protocol(format_name):
    """format_name → 프로토콜 분류."""
    if not format_name:
        return "unknown"
    fn = format_name.lower()
    if "webrtc" in fn:
        return "webrtc"
    elif "hls" in fn or "mpegts" in fn:
        return "hls"
    elif "rtsp" in fn:
        return "rtsp"
    elif "mp4" in fn or "mse" in fn:
        return "mse"
    return "other"


def extract_ip(remote_addr):
    """remote_addr에서 IP 추출 (포트 제거)."""
    if not remote_addr:
        return None
    # IPv6: [::1]:port / IPv4: 1.2.3.4:port
    if remote_addr.startswith("["):
        return remote_addr.split("]:")[0] + "]"
    parts = remote_addr.rsplit(":", 1)
    return parts[0] if parts else remote_addr


def collect():
    now = time.time()
    today = datetime.now(KST).date()

    # 자정 리셋 체크
    if daily_state["date"] != today:
        reset_daily()

    try:
        resp = requests.get(f"{GO2RTC_API}/api/streams", timeout=5)
        resp.raise_for_status()
        data = resp.json()
        go2rtc_up.set(1)
    except Exception as e:
        go2rtc_up.set(0)
        streams_total.set(0)
        print(f"[ERROR] go2rtc poll failed: {e}")
        return

    if not data:
        streams_total.set(0)
        return

    streams_total.set(len(data))

    # ── 현재 상태 수집 ──
    current_consumers = {}  # "stream:id" -> consumer info
    current_ips = set()
    current_cameras = set()
    protocol_counts = {}
    ip_conn_counts = {}
    stream_bytes = {}

    for stream_name, info in data.items():
        # Producers
        producers = info.get("producers") or []
        stream_producers.labels(stream=stream_name).set(len(producers))

        # Consumers
        consumers = info.get("consumers") or []
        stream_consumers.labels(stream=stream_name).set(len(consumers))

        if consumers:
            current_cameras.add(stream_name)
            total_bytes = 0

            for c in consumers:
                cid = c.get("id")
                if cid is None:
                    continue

                key = f"{stream_name}:{cid}"
                ip = extract_ip(c.get("remote_addr"))
                protocol = normalize_protocol(c.get("format_name"))
                bytes_send = c.get("bytes_send", 0)
                total_bytes += bytes_send

                current_consumers[key] = {
                    "stream": stream_name,
                    "ip": ip,
                    "protocol": protocol,
                    "user_agent": c.get("user_agent", ""),
                    "bytes": bytes_send,
                }

                if ip:
                    current_ips.add(ip)
                    daily_state["unique_ips"].add(ip)
                    ip_conn_counts[ip] = ip_conn_counts.get(ip, 0) + 1

                protocol_counts[protocol] = protocol_counts.get(protocol, 0) + 1

            stream_bytes[stream_name] = total_bytes

    # ── 세션 변화 감지 ──
    prev_keys = set(active_sessions.keys())
    curr_keys = set(current_consumers.keys())

    # 새 세션
    for key in curr_keys - prev_keys:
        active_sessions[key] = {
            **current_consumers[key],
            "start_time": now,
        }

    # 종료 세션
    for key in prev_keys - curr_keys:
        session = active_sessions.pop(key)
        duration = now - session.get("start_time", now)
        protocol = session.get("protocol", "unknown")
        bytes_sent = session.get("bytes", 0)

        # 누적 카운터
        sessions_closed_total.inc()
        sessions_closed_by_protocol.labels(protocol=protocol).inc()

        # Daily 집계
        daily_state["closed"] += 1
        daily_state["total_duration"] += duration
        daily_state["durations"].append(duration)
        daily_state["total_bytes"] += bytes_sent

        if protocol == "webrtc":
            daily_state["closed_webrtc"] += 1
        elif protocol == "hls":
            daily_state["closed_hls"] += 1
        elif protocol == "rtsp":
            daily_state["closed_rtsp"] += 1

    # 기존 세션 bytes 업데이트
    for key in curr_keys & prev_keys:
        active_sessions[key]["bytes"] = current_consumers[key]["bytes"]

    # ── 실시간 메트릭 업데이트 ──
    active_ips.set(len(current_ips))
    active_cameras.set(len(current_cameras))

    # 프로토콜별 consumer
    for proto in ["webrtc", "hls", "rtsp", "mse", "other"]:
        consumers_by_protocol.labels(protocol=proto).set(protocol_counts.get(proto, 0))

    # IP별 연결 수 (기존 라벨 초기화 후 재설정)
    # Note: Prometheus client doesn't support removing labels easily,
    # so we track known IPs
    for ip, count in ip_conn_counts.items():
        ip_connections.labels(ip=ip).set(count)

    # 스트림별 bytes
    for stream_name, total in stream_bytes.items():
        consumer_bytes.labels(stream=stream_name).set(total)

    # ── Daily 피크 업데이트 ──
    concurrent_sessions = len(current_consumers)
    concurrent_ips = len(current_ips)
    concurrent_cameras = len(current_cameras)

    if concurrent_sessions > daily_state["peak_sessions"]:
        daily_state["peak_sessions"] = concurrent_sessions
    if concurrent_ips > daily_state["peak_ips"]:
        daily_state["peak_ips"] = concurrent_ips
    if concurrent_cameras > daily_state["peak_cameras"]:
        daily_state["peak_cameras"] = concurrent_cameras

    # ── Daily 메트릭 노출 ──
    daily_closed.set(daily_state["closed"])
    daily_closed_webrtc.set(daily_state["closed_webrtc"])
    daily_closed_hls.set(daily_state["closed_hls"])
    daily_closed_rtsp.set(daily_state["closed_rtsp"])
    daily_unique_ips.set(len(daily_state["unique_ips"]))
    daily_peak_sessions.set(daily_state["peak_sessions"])
    daily_peak_ips.set(daily_state["peak_ips"])
    daily_peak_cameras.set(daily_state["peak_cameras"])
    daily_total_duration.set(daily_state["total_duration"])
    daily_total_bytes.set(daily_state["total_bytes"])

    durations = daily_state["durations"]
    if durations:
        daily_avg_duration.set(sum(durations) / len(durations))
        daily_max_duration.set(max(durations))
        daily_min_duration.set(min(durations))
    else:
        daily_avg_duration.set(0)
        daily_max_duration.set(0)
        daily_min_duration.set(0)


if __name__ == "__main__":
    reset_daily()
    start_http_server(EXPORTER_PORT)
    print(f"go2rtc exporter started on :{EXPORTER_PORT}, polling {GO2RTC_API} every {POLL_INTERVAL}s")
    while True:
        collect()
        time.sleep(POLL_INTERVAL)
