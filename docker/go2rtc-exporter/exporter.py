"""
go2rtc Prometheus Exporter (Enhanced)
go2rtc /api/streams 폴링 → 세션 추적 + IP 수집 + 프로토콜 분류 → Prometheus 메트릭

총 33개 메트릭. 상세 명세: docs/architecture/MONITORING_METRICS_SPEC.md

메트릭 목록:
  [기본 4개]
  #1  go2rtc_up                          - go2rtc 정상 여부 (1=정상, 0=응답 없음)
  #2  go2rtc_streams_total               - go2rtc.yml에 등록된 전체 스트림(카메라) 수
  #3  go2rtc_stream_producers            - 스트림별 producer(RTSP 소스 연결) 수
  #4  go2rtc_stream_consumers            - 스트림별 consumer(시청자) 수

  [실시간 5개 - 매 폴링(5초)마다 현재 상태 스냅샷]
  #5  go2rtc_active_ips                  - 현재 접속 중 고유 IP 수 (같은 IP 여러 세션이면 1로 카운트)
  #6  go2rtc_active_cameras              - 시청자가 1명 이상인 카메라 수
  #7  go2rtc_consumers_by_protocol       - 프로토콜별(webrtc/hls/rtsp/mse) 현재 consumer 수
  #8  go2rtc_ip_connections              - IP별 현재 동시 연결 수 (대시보드 20대면 한 IP가 20)
  #9  go2rtc_consumer_bytes_total        - 스트림별 consumer 전송 바이트 합계 (시청 중 증가)

  [누적 카운터 2개 - 프로세스 재시작 시 0, 자정 리셋 안 됨]
  #10 go2rtc_sessions_closed_total       - 종료된 세션 총 수 (누적, 세션 종료 시 +1)
  #11 go2rtc_sessions_closed_by_protocol - 프로토콜별 종료 세션 수 (누적)

  [모바일 IP 3개]
  #12 go2rtc_active_mobile_ips           - 현재 접속 중 모바일(LTE/5G) IP 수 (ip-api.com 캐시)
  #13 go2rtc_daily_mobile_closed_sessions- 오늘 종료된 모바일 IP 세션 수 (세션 단위, 사람 수 아님)
  #14 go2rtc_daily_mobile_ratio          - 오늘 모바일 비율 (%) = mobile_closed / closed × 100

  [Daily 13개 - 자정 KST 00:00 리셋]
  #15 go2rtc_daily_closed_sessions       - 오늘 종료된 세션 수
  #16 go2rtc_daily_closed_webrtc         - 오늘 종료된 WebRTC 세션 수
  #17 go2rtc_daily_closed_hls            - 오늘 종료된 HLS 세션 수
  #18 go2rtc_daily_closed_rtsp           - 오늘 종료된 RTSP 세션 수
  #19 go2rtc_daily_unique_ips            - 오늘 접속한 고유 IP 수 (시청 시작 시점에 추가, 재방문 +1 안 됨)
  #20 go2rtc_daily_peak_sessions         - 오늘 최대 동시 세션 수 (매 폴링마다 max 갱신)
  #21 go2rtc_daily_peak_ips              - 오늘 최대 동시 IP 수
  #22 go2rtc_daily_peak_cameras          - 오늘 최대 동시 카메라 수
  #23 go2rtc_daily_total_duration_sec    - 오늘 종료 세션 총 시청 시간(초) 합계
  #24 go2rtc_daily_avg_duration_sec      - 오늘 종료 세션 평균 시청 시간(초) = sum / count
  #25 go2rtc_daily_max_duration_sec      - 오늘 종료 세션 중 최장 시간(초)
  #26 go2rtc_daily_min_duration_sec      - 오늘 종료 세션 중 최단 시간(초)
  #27 go2rtc_daily_total_bytes           - 오늘 종료 세션 총 전송 바이트

  [카메라 TOP 10 3개 - sessions 기준 상위 10개만 노출]
  #28 go2rtc_daily_camera_sessions       - 카메라별 오늘 종료 세션 수
  #29 go2rtc_daily_camera_duration_sec   - 카메라별 오늘 누적 시청시간(초)
  #30 go2rtc_daily_camera_peak_readers   - 카메라별 오늘 최대 동시 시청자 (시청 중 갱신)

  [IP TOP 100 3개 - sessions 기준 상위 100개만 노출]
  #31 go2rtc_daily_ip_sessions           - IP별 오늘 종료 세션 수
  #32 go2rtc_daily_ip_duration_sec       - IP별 오늘 누적 시청시간(초)
  #33 go2rtc_daily_ip_isp                - IP별 통신사/모바일 여부 (라벨 노출용, 값은 항상 1)
"""

