"""
Prometheus → YAML Metrics Exporter (Enhanced)
Prometheus API를 주기적으로 쿼리하여 metrics.yml로 저장.

섹션:
  1. go2rtc 실시간 - 스트림/세션/IP/프로토콜
  2. go2rtc Daily - 오늘 하루 집계 (자정 리셋)
  3. System - CPU/메모리/디스크/네트워크/로드
  4. JVM - Spring Boot 힙/스레드/GC
  5. HTTP - 요청 수/RPS/응답시간
  6. Daily 집계 (Prometheus over_time) - CPU/RX/TX 평균/최대
"""

import time
import json
import yaml
import requests
from datetime import datetime, timezone, timedelta

PROMETHEUS_URL = "http://prometheus:9090"
OUTPUT_PATH = "/data/metrics.yml"
OUTPUT_JSON_PATH = "/data/metrics.json"
POLL_INTERVAL = 5  # seconds
KST = timezone(timedelta(hours=9))


# ════════════════════════════════════════
# 쿼리 정의
# ════════════════════════════════════════

QUERIES = {
    # ── go2rtc 실시간 ──
    "go2rtc_up": "go2rtc_up",
    "go2rtc_streams_total": "go2rtc_streams_total",
    "go2rtc_consumers_total": "sum(go2rtc_stream_consumers)",
    "go2rtc_consumers_by_stream": "go2rtc_stream_consumers",
    "go2rtc_producers_by_stream": "go2rtc_stream_producers",
    "go2rtc_active_streams": "count(go2rtc_stream_consumers > 0)",
    "go2rtc_active_ips": "go2rtc_active_ips",
    "go2rtc_active_cameras": "go2rtc_active_cameras",
    "go2rtc_consumers_by_protocol": "go2rtc_consumers_by_protocol",
    "go2rtc_ip_connections": "go2rtc_ip_connections",
    "go2rtc_consumer_bytes_by_stream": "go2rtc_consumer_bytes_total",

    # ── go2rtc Daily (go2rtc-exporter 자체 집계) ──
    "go2rtc_daily_closed_sessions": "go2rtc_daily_closed_sessions",
    "go2rtc_daily_closed_webrtc": "go2rtc_daily_closed_webrtc",
    "go2rtc_daily_closed_hls": "go2rtc_daily_closed_hls",
    "go2rtc_daily_closed_rtsp": "go2rtc_daily_closed_rtsp",
    "go2rtc_daily_unique_ips": "go2rtc_daily_unique_ips",
    "go2rtc_daily_peak_sessions": "go2rtc_daily_peak_sessions",
    "go2rtc_daily_peak_ips": "go2rtc_daily_peak_ips",
    "go2rtc_daily_peak_cameras": "go2rtc_daily_peak_cameras",
    "go2rtc_daily_total_duration_sec": "go2rtc_daily_total_duration_sec",
    "go2rtc_daily_avg_duration_sec": "go2rtc_daily_avg_duration_sec",
    "go2rtc_daily_max_duration_sec": "go2rtc_daily_max_duration_sec",
    "go2rtc_daily_min_duration_sec": "go2rtc_daily_min_duration_sec",
    "go2rtc_daily_total_bytes": "go2rtc_daily_total_bytes",

    # ── System (node-exporter) ──
    "cpu_usage_percent": "100 - (avg(rate(node_cpu_seconds_total{mode='idle'}[1m])) * 100)",
    "cpu_usage_per_core": "100 - (rate(node_cpu_seconds_total{mode='idle'}[1m]) * 100)",
    "memory_total_bytes": "node_memory_MemTotal_bytes",
    "memory_available_bytes": "node_memory_MemAvailable_bytes",
    "memory_used_bytes": "node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes",
    "memory_usage_percent": "(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100",
    "disk_total_bytes": "node_filesystem_size_bytes{mountpoint='/'}",
    "disk_available_bytes": "node_filesystem_avail_bytes{mountpoint='/'}",
    "disk_usage_percent": "(1 - node_filesystem_avail_bytes{mountpoint='/'} / node_filesystem_size_bytes{mountpoint='/'}) * 100",
    "network_rx_bytes_per_sec": "rate(node_network_receive_bytes_total{device='eth0'}[1m])",
    "network_tx_bytes_per_sec": "rate(node_network_transmit_bytes_total{device='eth0'}[1m])",
    "network_rx_mbps": "rate(node_network_receive_bytes_total{device='eth0'}[1m]) * 8 / 1000000",
    "network_tx_mbps": "rate(node_network_transmit_bytes_total{device='eth0'}[1m]) * 8 / 1000000",
    "network_rx_total_bytes": "node_network_receive_bytes_total{device='eth0'}",
    "network_tx_total_bytes": "node_network_transmit_bytes_total{device='eth0'}",
    "network_rx_packets_per_sec": "rate(node_network_receive_packets_total{device='eth0'}[1m])",
    "network_tx_packets_per_sec": "rate(node_network_transmit_packets_total{device='eth0'}[1m])",
    "load_avg_1m": "node_load1",
    "load_avg_5m": "node_load5",
    "load_avg_15m": "node_load15",
    "uptime_seconds": "node_time_seconds - node_boot_time_seconds",

    # ── System Daily 집계 (Prometheus over_time) ──
    "daily_avg_cpu_percent": "avg_over_time((100 - (avg(rate(node_cpu_seconds_total{mode='idle'}[1m])) * 100))[24h:])",
    "daily_max_cpu_percent": "max_over_time((100 - (avg(rate(node_cpu_seconds_total{mode='idle'}[1m])) * 100))[24h:])",
    "daily_avg_rx_mbps": "avg_over_time((rate(node_network_receive_bytes_total{device='eth0'}[1m]) * 8 / 1000000)[24h:])",
    "daily_max_rx_mbps": "max_over_time((rate(node_network_receive_bytes_total{device='eth0'}[1m]) * 8 / 1000000)[24h:])",
    "daily_avg_tx_mbps": "avg_over_time((rate(node_network_transmit_bytes_total{device='eth0'}[1m]) * 8 / 1000000)[24h:])",
    "daily_max_tx_mbps": "max_over_time((rate(node_network_transmit_bytes_total{device='eth0'}[1m]) * 8 / 1000000)[24h:])",

    # ── Spring Boot (JVM) ──
    "jvm_heap_used_bytes": 'sum(jvm_memory_used_bytes{area="heap"})',
    "jvm_heap_max_bytes": 'sum(jvm_memory_max_bytes{area="heap"})',
    "jvm_nonheap_used_bytes": 'sum(jvm_memory_used_bytes{area="nonheap"})',
    "jvm_heap_usage_percent": 'sum(jvm_memory_used_bytes{area="heap"}) / sum(jvm_memory_max_bytes{area="heap"}) * 100',
    "jvm_threads_live": "jvm_threads_live_threads",
    "jvm_gc_pause_seconds": "rate(jvm_gc_pause_seconds_sum[1m])",

    # ── Spring Boot (HTTP) ──
    "http_requests_total": "sum(http_server_requests_seconds_count)",
    "http_requests_by_uri": "http_server_requests_seconds_count",
    "http_requests_per_sec": "sum(rate(http_server_requests_seconds_count[1m]))",
    "http_avg_response_time_ms": "sum(rate(http_server_requests_seconds_sum[1m])) / sum(rate(http_server_requests_seconds_count[1m])) * 1000",
}


