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

  [카메라 TOP 10 - Daily]
  go2rtc_daily_camera_sessions       - 카메라별 오늘 세션 수
  go2rtc_daily_camera_duration_sec   - 카메라별 오늘 누적 시청시간(초)
  go2rtc_daily_camera_peak_readers   - 카메라별 오늘 최대 동시 시청자

  [IP TOP 10 - Daily]
  go2rtc_daily_ip_sessions           - IP별 오늘 세션 수
  go2rtc_daily_ip_duration_sec       - IP별 오늘 누적 시청시간(초)
  go2rtc_daily_ip_isp                - IP별 통신사/모바일 여부

  [모바일 IP]
  go2rtc_active_mobile_ips           - 현재 접속 중 모바일 IP 수
  go2rtc_daily_mobile_closed_sessions- 오늘 모바일 IP 종료 세션 수
  go2rtc_daily_mobile_ratio          - 오늘 모바일 비율 (%)

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
import threading
from datetime import datetime, timezone, timedelta, date
from prometheus_client import start_http_server, Gauge, Counter

GO2RTC_API = "http://go2rtc:1984"
EXPORTER_PORT = 1985
POLL_INTERVAL = 5  # seconds
KST = timezone(timedelta(hours=9))

# ════════════════════════════════════════
# IP → 모바일 판별 (ip-api.com 조회 + 캐싱)
# ════════════════════════════════════════

ip_info_cache = {}  # ip -> {"isp": str, "mobile": bool, "cached_at": float}
IP_CACHE_TTL = 86400  # 24시간 캐싱
_cache_lock = threading.Lock()


def is_mobile_ip(ip):
    """IP가 모바일(통신사 셀룰러)인지 판별. 캐시 히트 시 즉시 반환."""
    if not ip or ip.startswith("192.168.") or ip.startswith("10.") or ip.startswith("172."):
        return False

    now = time.time()
    with _cache_lock:
        cached = ip_info_cache.get(ip)
        if cached and (now - cached["cached_at"]) < IP_CACHE_TTL:
            return cached["mobile"]

    # 캐시 미스 → 비동기 조회 (collect 블로킹 방지)
    threading.Thread(target=_lookup_ip, args=(ip,), daemon=True).start()
    return False  # 첫 조회 시에는 False 반환, 다음 폴링에 반영


def _lookup_ip(ip):
    """ip-api.com으로 ISP/모바일 조회 후 캐싱."""
    try:
        resp = requests.get(
            f"http://ip-api.com/json/{ip}?fields=status,isp,mobile",
            timeout=5,
        )
        data = resp.json()
        if data.get("status") == "success":
            mobile = data.get("mobile", False)
            isp = data.get("isp", "")
            with _cache_lock:
                ip_info_cache[ip] = {
                    "isp": isp,
                    "mobile": mobile,
                    "cached_at": time.time(),
                }
            print(f"[IP-INFO] {ip} → ISP: {isp}, mobile: {mobile}")
    except Exception as e:
        print(f"[IP-INFO] lookup failed for {ip}: {e}")

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

# 모바일 IP
active_mobile_ips = Gauge("go2rtc_active_mobile_ips", "Currently connected mobile IPs")
daily_mobile_closed = Gauge("go2rtc_daily_mobile_closed_sessions", "Closed sessions from mobile IPs today")
daily_mobile_ratio = Gauge("go2rtc_daily_mobile_ratio", "Mobile IP ratio of closed sessions today (%)")

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

# 카메라 TOP 10
daily_camera_sessions = Gauge("go2rtc_daily_camera_sessions", "Sessions per camera today", ["camera"])
daily_camera_duration = Gauge("go2rtc_daily_camera_duration_sec", "Total viewing duration per camera today (sec)", ["camera"])
daily_camera_peak_readers = Gauge("go2rtc_daily_camera_peak_readers", "Peak concurrent readers per camera today", ["camera"])

# IP TOP 10
daily_ip_sessions = Gauge("go2rtc_daily_ip_sessions", "Sessions per IP today", ["ip"])
daily_ip_duration = Gauge("go2rtc_daily_ip_duration_sec", "Total viewing duration per IP today (sec)", ["ip"])
daily_ip_isp = Gauge("go2rtc_daily_ip_isp", "ISP info per IP (1=has info)", ["ip", "isp", "mobile"])

# ════════════════════════════════════════
# State
# ════════════════════════════════════════