import re
import json
import time
import requests
import threading
from datetime import datetime, timezone, timedelta
from prometheus_client import start_http_server, Gauge, Counter

GO2RTC_API = "http://go2rtc:1984"
EXPORTER_PORT = 1985
POLL_INTERVAL = 5  # 폴링 간격(초). go2rtc /api/streams를 이 간격으로 조회
KST = timezone(timedelta(hours=9))

# ════════════════════════════════════════
# IP → 모바일 판별 (ip-api.com 조회 + 캐싱)
# 사용처: #12 active_mobile_ips, #13 daily_mobile_closed, #14 daily_mobile_ratio
# ════════════════════════════════════════

ip_info_cache = {}  # ip -> {"isp": str, "mobile": bool, "cached_at": float}
IP_CACHE_TTL = 86400  # 24시간 캐싱 (같은 IP는 하루 1번만 ip-api.com 호출)
_cache_lock = threading.Lock()


def is_private_ip(ip):
    """사설 IP / Docker IP 판별. 사설 IP는 모바일 판별에서 무조건 false 처리."""
    if not ip:
        return True
    return (ip.startswith("192.168.") or ip.startswith("10.") or
            ip.startswith("172.") or ip.startswith("127.") or ip == "localhost")


def is_mobile_ip(ip):
    """IP가 모바일(통신사 셀룰러)인지 판별.
    - 사설 IP → 무조건 False
    - 캐시 히트 → 즉시 반환
    - 캐시 미스 → 비동기로 ip-api.com 조회 시작, 이번 폴링은 False 반환, 다음 폴링부터 정확한 값
    """
    if not ip or is_private_ip(ip):
        return False

    now = time.time()
    with _cache_lock:
        cached = ip_info_cache.get(ip)
        if cached and (now - cached["cached_at"]) < IP_CACHE_TTL:
            return cached["mobile"]

    threading.Thread(target=_lookup_ip, args=(ip,), daemon=True).start()
    return False


def _lookup_ip(ip):
    """ip-api.com으로 ISP/모바일 조회 후 캐싱. (비동기 호출)
    무료 요금제 한도: 분당 45회. 24시간 캐시로 회피.
    """
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
# Prometheus 메트릭 정의 (총 33개)
# ════════════════════════════════════════

# ── 기본 (4개) ──────────────────────────
# 시청 여부와 무관하게 항상 노출되는 go2rtc 상태 정보
go2rtc_up = Gauge("go2rtc_up", "go2rtc is reachable (1=up, 0=down)")                      # #1
streams_total = Gauge("go2rtc_streams_total", "Total number of configured streams")         # #2
stream_producers = Gauge("go2rtc_stream_producers", "Producers per stream", ["stream"])     # #3
stream_consumers = Gauge("go2rtc_stream_consumers", "Consumers per stream", ["stream"])     # #4