def query_prometheus(expr):
    """Prometheus instant query."""
    try:
        resp = requests.get(
            f"{PROMETHEUS_URL}/api/v1/query",
            params={"query": expr},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
        if data["status"] != "success":
            return None
        return data["data"]["result"]
    except Exception:
        return None


def parse_result(result):
    """Prometheus 결과를 단순값 또는 라벨별 dict로 변환."""
    if result is None or len(result) == 0:
        return None

    # 단일 값
    if len(result) == 1 and not any(
        k for k in result[0]["metric"] if k not in ("__name__", "instance", "job")
    ):
        val = result[0]["value"][1]
        try:
            return round(float(val), 2) if "." in val else int(val)
        except (ValueError, TypeError):
            return val

    # 라벨별 값
    items = {}
    for r in result:
        labels = {
            k: v
            for k, v in r["metric"].items()
            if k not in ("__name__", "instance", "job")
        }
        key = "_".join(labels.values()) if labels else "value"
        val = r["value"][1]
        try:
            items[key] = round(float(val), 2) if "." in val else int(val)
        except (ValueError, TypeError):
            items[key] = val
    return items


def format_duration(seconds):
    """초를 HH:MM:SS 형식으로 변환."""
    if seconds is None or seconds == 0:
        return "00:00:00"
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def format_bytes(b):
    """바이트를 읽기 쉬운 단위로 변환."""
    if b is None or b == 0:
        return "0 B"
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(b) < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} PB"


