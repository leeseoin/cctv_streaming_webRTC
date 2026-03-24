package com.cctv.webrtc.service;

import com.cctv.webrtc.model.MetricSnapshot;
import com.cctv.webrtc.model.StreamSession;
import org.springframework.stereotype.Service;

import java.lang.management.ManagementFactory;
import java.lang.management.OperatingSystemMXBean;
import java.time.ZoneId;
import java.util.*;
import java.util.stream.Collectors;

/**
 * SessionTracker + NetworkMetricService 데이터를 조합하여 NMS 응답을 생성한다.
 */
@Service
public class NmsService {

	private final SessionTracker sessionTracker;
	private final NetworkMetricService networkMetricService;

	public NmsService(SessionTracker sessionTracker, NetworkMetricService networkMetricService) {
		this.sessionTracker = sessionTracker;
		this.networkMetricService = networkMetricService;
	}

	/**
	 * nms1 — Daily Summary
	 */
	public Map<String, Object> getDailySummary() {
		Map<String, Object> result = new LinkedHashMap<>();

		List<StreamSession> closed = sessionTracker.getClosedSessions();
		Map<String, StreamSession> active = sessionTracker.getActiveSessions();

		// --- KPI 12개 ---
		Map<String, Object> kpi = new LinkedHashMap<>();
		kpi.put("closedSessions", closed.size());
		kpi.put("uniqueIps", sessionTracker.getTodayUniqueIps().size());
		kpi.put("avgDurationSec", calcAvgDuration(closed));
		kpi.put("peakConcurrentSessions", sessionTracker.getPeakConcurrentSessions());
		kpi.put("mobilePercent", 0); // 1차: 미구현
		kpi.put("avgCpuPercent", round2(sessionTracker.getAvgCpuPercent()));
		kpi.put("avgRxMbps", round2(calcAvgFromSnapshots("rx")));
		kpi.put("maxRxMbps", round2(sessionTracker.getMaxRxMbps()));
		kpi.put("avgTxMbps", round2(calcAvgFromSnapshots("tx")));
		kpi.put("maxTxMbps", round2(sessionTracker.getMaxTxMbps()));
		kpi.put("webrtcClosedSessions", countByProtocol(closed, "webrtc"));
		kpi.put("rtspClosedSessions", countByProtocol(closed, "rtsp"));
		result.put("kpi", kpi);

		// --- 우측 요약 6개 ---
		Map<String, Object> summary = new LinkedHashMap<>();
		summary.put("totalWatchTimeSec", calcTotalWatchTime(closed));
		summary.put("longestSessionSec", calcLongestSession(closed));
		summary.put("shortestSessionSec", calcShortestSession(closed));
		summary.put("peakConcurrentIps", sessionTracker.getPeakConcurrentIps());
		summary.put("peakConcurrentCameras", sessionTracker.getPeakConcurrentCameras());
		summary.put("cumulativeRxMB", sessionTracker.getCumulativeRxBytes() / (1024 * 1024));
		summary.put("cumulativeTxMB", sessionTracker.getCumulativeTxBytes() / (1024 * 1024));
		result.put("summary", summary);

		// --- 시간대별 추이 ---
		result.put("hourlyTrend", buildHourlyTrend());

		// --- 카메라 TOP 10 ---
		result.put("topCameras", buildCameraTop10(closed));

		// --- IP TOP 10 ---
		result.put("topIps", buildIpTop10(closed));

		return result;
	}

	/**
	 * nms2 — Real-time
	 */
	public Map<String, Object> getRealtime() {
		Map<String, Object> result = new LinkedHashMap<>();

		Map<String, StreamSession> active = sessionTracker.getActiveSessions();

		// CPU
		OperatingSystemMXBean osBean = ManagementFactory.getOperatingSystemMXBean();
		double cpu = osBean.getSystemLoadAverage();
		result.put("cpuPercent", round2(cpu >= 0 ? cpu : 0));

		// 활성 세션 / IP / 카메라
		Set<String> activeIps = new HashSet<>();
		Set<String> activeCameras = new HashSet<>();
		for (StreamSession s : active.values()) {
			activeIps.add(s.getClientIp());
			activeCameras.add(s.getCameraId());
		}
		result.put("activeIps", activeIps.size());
		result.put("activeSessions", active.size());
		result.put("activeCameras", activeCameras.size());
		result.put("mobileLikelyIps", 0); // 1차: 미구현
		result.put("currentRxMbps", round2(sessionTracker.getCurrentRxMbps()));
		result.put("currentTxMbps", round2(sessionTracker.getCurrentTxMbps()));
		result.put("cumulativeRxBytes", sessionTracker.getCumulativeRxBytes());
		result.put("cumulativeTxBytes", sessionTracker.getCumulativeTxBytes());
		result.put("socketIpCount", networkMetricService.getSocketIpCount());

		return result;
	}