# ── 실시간 (5개) ────────────────────────
# 매 폴링(5초)마다 현재 상태를 스냅샷. 시청 중에만 값 있음, 종료 시 0.
active_ips = Gauge("go2rtc_active_ips", "Number of unique active client IPs")               # #5
active_cameras = Gauge("go2rtc_active_cameras", "Number of streams with at least 1 consumer") # #6
consumers_by_protocol = Gauge("go2rtc_consumers_by_protocol", "Active consumers by protocol", ["protocol"]) # #7
ip_connections = Gauge("go2rtc_ip_connections", "Active connections per IP", ["ip"])         # #8  종료 후 라벨 남고 값 0
consumer_bytes = Gauge("go2rtc_consumer_bytes_total", "Total bytes sent to consumers per stream", ["stream"]) # #9

# ── 누적 카운터 (2개) ──────────────────
# 세션 종료 시점에만 +1. 프로세스 재시작 시 0. 자정 리셋 안 됨.
sessions_closed_total = Counter("go2rtc_sessions_closed_total", "Total closed sessions since exporter start") # #10
sessions_closed_by_protocol = Counter("go2rtc_sessions_closed_by_protocol_total", "Closed sessions by protocol", ["protocol"]) # #11

# ── 모바일 IP (3개) ────────────────────
# is_mobile_ip()로 판별. 사설 IP는 항상 false.
active_mobile_ips = Gauge("go2rtc_active_mobile_ips", "Currently connected mobile IPs")     # #12  시청 중에만 값
daily_mobile_closed = Gauge("go2rtc_daily_mobile_closed_sessions", "Closed sessions from mobile IPs today") # #13  종료 시 +1
daily_mobile_ratio = Gauge("go2rtc_daily_mobile_ratio", "Mobile IP ratio of closed sessions today (%)") # #14  = #13 / #15 × 100

# ── Daily (13개) ───────────────────────
# 자정 KST 00:00에 전부 0으로 리셋. 세션 종료 시점에만 +1 (peak/unique 제외).
daily_closed = Gauge("go2rtc_daily_closed_sessions", "Closed sessions today")               # #15  종료 시 +1
daily_closed_webrtc = Gauge("go2rtc_daily_closed_webrtc", "Closed WebRTC sessions today")   # #16  protocol="webrtc"면 +1
daily_closed_hls = Gauge("go2rtc_daily_closed_hls", "Closed HLS sessions today")            # #17  protocol="hls"면 +1
daily_closed_rtsp = Gauge("go2rtc_daily_closed_rtsp", "Closed RTSP sessions today")         # #18  protocol="rtsp"면 +1
daily_unique_ips = Gauge("go2rtc_daily_unique_ips", "Unique IPs today")                     # #19  시청 시작 시 IP set에 추가, 중복 무시
daily_peak_sessions = Gauge("go2rtc_daily_peak_sessions", "Peak concurrent sessions today") # #20  매 폴링마다 max(active 세션 수) 갱신
daily_peak_ips = Gauge("go2rtc_daily_peak_ips", "Peak concurrent IPs today")                # #21  매 폴링마다 max(active IP 수) 갱신
daily_peak_cameras = Gauge("go2rtc_daily_peak_cameras", "Peak concurrent cameras today")    # #22  매 폴링마다 max(active 카메라 수) 갱신
daily_total_duration = Gauge("go2rtc_daily_total_duration_sec", "Total viewing duration today (seconds)") # #23  종료 시 += duration
daily_avg_duration = Gauge("go2rtc_daily_avg_duration_sec", "Average session duration today (seconds)") # #24  = sum(durations) / count(durations)
daily_max_duration = Gauge("go2rtc_daily_max_duration_sec", "Longest session today (seconds)") # #25  = max(durations)
daily_min_duration = Gauge("go2rtc_daily_min_duration_sec", "Shortest session today (seconds)") # #26  = min(durations)
daily_total_bytes = Gauge("go2rtc_daily_total_bytes", "Total bytes sent today")             # #27  종료 시 += bytes_send