def collect_all():
    """모든 쿼리 실행 → dict 반환."""
    raw = {}
    for name, expr in QUERIES.items():
        result = query_prometheus(expr)
        raw[name] = parse_result(result)

    # ── 구조화된 YAML 생성 ──
    metrics = {
        "timestamp": datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S"),
        "poll_interval_sec": POLL_INTERVAL,
    }

    # ── go2rtc 실시간 ──
    metrics["realtime"] = {
        "go2rtc_up": raw.get("go2rtc_up"),
        "streams_total": raw.get("go2rtc_streams_total"),
        "consumers_total": raw.get("go2rtc_consumers_total"),
        "active_ips": raw.get("go2rtc_active_ips"),
        "active_cameras": raw.get("go2rtc_active_cameras"),
        "consumers_by_protocol": raw.get("go2rtc_consumers_by_protocol"),
        "ip_connections": raw.get("go2rtc_ip_connections"),
        "consumers_by_stream": raw.get("go2rtc_consumers_by_stream"),
        "producers_by_stream": raw.get("go2rtc_producers_by_stream"),
        "consumer_bytes_by_stream": raw.get("go2rtc_consumer_bytes_by_stream"),
        "cpu_percent": raw.get("cpu_usage_percent"),
        "memory_usage_percent": raw.get("memory_usage_percent"),
        "memory_used_bytes": raw.get("memory_used_bytes"),
        "memory_total_bytes": raw.get("memory_total_bytes"),
        "network_rx_mbps": raw.get("network_rx_mbps"),
        "network_tx_mbps": raw.get("network_tx_mbps"),
        "network_rx_total_bytes": raw.get("network_rx_total_bytes"),
        "network_tx_total_bytes": raw.get("network_tx_total_bytes"),
        "load_avg_1m": raw.get("load_avg_1m"),
        "uptime_seconds": raw.get("uptime_seconds"),
        "jvm_heap_usage_percent": raw.get("jvm_heap_usage_percent"),
        "jvm_heap_used_bytes": raw.get("jvm_heap_used_bytes"),
        "jvm_heap_max_bytes": raw.get("jvm_heap_max_bytes"),
        "jvm_threads_live": raw.get("jvm_threads_live"),
        "http_requests_per_sec": raw.get("http_requests_per_sec"),
        "http_avg_response_time_ms": raw.get("http_avg_response_time_ms"),
    }

    # ── Daily Summary ──
    total_dur = raw.get("go2rtc_daily_total_duration_sec") or 0
    avg_dur = raw.get("go2rtc_daily_avg_duration_sec") or 0
    max_dur = raw.get("go2rtc_daily_max_duration_sec") or 0
    min_dur = raw.get("go2rtc_daily_min_duration_sec") or 0
    total_bytes = raw.get("go2rtc_daily_total_bytes") or 0

    metrics["daily"] = {
        "closed_sessions": raw.get("go2rtc_daily_closed_sessions"),
        "closed_webrtc": raw.get("go2rtc_daily_closed_webrtc"),
        "closed_hls": raw.get("go2rtc_daily_closed_hls"),
        "closed_rtsp": raw.get("go2rtc_daily_closed_rtsp"),
        "unique_ips": raw.get("go2rtc_daily_unique_ips"),
        "peak_sessions": raw.get("go2rtc_daily_peak_sessions"),
        "peak_ips": raw.get("go2rtc_daily_peak_ips"),
        "peak_cameras": raw.get("go2rtc_daily_peak_cameras"),
        "total_duration_sec": total_dur,
        "total_duration_fmt": format_duration(total_dur),
        "avg_duration_sec": avg_dur,
        "avg_duration_fmt": format_duration(avg_dur),
        "max_duration_sec": max_dur,
        "max_duration_fmt": format_duration(max_dur),
        "min_duration_sec": min_dur,
        "min_duration_fmt": format_duration(min_dur),
        "total_bytes": total_bytes,
        "total_bytes_fmt": format_bytes(total_bytes),
        "avg_cpu_percent": raw.get("daily_avg_cpu_percent"),
        "max_cpu_percent": raw.get("daily_max_cpu_percent"),
        "avg_rx_mbps": raw.get("daily_avg_rx_mbps"),
        "max_rx_mbps": raw.get("daily_max_rx_mbps"),
        "avg_tx_mbps": raw.get("daily_avg_tx_mbps"),
        "max_tx_mbps": raw.get("daily_max_tx_mbps"),
    }

    # ── System Detail ──
    metrics["system"] = {
        "cpu_usage_percent": raw.get("cpu_usage_percent"),
        "cpu_usage_per_core": raw.get("cpu_usage_per_core"),
        "memory_total_bytes": raw.get("memory_total_bytes"),
        "memory_available_bytes": raw.get("memory_available_bytes"),
        "memory_used_bytes": raw.get("memory_used_bytes"),
        "memory_usage_percent": raw.get("memory_usage_percent"),
        "disk_total_bytes": raw.get("disk_total_bytes"),
        "disk_available_bytes": raw.get("disk_available_bytes"),
        "disk_usage_percent": raw.get("disk_usage_percent"),
        "network_rx_bytes_per_sec": raw.get("network_rx_bytes_per_sec"),
        "network_tx_bytes_per_sec": raw.get("network_tx_bytes_per_sec"),
        "network_rx_mbps": raw.get("network_rx_mbps"),
        "network_tx_mbps": raw.get("network_tx_mbps"),
        "network_rx_total_bytes": raw.get("network_rx_total_bytes"),
        "network_tx_total_bytes": raw.get("network_tx_total_bytes"),
        "network_rx_packets_per_sec": raw.get("network_rx_packets_per_sec"),
        "network_tx_packets_per_sec": raw.get("network_tx_packets_per_sec"),
        "load_avg_1m": raw.get("load_avg_1m"),
        "load_avg_5m": raw.get("load_avg_5m"),
        "load_avg_15m": raw.get("load_avg_15m"),
        "uptime_seconds": raw.get("uptime_seconds"),
    }

    # ── JVM Detail ──
    metrics["jvm"] = {
        "heap_used_bytes": raw.get("jvm_heap_used_bytes"),
        "heap_max_bytes": raw.get("jvm_heap_max_bytes"),
        "nonheap_used_bytes": raw.get("jvm_nonheap_used_bytes"),
        "heap_usage_percent": raw.get("jvm_heap_usage_percent"),
        "threads_live": raw.get("jvm_threads_live"),
        "gc_pause_seconds": raw.get("jvm_gc_pause_seconds"),
    }

    # ── HTTP Detail ──
    metrics["http"] = {
        "requests_total": raw.get("http_requests_total"),
        "requests_by_uri": raw.get("http_requests_by_uri"),
        "requests_per_sec": raw.get("http_requests_per_sec"),
        "avg_response_time_ms": raw.get("http_avg_response_time_ms"),
    }

    return metrics