	/**
	 * nms3 — IP별 소켓 수 분포
	 */
	public Map<String, Object> getIpDistribution() {
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("distribution", networkMetricService.getIpDistribution());
		return result;
	}

	// --- 헬퍼 메서드 ---

	private long calcAvgDuration(List<StreamSession> sessions) {
		if (sessions.isEmpty()) return 0;
		long total = sessions.stream().mapToLong(StreamSession::getDurationSeconds).sum();
		return total / sessions.size();
	}

	private long calcTotalWatchTime(List<StreamSession> sessions) {
		return sessions.stream().mapToLong(StreamSession::getDurationSeconds).sum();
	}

	private long calcLongestSession(List<StreamSession> sessions) {
		return sessions.stream().mapToLong(StreamSession::getDurationSeconds).max().orElse(0);
	}

	private long calcShortestSession(List<StreamSession> sessions) {
		return sessions.stream().mapToLong(StreamSession::getDurationSeconds).min().orElse(0);
	}

	private int countByProtocol(List<StreamSession> sessions, String protocol) {
		return (int) sessions.stream().filter(s -> s.getProtocol().contains(protocol)).count();
	}

	private double calcAvgFromSnapshots(String type) {
		List<MetricSnapshot> snapshots = sessionTracker.getHourlySnapshots();
		if (snapshots.isEmpty()) return 0;
		double sum = snapshots.stream()
			.mapToDouble(s -> "rx".equals(type) ? s.rxMbps() : s.txMbps())
			.sum();
		return sum / snapshots.size();
	}

	private List<Map<String, Object>> buildHourlyTrend() {
		List<MetricSnapshot> snapshots = sessionTracker.getHourlySnapshots();

		// 시간대(hour)별 평균 집계
		Map<Integer, List<MetricSnapshot>> byHour = snapshots.stream()
			.collect(Collectors.groupingBy(s ->
				s.timestamp().atZone(ZoneId.systemDefault()).getHour()
			));

		List<Map<String, Object>> trend = new ArrayList<>();
		for (int h = 0; h < 24; h++) {
			List<MetricSnapshot> hourData = byHour.getOrDefault(h, List.of());
			Map<String, Object> point = new LinkedHashMap<>();
			point.put("hour", h);
			if (hourData.isEmpty()) {
				point.put("sessions", 0);
				point.put("ips", 0);
				point.put("rxMbps", 0);
				point.put("txMbps", 0);
			} else {
				point.put("sessions", (int) hourData.stream().mapToInt(MetricSnapshot::activeSessions).average().orElse(0));
				point.put("ips", (int) hourData.stream().mapToInt(MetricSnapshot::activeIps).average().orElse(0));
				point.put("rxMbps", round2(hourData.stream().mapToDouble(MetricSnapshot::rxMbps).average().orElse(0)));
				point.put("txMbps", round2(hourData.stream().mapToDouble(MetricSnapshot::txMbps).average().orElse(0)));
			}
			trend.add(point);
		}
		return trend;
	}

	private List<Map<String, Object>> buildCameraTop10(List<StreamSession> sessions) {
		Map<String, List<StreamSession>> byCamera = sessions.stream()
			.collect(Collectors.groupingBy(StreamSession::getCameraId));

		return byCamera.entrySet().stream()
			.sorted((a, b) -> Integer.compare(b.getValue().size(), a.getValue().size()))
			.limit(10)
			.map(entry -> {
				Map<String, Object> cam = new LinkedHashMap<>();
				cam.put("camera", entry.getKey());
				cam.put("sessionCount", entry.getValue().size());
				cam.put("totalWatchTimeSec", entry.getValue().stream().mapToLong(StreamSession::getDurationSeconds).sum());
				cam.put("maxReaders", 0); // TODO: 폴링 시점별 동시 reader 추적 필요
				return cam;
			})
			.toList();
	}

	private List<Map<String, Object>> buildIpTop10(List<StreamSession> sessions) {
		Map<String, List<StreamSession>> byIp = sessions.stream()
			.collect(Collectors.groupingBy(StreamSession::getClientIp));

		return byIp.entrySet().stream()
			.sorted((a, b) -> Integer.compare(b.getValue().size(), a.getValue().size()))
			.limit(10)
			.map(entry -> {
				Map<String, Object> ip = new LinkedHashMap<>();
				ip.put("ip", entry.getKey());
				ip.put("isp", ""); // 1차: 미구현
				ip.put("mobile", false); // 1차: 미구현
				ip.put("sessionCount", entry.getValue().size());
				ip.put("totalWatchTimeSec", entry.getValue().stream().mapToLong(StreamSession::getDurationSeconds).sum());
				return ip;
			})
			.toList();
	}

	private double round2(double value) {
		return Math.round(value * 100.0) / 100.0;
	}
}