# ── 카메라 TOP 10 (3개) ────────────────
# sessions 기준 상위 10개 카메라만 노출. 라벨에 sessions/duration/peak_readers 통합.
# Grafana 테이블에서 1개 쿼리로 camera/sessions/duration/peak_readers 한 줄에 표시 가능.
_camera_labels = ["camera", "sessions", "duration", "peak_readers"]
daily_camera_sessions = Gauge("go2rtc_daily_camera_sessions", "Sessions per camera today", _camera_labels) # #28  종료 시 해당 카메라 +1
daily_camera_duration = Gauge("go2rtc_daily_camera_duration_sec", "Total viewing duration per camera today (sec)", _camera_labels) # #29  종료 시 += duration
daily_camera_peak_readers = Gauge("go2rtc_daily_camera_peak_readers", "Peak concurrent readers per camera today", _camera_labels) # #30  시청 중 max(동시 시청자) 갱신

# ── IP TOP 100 (3개) ───────────────────
# sessions 기준 상위 100개 IP만 노출. 라벨: ip, isp, mobile, sessions, duration
_ip_labels = ["ip", "isp", "mobile", "sessions", "duration"]
daily_ip_sessions = Gauge("go2rtc_daily_ip_sessions", "Sessions per IP today", _ip_labels) # #31  종료 시 해당 IP +1
daily_ip_duration = Gauge("go2rtc_daily_ip_duration_sec", "Total viewing duration per IP today (sec)", _ip_labels) # #32  종료 시 += duration
daily_ip_isp = Gauge("go2rtc_daily_ip_isp", "ISP info per IP (1=has info)", _ip_labels)   # #33  라벨 노출용, 값은 항상 1

# ════════════════════════════════════════
# 내부 상태 (State)
# ════════════════════════════════════════

# 활성 세션 딕셔너리: "stream_name:consumer_id" → {stream, ip, protocol, start_time, user_agent, bytes}
# 이전 폴링과 비교해서 새로 생긴 키 = 새 세션, 사라진 키 = 종료 세션
active_sessions = {}

# IP 라벨 추적: 한번이라도 잡힌 IP를 기록해서, 비활성 IP의 ip_connections 라벨을 0으로 세팅
known_ips = set()

# Daily 집계 상태: 자정에 reset_daily()로 초기화
daily_state = {
    "date": None,             # 오늘 날짜 (date 객체). 날짜 바뀌면 reset_daily() 트리거
    "closed": 0,              # #15 daily_closed_sessions 의 소스
    "closed_webrtc": 0,       # #16 daily_closed_webrtc 의 소스
    "closed_hls": 0,          # #17 daily_closed_hls 의 소스
    "closed_rtsp": 0,         # #18 daily_closed_rtsp 의 소스
    "unique_ips": set(),       # #19 daily_unique_ips 의 소스 (IP set, 중복 무시)
    "peak_sessions": 0,       # #20 daily_peak_sessions 의 소스
    "peak_ips": 0,            # #21 daily_peak_ips 의 소스
    "peak_cameras": 0,        # #22 daily_peak_cameras 의 소스
    "total_duration": 0.0,    # #23 daily_total_duration 의 소스
    "durations": [],          # #24~#26 avg/max/min 계산용 리스트
    "total_bytes": 0,         # #27 daily_total_bytes 의 소스
    "mobile_closed": 0,       # #13 daily_mobile_closed 의 소스
    # 카메라별 통계: {cam01: {"sessions": 0, "duration": 0.0, "peak_readers": 0}}
    # → #28 camera_sessions, #29 camera_duration, #30 camera_peak_readers
    "camera_stats": {},
    # IP별 통계: {ip: {"sessions": 0, "duration": 0.0}}
    # → #31 ip_sessions, #32 ip_duration, #33 ip_isp
    "ip_stats": {},
}