# 활성 세션: "stream:consumer_id" -> {stream, ip, protocol, start_time, user_agent, bytes}
active_sessions = {}
known_ips = set()  # IP 라벨 추적 (비활성 IP를 0으로 세팅하기 위해)

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
    "mobile_closed": 0,
    # 카메라별: {cam01: {"sessions": 0, "duration": 0.0, "peak_readers": 0}}
    "camera_stats": {},
    # IP별: {ip: {"sessions": 0, "duration": 0.0}}
    "ip_stats": {},
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
    daily_state["mobile_closed"] = 0
    daily_state["camera_stats"] = {}
    daily_state["ip_stats"] = {}
    daily_camera_sessions._metrics.clear()
    daily_camera_duration._metrics.clear()
    daily_camera_peak_readers._metrics.clear()
    daily_ip_sessions._metrics.clear()
    daily_ip_duration._metrics.clear()
    daily_ip_isp._metrics.clear()
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
    """remote_addr에서 실제 클라이언트 IP 추출.

    ngrok 경유 시: "162.159.207.0:32339 forwarded 2001:e60:..." → forwarded 뒤 IP 추출
    직접 접속 시:  "192.168.0.104:12345" → 192.168.0.104
    IPv6 직접:    "[::1]:12345" → [::1]
    """
    if not remote_addr:
        return None
    # HLS (ngrok): "x.x.x.x:port forwarded 실제IP" → 실제 IP 추출
    if "forwarded" in remote_addr:
        return remote_addr.split("forwarded")[-1].strip()
    # WebRTC (ngrok): "x.x.x.x:port prflx" → ngrok IP (실제 IP 추출 불가)
    # 직접 접속: "x.x.x.x:port" → 클라이언트 IP
    addr = remote_addr.split(" ")[0]  # 공백 이후 제거 (prflx 등)
    # IPv6: [::1]:port
    if addr.startswith("["):
        return addr.split("]:")[0] + "]"
    # IPv4: 1.2.3.4:port
    parts = addr.rsplit(":", 1)
    return parts[0] if parts else addr


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

        # 모바일 세션 집계
        session_ip = session.get("ip")
        if session_ip and is_mobile_ip(session_ip):
            daily_state["mobile_closed"] += 1

        # 카메라별 집계
        stream = session.get("stream", "unknown")
        cam = daily_state["camera_stats"].setdefault(stream, {"sessions": 0, "duration": 0.0, "peak_readers": 0})
        cam["sessions"] += 1
        cam["duration"] += duration

        # IP별 집계
        if session_ip:
            ip_stat = daily_state["ip_stats"].setdefault(session_ip, {"sessions": 0, "duration": 0.0})
            ip_stat["sessions"] += 1
            ip_stat["duration"] += duration

    # 기존 세션 bytes 업데이트
    for key in curr_keys & prev_keys:
        active_sessions[key]["bytes"] = current_consumers[key]["bytes"]

    # ── 카메라별 peak_readers 갱신 ──
    for stream_name, info in data.items():
        consumers = info.get("consumers") or []
        reader_count = len(consumers)
        if reader_count > 0:
            cam = daily_state["camera_stats"].setdefault(stream_name, {"sessions": 0, "duration": 0.0, "peak_readers": 0})
            if reader_count > cam["peak_readers"]:
                cam["peak_readers"] = reader_count

    # ── 실시간 메트릭 업데이트 ──
    active_ips.set(len(current_ips))
    active_cameras.set(len(current_cameras))

    # 프로토콜별 consumer
    for proto in ["webrtc", "hls", "rtsp", "mse", "other"]:
        consumers_by_protocol.labels(protocol=proto).set(protocol_counts.get(proto, 0))

    # IP별 연결 수 — 활성 IP는 카운트, 사라진 IP는 0
    for ip, count in ip_conn_counts.items():
        ip_connections.labels(ip=ip).set(count)
    for ip in known_ips - set(ip_conn_counts.keys()):
        ip_connections.labels(ip=ip).set(0)
    known_ips.update(ip_conn_counts.keys())

    # 스트림별 bytes
    for stream_name, total in stream_bytes.items():
        consumer_bytes.labels(stream=stream_name).set(total)

    # ── 모바일 IP 실시간 ──
    mobile_count = sum(1 for ip in current_ips if is_mobile_ip(ip))
    active_mobile_ips.set(mobile_count)

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
    daily_mobile_closed.set(daily_state["mobile_closed"])
    if daily_state["closed"] > 0:
        daily_mobile_ratio.set(daily_state["mobile_closed"] / daily_state["closed"] * 100)
    else:
        daily_mobile_ratio.set(0)

    durations = daily_state["durations"]
    if durations:
        daily_avg_duration.set(sum(durations) / len(durations))
        daily_max_duration.set(max(durations))
        daily_min_duration.set(min(durations))
    else:
        daily_avg_duration.set(0)
        daily_max_duration.set(0)
        daily_min_duration.set(0)

    # ── 카메라 TOP 10 ──
    cam_sorted = sorted(daily_state["camera_stats"].items(), key=lambda x: x[1]["sessions"], reverse=True)[:10]
    daily_camera_sessions._metrics.clear()
    daily_camera_duration._metrics.clear()
    daily_camera_peak_readers._metrics.clear()
    for cam_name, stats in cam_sorted:
        daily_camera_sessions.labels(camera=cam_name).set(stats["sessions"])
        daily_camera_duration.labels(camera=cam_name).set(stats["duration"])
        daily_camera_peak_readers.labels(camera=cam_name).set(stats["peak_readers"])

    # ── IP TOP 10 ──
    ip_sorted = sorted(daily_state["ip_stats"].items(), key=lambda x: x[1]["sessions"], reverse=True)[:10]
    daily_ip_sessions._metrics.clear()
    daily_ip_duration._metrics.clear()
    daily_ip_isp._metrics.clear()
    for ip_addr, stats in ip_sorted:
        daily_ip_sessions.labels(ip=ip_addr).set(stats["sessions"])
        daily_ip_duration.labels(ip=ip_addr).set(stats["duration"])
        # ISP 정보 (캐시에 있으면 표시)
        with _cache_lock:
            cached = ip_info_cache.get(ip_addr, {})
        isp = cached.get("isp", "unknown")
        mobile = "Y" if cached.get("mobile", False) else "N"
        daily_ip_isp.labels(ip=ip_addr, isp=isp, mobile=mobile).set(1)


if __name__ == "__main__":
    reset_daily()
    start_http_server(EXPORTER_PORT)
    print(f"go2rtc exporter started on :{EXPORTER_PORT}, polling {GO2RTC_API} every {POLL_INTERVAL}s")
    while True:
        collect()
        time.sleep(POLL_INTERVAL)