def yaml_val(val, indent=2):
    """값을 YAML 문자열로 변환."""
    prefix = " " * indent
    if val is None:
        return "null"
    if isinstance(val, dict):
        if not val:
            return "{}"
        lines = []
        for k, v in val.items():
            lines.append(f"\n{prefix}  {k}: {v}")
        return "".join(lines)
    if isinstance(val, str):
        return f"'{val}'"
    if isinstance(val, float):
        return f"{val}"
    return str(val)


def write_yaml(metrics):
    """주석 포함 YAML 파일로 저장."""
    r = metrics.get("realtime", {})
    d = metrics.get("daily", {})
    s = metrics.get("system", {})
    j = metrics.get("jvm", {})
    h = metrics.get("http", {})

    lines = [
        f"# ═══════════════════════════════════════════════════════",
        f"# CCTV Streamer - Monitoring Metrics",
        f"# 생성시각: {metrics.get('timestamp', '')}",
        f"# 갱신주기: {metrics.get('poll_interval_sec', 5)}초",
        f"# ═══════════════════════════════════════════════════════",
        f"",
        f"timestamp: '{metrics.get('timestamp', '')}'",
        f"poll_interval_sec: {metrics.get('poll_interval_sec', 5)}",
        f"",
        f"# ─────────────────────────────────────────────────────",
        f"# nms2: Real-time (실시간 현재 상태)",
        f"# 참조: NMS_METRICS_DEFINITION.md > nms2",
        f"# ─────────────────────────────────────────────────────",
        f"realtime:",
        f"",
        f"  # ── go2rtc 스트리밍 상태 ──",
        f"  go2rtc_up: {yaml_val(r.get('go2rtc_up'))}                    # go2rtc 프로세스 상태 (1=UP, 0=DOWN)",
        f"  streams_total: {yaml_val(r.get('streams_total'))}                 # 전체 등록 스트림 수",
        f"  consumers_total: {yaml_val(r.get('consumers_total'))}               # [nms2-3] 활성 세션 수 (현재 시청자)",
        f"  active_ips: {yaml_val(r.get('active_ips'))}                     # [nms2-2] 활성 IP 수 (고유 접속자)",
        f"  active_cameras: {yaml_val(r.get('active_cameras'))}                # [nms2-4] 활성 카메라 수",
        f"",
        f"  # ── 프로토콜별 시청자 ──",
        f"  consumers_by_protocol:{yaml_val(r.get('consumers_by_protocol'))}",
        f"",
        f"  # ── IP별 연결 수 (nms3: IP 분포) ──",
        f"  ip_connections:{yaml_val(r.get('ip_connections'))}",
        f"",
        f"  # ── 스트림별 상세 ──",
        f"  consumers_by_stream:{yaml_val(r.get('consumers_by_stream'))}",
        f"",
        f"  producers_by_stream:{yaml_val(r.get('producers_by_stream'))}",
        f"",
        f"  consumer_bytes_by_stream:{yaml_val(r.get('consumer_bytes_by_stream'))}",
        f"",
        f"  # ── 서버 상태 (실시간) ──",
        f"  cpu_percent: {yaml_val(r.get('cpu_percent'))}                  # [nms2-1] CPU 사용률 (%)",
        f"  memory_usage_percent: {yaml_val(r.get('memory_usage_percent'))}    # 메모리 사용률 (%)",
        f"  memory_used_bytes: {yaml_val(r.get('memory_used_bytes'))}       # 메모리 사용량 (bytes)",
        f"  memory_total_bytes: {yaml_val(r.get('memory_total_bytes'))}      # 메모리 전체 (bytes)",
        f"  network_rx_mbps:{yaml_val(r.get('network_rx_mbps'))}      # [nms2-6] 현재 수신 대역폭 (Mbps)",
        f"  network_tx_mbps:{yaml_val(r.get('network_tx_mbps'))}      # [nms2-7] 현재 송신 대역폭 (Mbps)",
        f"  network_rx_total_bytes:{yaml_val(r.get('network_rx_total_bytes'))}  # [nms2-8] 누적 수신 (bytes)",
        f"  network_tx_total_bytes:{yaml_val(r.get('network_tx_total_bytes'))}  # [nms2-9] 누적 송신 (bytes)",
        f"  load_avg_1m: {yaml_val(r.get('load_avg_1m'))}",
        f"  uptime_seconds: {yaml_val(r.get('uptime_seconds'))}",
        f"",
        f"  # ── JVM (Spring Boot) ──",
        f"  jvm_heap_usage_percent: {yaml_val(r.get('jvm_heap_usage_percent'))}  # JVM 힙 사용률 (%)",
        f"  jvm_heap_used_bytes: {yaml_val(r.get('jvm_heap_used_bytes'))}",
        f"  jvm_heap_max_bytes: {yaml_val(r.get('jvm_heap_max_bytes'))}",
        f"  jvm_threads_live: {yaml_val(r.get('jvm_threads_live'))}",
        f"  http_requests_per_sec: {yaml_val(r.get('http_requests_per_sec'))}    # 초당 요청 수 (RPS)",
        f"  http_avg_response_time_ms: {yaml_val(r.get('http_avg_response_time_ms'))}  # 평균 응답시간 (ms)",
        f"",
        f"# ─────────────────────────────────────────────────────",
        f"# nms1: Daily Summary (오늘 하루 집계, 자정 리셋)",
        f"# 참조: NMS_METRICS_DEFINITION.md > nms1",
        f"# ─────────────────────────────────────────────────────",
        f"daily:",
        f"",
        f"  # ── 세션 통계 ──",
        f"  closed_sessions: {yaml_val(d.get('closed_sessions'))}             # [nms1-1] 오늘 종료 세션 수",
        f"  closed_webrtc: {yaml_val(d.get('closed_webrtc'))}               # [nms1-11] WebRTC 종료 세션",
        f"  closed_hls: {yaml_val(d.get('closed_hls'))}                  # HLS 종료 세션",
        f"  closed_rtsp: {yaml_val(d.get('closed_rtsp'))}                 # [nms1-12] RTSP 종료 세션",
        f"  unique_ips: {yaml_val(d.get('unique_ips'))}                  # [nms1-2] 오늘 고유 IP 수",
        f"",
        f"  # ── 피크값 ──",
        f"  peak_sessions: {yaml_val(d.get('peak_sessions'))}               # [nms1-4] 최대 동시 세션",
        f"  peak_ips: {yaml_val(d.get('peak_ips'))}                    # 최대 동시 IP",
        f"  peak_cameras: {yaml_val(d.get('peak_cameras'))}                # 최대 동시 카메라",
        f"",
        f"  # ── 시청 시간 ──",
        f"  total_duration_sec: {yaml_val(d.get('total_duration_sec'))}        # 총 시청시간 (초)",
        f"  total_duration_fmt: {yaml_val(d.get('total_duration_fmt'))}   # 총 시청시간 (HH:MM:SS)",
        f"  avg_duration_sec: {yaml_val(d.get('avg_duration_sec'))}          # [nms1-3] 평균 세션시간 (초)",
        f"  avg_duration_fmt: {yaml_val(d.get('avg_duration_fmt'))}     # 평균 세션시간 (HH:MM:SS)",
        f"  max_duration_sec: {yaml_val(d.get('max_duration_sec'))}          # 최장 세션 (초)",
        f"  max_duration_fmt: {yaml_val(d.get('max_duration_fmt'))}     # 최장 세션 (HH:MM:SS)",
        f"  min_duration_sec: {yaml_val(d.get('min_duration_sec'))}          # 최단 세션 (초)",
        f"  min_duration_fmt: {yaml_val(d.get('min_duration_fmt'))}     # 최단 세션 (HH:MM:SS)",
        f"",
        f"  # ── 전송량 ──",
        f"  total_bytes: {yaml_val(d.get('total_bytes'))}                 # 오늘 총 전송 바이트",
        f"  total_bytes_fmt: {yaml_val(d.get('total_bytes_fmt'))}       # 읽기 쉬운 단위",
        f"",
        f"  # ── 서버 Daily 집계 (Prometheus over_time) ──",
        f"  avg_cpu_percent: {yaml_val(d.get('avg_cpu_percent'))}             # [nms1-6] 오늘 평균 CPU (%)",
        f"  max_cpu_percent: {yaml_val(d.get('max_cpu_percent'))}            # 오늘 최대 CPU (%)",
        f"  avg_rx_mbps:{yaml_val(d.get('avg_rx_mbps'))}           # [nms1-7] 오늘 평균 RX (Mbps)",
        f"  max_rx_mbps:{yaml_val(d.get('max_rx_mbps'))}           # [nms1-8] 오늘 최대 RX (Mbps)",
        f"  avg_tx_mbps:{yaml_val(d.get('avg_tx_mbps'))}           # [nms1-9] 오늘 평균 TX (Mbps)",
        f"  max_tx_mbps:{yaml_val(d.get('max_tx_mbps'))}           # [nms1-10] 오늘 최대 TX (Mbps)",
        f"",
        f"# ─────────────────────────────────────────────────────",
        f"# System Detail (서버 상세 - node-exporter)",
        f"# ─────────────────────────────────────────────────────",
        f"system:",
        f"  cpu_usage_percent: {yaml_val(s.get('cpu_usage_percent'))}",
        f"  cpu_usage_per_core:{yaml_val(s.get('cpu_usage_per_core'))}",
        f"  memory_total_bytes: {yaml_val(s.get('memory_total_bytes'))}",
        f"  memory_available_bytes: {yaml_val(s.get('memory_available_bytes'))}",
        f"  memory_used_bytes: {yaml_val(s.get('memory_used_bytes'))}",
        f"  memory_usage_percent: {yaml_val(s.get('memory_usage_percent'))}",
        f"  disk_total_bytes: {yaml_val(s.get('disk_total_bytes'))}",
        f"  disk_available_bytes: {yaml_val(s.get('disk_available_bytes'))}",
        f"  disk_usage_percent: {yaml_val(s.get('disk_usage_percent'))}",
        f"  network_rx_bytes_per_sec:{yaml_val(s.get('network_rx_bytes_per_sec'))}",
        f"  network_tx_bytes_per_sec:{yaml_val(s.get('network_tx_bytes_per_sec'))}",
        f"  network_rx_mbps:{yaml_val(s.get('network_rx_mbps'))}",
        f"  network_tx_mbps:{yaml_val(s.get('network_tx_mbps'))}",
        f"  network_rx_total_bytes:{yaml_val(s.get('network_rx_total_bytes'))}",
        f"  network_tx_total_bytes:{yaml_val(s.get('network_tx_total_bytes'))}",
        f"  network_rx_packets_per_sec:{yaml_val(s.get('network_rx_packets_per_sec'))}",
        f"  network_tx_packets_per_sec:{yaml_val(s.get('network_tx_packets_per_sec'))}",
        f"  load_avg_1m: {yaml_val(s.get('load_avg_1m'))}",
        f"  load_avg_5m: {yaml_val(s.get('load_avg_5m'))}",
        f"  load_avg_15m: {yaml_val(s.get('load_avg_15m'))}",
        f"  uptime_seconds: {yaml_val(s.get('uptime_seconds'))}",
        f"",
        f"# ─────────────────────────────────────────────────────",
        f"# JVM Detail (Spring Boot - Actuator/Micrometer)",
        f"# ─────────────────────────────────────────────────────",
        f"jvm:",
        f"  heap_used_bytes: {yaml_val(j.get('heap_used_bytes'))}",
        f"  heap_max_bytes: {yaml_val(j.get('heap_max_bytes'))}",
        f"  nonheap_used_bytes: {yaml_val(j.get('nonheap_used_bytes'))}",
        f"  heap_usage_percent: {yaml_val(j.get('heap_usage_percent'))}",
        f"  threads_live: {yaml_val(j.get('threads_live'))}",
        f"  gc_pause_seconds:{yaml_val(j.get('gc_pause_seconds'))}",
        f"",
        f"# ─────────────────────────────────────────────────────",
        f"# HTTP Detail (Spring Boot 요청 통계)",
        f"# ─────────────────────────────────────────────────────",
        f"http:",
        f"  requests_total: {yaml_val(h.get('requests_total'))}",
        f"  requests_by_uri:{yaml_val(h.get('requests_by_uri'))}",
        f"  requests_per_sec: {yaml_val(h.get('requests_per_sec'))}",
        f"  avg_response_time_ms: {yaml_val(h.get('avg_response_time_ms'))}",
    ]

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    print(f"Metrics exporter started. Polling Prometheus every {POLL_INTERVAL}s → {OUTPUT_PATH}")
    while True:
        try:
            metrics = collect_all()
            write_yaml(metrics)
            with open(OUTPUT_JSON_PATH, "w", encoding="utf-8") as jf:
                json.dump(metrics, jf, ensure_ascii=False, indent=2)
            ts = metrics["timestamp"]
            print(f"[{ts}] Updated metrics.yml + metrics.json ({len(QUERIES)} queries)")
        except Exception as e:
            print(f"[ERROR] {e}")
        time.sleep(POLL_INTERVAL)