def reset_daily():
    """자정(KST 00:00)에 Daily 상태 전체 초기화.
    #13~#33 메트릭이 모두 0으로 리셋됨.
    Prometheus 라벨 히스토리도 clear해서 어제 데이터가 오늘에 남지 않도록 함.
    """
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
    # Prometheus 라벨 히스토리 초기화 (어제 카메라/IP 라벨이 남지 않도록)
    daily_camera_sessions._metrics.clear()   # #28
    daily_camera_duration._metrics.clear()   # #29
    daily_camera_peak_readers._metrics.clear() # #30
    daily_ip_sessions._metrics.clear()       # #31
    daily_ip_duration._metrics.clear()       # #32
    daily_ip_isp._metrics.clear()            # #33
    print(f"[INFO] Daily stats reset for {daily_state['date']}")


def normalize_protocol(format_name):
    """go2rtc consumer의 format_name을 표준 프로토콜명으로 변환.
    사용처: #7 consumers_by_protocol, #11 sessions_closed_by_protocol, #16~#18 daily_closed_webrtc/hls/rtsp
    """
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
    """go2rtc consumer의 remote_addr 필드에서 실제 클라이언트 IP만 추출.
    사용처: #5 active_ips, #8 ip_connections, #19 unique_ips, #31~#33 IP TOP

    ngrok 경유 시: "162.159.207.0:32339 forwarded 2001:e60:..." → forwarded 뒤 실제 IP 추출
    직접 접속 시:  "192.168.0.104:12345" → 192.168.0.104
    IPv6 직접:    "[::1]:12345" → [::1]
    """
    if not remote_addr:
        return None
    if "forwarded" in remote_addr:
        return remote_addr.split("forwarded")[-1].strip()
    addr = remote_addr.split(" ")[0]
    if addr.startswith("["):
        return addr.split("]:")[0] + "]"
    parts = addr.rsplit(":", 1)
    return parts[0] if parts else addr


