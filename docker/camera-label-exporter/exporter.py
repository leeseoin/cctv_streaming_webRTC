"""
Camera Label Exporter
카메라 ID → 현장명(label) 매핑을 Prometheus 메트릭으로 노출.

용도: Grafana 카메라 TOP 10 테이블에 "cam01" 대신 "읍내삼거리" 같은 현장명 표시.

PromQL 조인 예시 (Grafana 쿼리에 그대로 사용):
  go2rtc_daily_camera_sessions * on(camera) group_left(label) camera_info

매핑 수정:
  cameras.yml 편집 → 최대 RELOAD_INTERVAL초 뒤 자동 반영 (컨테이너 재시작 불필요).
"""

import time
import yaml
from prometheus_client import start_http_server, Gauge

CAMERAS_YML = "/app/cameras.yml"
EXPORTER_PORT = 1986
RELOAD_INTERVAL = 30  # cameras.yml 리로드 주기(초)

camera_info = Gauge(
    "camera_info",
    "Camera ID to location label mapping (value always 1, labels carry info)",
    ["camera", "label"],
)


def load_cameras():
    """cameras.yml 읽어서 {id: label} 딕셔너리 반환. 실패 시 빈 dict."""
    try:
        with open(CAMERAS_YML, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return data.get("cameras", {}) or {}
    except Exception as e:
        print(f"[ERROR] Failed to load {CAMERAS_YML}: {e}")
        return {}


def update_metrics():
    """현재 매핑을 Prometheus 메트릭에 반영. 삭제된 ID는 라벨에서 제거."""
    cameras = load_cameras()
    camera_info._metrics.clear()
    for cam_id, label in cameras.items():
        camera_info.labels(camera=str(cam_id), label=str(label)).set(1)
    print(f"[INFO] Loaded {len(cameras)} camera labels")


if __name__ == "__main__":
    start_http_server(EXPORTER_PORT)
    print(f"camera-label-exporter started on :{EXPORTER_PORT}, reloading every {RELOAD_INTERVAL}s")
    while True:
        update_metrics()
        time.sleep(RELOAD_INTERVAL)
