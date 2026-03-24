package com.cctv.webrtc.model;

import java.time.Instant;

/**
 * 시점별 메트릭 스냅샷 (시간대별 추이 차트용).
 * 1분 간격으로 저장, 최대 1440개/일.
 */
public record MetricSnapshot(
	Instant timestamp,
	int activeSessions,
	int activeIps,
	int activeCameras,
	double cpuPercent,
	double rxMbps,
	double txMbps
) {}