def collect():
    """메인 수집 함수. POLL_INTERVAL(5초)마다 호출.

    처리 순서:
    1) 자정 리셋 체크
    2) go2rtc API 폴링 → 현재 consumer 목록 수집
    3) 세션 변화 감지 (새 세션 / 종료 세션)
    4) 종료 세션 → 누적 카운터 + Daily 카운터 + 카메라별/IP별 집계
    5) 실시간 메트릭 갱신 (#1~#9, #12)
    6) Daily 피크 갱신 (#20~#22)
    7) Daily 메트릭 노출 (#13~#27)
    8) 카메라 TOP 10 노출 (#28~#30)
    9) IP TOP 100 노출 (#31~#33)
    """
    now = time.time()
    today = datetime.now(KST).date()

    # ─── 1) 자정 리셋 체크 (비활성화) ───
    # 자정 자동 리셋 끔. 수동 리셋 필요 시 exporter 컨테이너 재시작.
    # if daily_state["date"] != today:
    #     reset_daily()

    # ─── 2) go2rtc API 폴링 ───
    # #1 go2rtc_up: 응답 성공이면 1, 실패면 0
    try:
        resp = requests.get(f"{GO2RTC_API}/api/streams", timeout=5)
        resp.raise_for_status()
        # go2rtc가 간헐적으로 ***N 같은 비표준 값을 JSON에 포함시킴 → 0으로 치환 후 파싱
        text = re.sub(r'\*+\w*', '0', resp.text)
        data = json.loads(text)
        go2rtc_up.set(1)  # #1 go2rtc_up = 1
    except Exception as e:
        go2rtc_up.set(0)  # #1 go2rtc_up = 0
        streams_total.set(0)
        print(f"[ERROR] go2rtc poll failed: {e}")
        return

    if not data:
        streams_total.set(0)  # #2 go2rtc_streams_total = 0
        return

    # #2 go2rtc_streams_total: go2rtc.yml에 등록된 전체 스트림 수
    streams_total.set(len(data))

    # ─── 현재 상태 수집 (이번 폴링의 스냅샷) ───
    current_consumers = {}   # "stream_name:consumer_id" → consumer info
    current_ips = set()      # 현재 접속 중 고유 IP들
    current_cameras = set()  # 현재 시청 중 카메라들
    protocol_counts = {}     # protocol → 활성 consumer 수
    ip_conn_counts = {}      # ip → 동시 연결 수
    stream_bytes = {}        # stream_name → bytes_send 합계

    for stream_name, info in data.items():
        # #3 go2rtc_stream_producers: 각 스트림의 producer(RTSP 소스) 수
        producers = info.get("producers") or []
        stream_producers.labels(stream=stream_name).set(len(producers))

        # #4 go2rtc_stream_consumers: 각 스트림의 consumer(시청자) 수
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
                    # #19 daily_unique_ips: 시청 시작 시점에 IP set에 추가 (중복 무시)
                    daily_state["unique_ips"].add(ip)
                    # #8 ip_connections 계산용: IP별 동시 consumer 수 누적
                    ip_conn_counts[ip] = ip_conn_counts.get(ip, 0) + 1

                # #7 consumers_by_protocol 계산용: 프로토콜별 consumer 수 누적
                protocol_counts[protocol] = protocol_counts.get(protocol, 0) + 1

            stream_bytes[stream_name] = total_bytes

    # ─── 3) 세션 변화 감지 ───
    # 이전 폴링의 active_sessions와 이번 폴링의 current_consumers를 비교
    prev_keys = set(active_sessions.keys())
    curr_keys = set(current_consumers.keys())

    # 새 세션: 이번에 처음 등장한 consumer
    for key in curr_keys - prev_keys:
        active_sessions[key] = {
            **current_consumers[key],
            "start_time": now,  # 세션 시작 시각 기록 (duration 계산용)
        }

    # ─── 4) 종료 세션 처리 ───
    # 이전에 있었는데 이번에 없는 consumer = 종료된 세션
    # → 이 시점에서만 Daily 카운터/누적 카운터가 +1 됨
    for key in prev_keys - curr_keys:
        session = active_sessions.pop(key)
        duration = now - session.get("start_time", now)  # 시청 시간(초)
        protocol = session.get("protocol", "unknown")
        bytes_sent = session.get("bytes", 0)

        # #10 sessions_closed_total: 종료 세션 누적 카운터 +1
        sessions_closed_total.inc()
        # #11 sessions_closed_by_protocol: 해당 프로토콜 라벨 +1
        sessions_closed_by_protocol.labels(protocol=protocol).inc()

        # Daily 집계 (#15~#18, #23, #27)
        daily_state["closed"] += 1                 # #15 daily_closed_sessions 소스
        daily_state["total_duration"] += duration   # #23 daily_total_duration 소스
        daily_state["durations"].append(duration)   # #24~#26 avg/max/min 계산용
        daily_state["total_bytes"] += bytes_sent    # #27 daily_total_bytes 소스

        # #16~#18 프로토콜별 daily 종료 세션 카운트
        if protocol == "webrtc":
            daily_state["closed_webrtc"] += 1      # #16
        elif protocol == "hls":
            daily_state["closed_hls"] += 1         # #17
        elif protocol == "rtsp":
            daily_state["closed_rtsp"] += 1        # #18

        # #13 daily_mobile_closed: 모바일 IP 종료 세션이면 +1
        session_ip = session.get("ip")
        if session_ip and is_mobile_ip(session_ip):
            daily_state["mobile_closed"] += 1

        # #28~#29 카메라별 집계: 종료 세션의 stream에 대해 sessions +1, duration += 시청시간
        stream = session.get("stream", "unknown")
        cam = daily_state["camera_stats"].setdefault(stream, {"sessions": 0, "duration": 0.0, "peak_readers": 0})
        cam["sessions"] += 1     # #28 daily_camera_sessions 소스
        cam["duration"] += duration  # #29 daily_camera_duration 소스

        # #31~#32 IP별 집계: 종료 세션의 IP에 대해 sessions +1, duration += 시청시간
        if session_ip:
            ip_stat = daily_state["ip_stats"].setdefault(session_ip, {"sessions": 0, "duration": 0.0})
            ip_stat["sessions"] += 1     # #31 daily_ip_sessions 소스
            ip_stat["duration"] += duration  # #32 daily_ip_duration 소스

    # 기존 세션 bytes 업데이트 (시청 중인 세션의 최신 bytes_send 반영)
    for key in curr_keys & prev_keys:
        active_sessions[key]["bytes"] = current_consumers[key]["bytes"]

    # #30 카메라별 peak_readers 갱신: 시청 중에 동시 시청자가 최고치 넘으면 갱신
    for stream_name, info in data.items():
        consumers = info.get("consumers") or []
        reader_count = len(consumers)
        if reader_count > 0:
            cam = daily_state["camera_stats"].setdefault(stream_name, {"sessions": 0, "duration": 0.0, "peak_readers": 0})
            if reader_count > cam["peak_readers"]:
                cam["peak_readers"] = reader_count

    # ─── 5) 실시간 메트릭 갱신 ───

    # #5 go2rtc_active_ips: 현재 접속 중 고유 IP 수 (IP 중복 제거)
    active_ips.set(len(current_ips))

    # #6 go2rtc_active_cameras: 시청자 ≥ 1인 카메라 수
    active_cameras.set(len(current_cameras))

    # #7 go2rtc_consumers_by_protocol: 프로토콜별 활성 consumer 수
    for proto in ["webrtc", "hls", "rtsp", "mse", "other"]:
        consumers_by_protocol.labels(protocol=proto).set(protocol_counts.get(proto, 0))

    # #8 go2rtc_ip_connections: IP별 동시 연결 수
    # 활성 IP → 현재 카운트, 사라진 IP → 라벨 유지하되 값 0
    for ip, count in ip_conn_counts.items():
        ip_connections.labels(ip=ip).set(count)
    for ip in known_ips - set(ip_conn_counts.keys()):
        ip_connections.labels(ip=ip).set(0)
    known_ips.update(ip_conn_counts.keys())

    # #9 go2rtc_consumer_bytes_total: 스트림별 전송 바이트 합계
    for stream_name, total in stream_bytes.items():
        consumer_bytes.labels(stream=stream_name).set(total)

    # #12 go2rtc_active_mobile_ips: 현재 접속 중 모바일 IP 수
    mobile_count = sum(1 for ip in current_ips if is_mobile_ip(ip))
    active_mobile_ips.set(mobile_count)

    # ─── 6) Daily 피크 갱신 (#20~#22) ───
    # 매 폴링마다 현재 동시 세션/IP/카메라 수를 기존 최고치와 비교
    concurrent_sessions = len(current_consumers)
    concurrent_ips = len(current_ips)
    concurrent_cameras = len(current_cameras)

    if concurrent_sessions > daily_state["peak_sessions"]:
        daily_state["peak_sessions"] = concurrent_sessions  # #20
    if concurrent_ips > daily_state["peak_ips"]:
        daily_state["peak_ips"] = concurrent_ips            # #21
    if concurrent_cameras > daily_state["peak_cameras"]:
        daily_state["peak_cameras"] = concurrent_cameras    # #22

    # ─── 7) Daily 메트릭 Prometheus 노출 (#13~#27) ───
    daily_closed.set(daily_state["closed"])                  # #15
    daily_closed_webrtc.set(daily_state["closed_webrtc"])    # #16
    daily_closed_hls.set(daily_state["closed_hls"])          # #17
    daily_closed_rtsp.set(daily_state["closed_rtsp"])        # #18
    daily_unique_ips.set(len(daily_state["unique_ips"]))     # #19
    daily_peak_sessions.set(daily_state["peak_sessions"])    # #20
    daily_peak_ips.set(daily_state["peak_ips"])              # #21
    daily_peak_cameras.set(daily_state["peak_cameras"])      # #22
    daily_total_duration.set(daily_state["total_duration"])   # #23
    daily_total_bytes.set(daily_state["total_bytes"])         # #27
    daily_mobile_closed.set(daily_state["mobile_closed"])    # #13

    # #14 daily_mobile_ratio: 모바일 종료 세션 / 전체 종료 세션 × 100
    # 주의: "세션 비율"이지 "사람 비율"이 아님.
    # 예: PC 20세션 + 폰 2세션 = 22세션 → ratio = 2/22 × 100 ≈ 9.09%
    if daily_state["closed"] > 0:
        daily_mobile_ratio.set(daily_state["mobile_closed"] / daily_state["closed"] * 100)
    else:
        daily_mobile_ratio.set(0)

    # #24~#26 시청 시간 통계
    durations = daily_state["durations"]
    if durations:
        daily_avg_duration.set(sum(durations) / len(durations))  # #24 평균 = sum / count
        daily_max_duration.set(max(durations))                    # #25 최장
        daily_min_duration.set(min(durations))                    # #26 최단
    else:
        daily_avg_duration.set(0)   # #24
        daily_max_duration.set(0)   # #25
        daily_min_duration.set(0)   # #26

    # ─── 8) 카메라 TOP 10 노출 (#28~#30) ───
    # sessions 기준 상위 10개만 Prometheus에 노출. 나머지는 안 보임.
    # 라벨에 sessions/duration/peak_readers 통합 → Grafana 테이블 1쿼리로 전체 표시.
    cam_sorted = sorted(daily_state["camera_stats"].items(), key=lambda x: x[1]["sessions"], reverse=True)[:50]
    daily_camera_sessions._metrics.clear()      # 이전 폴링 라벨 정리
    daily_camera_duration._metrics.clear()
    daily_camera_peak_readers._metrics.clear()
    for cam_name, stats in cam_sorted:
        sessions_str = str(stats["sessions"])
        duration_str = str(int(stats["duration"]))
        peak_str = str(stats["peak_readers"])
        common = dict(camera=cam_name, sessions=sessions_str, duration=duration_str, peak_readers=peak_str)
        daily_camera_sessions.labels(**common).set(stats["sessions"])       # #28
        daily_camera_duration.labels(**common).set(stats["duration"])        # #29
        daily_camera_peak_readers.labels(**common).set(stats["peak_readers"]) # #30

    # ─── 9) IP TOP 100 노출 (#31~#33) ───
    # sessions 기준 상위 100개만 Prometheus에 노출.
    # 라벨: ip, isp(통신사), mobile(Y/N/""), sessions(현재 누적 문자열), duration(현재 누적 문자열)
    ip_sorted = sorted(daily_state["ip_stats"].items(), key=lambda x: x[1]["sessions"], reverse=True)[:100]
    daily_ip_sessions._metrics.clear()  # 이전 폴링 라벨 정리
    daily_ip_duration._metrics.clear()
    daily_ip_isp._metrics.clear()
    for ip_addr, stats in ip_sorted:
        # ip-api.com 캐시에서 ISP/모바일 정보 조회
        with _cache_lock:
            cached = ip_info_cache.get(ip_addr, {})
        isp = cached.get("isp", "")
        mobile = "Y" if cached.get("mobile", False) else "N" if cached else ""
        sessions_str = str(stats["sessions"])
        duration_str = str(int(stats["duration"]))

        common = dict(ip=ip_addr, isp=isp, mobile=mobile, sessions=sessions_str, duration=duration_str)
        daily_ip_sessions.labels(**common).set(stats["sessions"])   # #31
        daily_ip_duration.labels(**common).set(stats["duration"])   # #32
        daily_ip_isp.labels(**common).set(1)                        # #33 값은 항상 1, 라벨 노출용


if __name__ == "__main__":
    reset_daily()
    start_http_server(EXPORTER_PORT)
    print(f"go2rtc exporter started on :{EXPORTER_PORT}, polling {GO2RTC_API} every {POLL_INTERVAL}s")
    while True:
        collect()
        time.sleep(POLL_INTERVAL)
