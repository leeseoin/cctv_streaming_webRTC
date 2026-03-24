package com.cctv.webrtc.service;

import com.cctv.webrtc.model.MetricSnapshot;
import com.cctv.webrtc.model.StreamSession;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.lang.management.ManagementFactory;
import java.lang.management.OperatingSystemMXBean;
import java.time.Instant;
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * go2rtc /api/streams를 5초 간격으로 폴링하여 세션 변화를 추적한다.
 *
 * - 새 consumer 감지 → activeSessions에 추가
 * - 사라진 consumer 감지 → closedSessions로 이동
 * - 1분 간격으로 MetricSnapshot 저장 (시간대별 추이 차트용)
 * - 자정에 일일 데이터 초기화
 */
@Service
public class SessionTracker {

	private static final Logger log = LoggerFactory.getLogger(SessionTracker.class);
	private static final ObjectMapper objectMapper = new ObjectMapper();

	private final Go2RtcService go2RtcService;

	// --- 활성 세션 ---
	private final ConcurrentHashMap<String, StreamSession> activeSessions = new ConcurrentHashMap<>();

	// --- 오늘 종료된 세션 ---
	private final CopyOnWriteArrayList<StreamSession> closedSessions = new CopyOnWriteArrayList<>();

	// --- 시간대별 스냅샷 (1분 간격) ---
	private final CopyOnWriteArrayList<MetricSnapshot> hourlySnapshots = new CopyOnWriteArrayList<>();

	// --- 오늘 고유 IP ---
	private final Set<String> todayUniqueIps = ConcurrentHashMap.newKeySet();

	// --- 피크값 ---
	private volatile int peakConcurrentSessions = 0;
	private volatile int peakConcurrentIps = 0;
	private volatile int peakConcurrentCameras = 0;

	// --- 대역폭 추적 ---
	private volatile double currentRxMbps = 0;
	private volatile double currentTxMbps = 0;
	private volatile long cumulativeRxBytes = 0;
	private volatile long cumulativeTxBytes = 0;
	private volatile double maxRxMbps = 0;
	private volatile double maxTxMbps = 0;
	private volatile double cpuAccumulator = 0;
	private volatile int cpuSampleCount = 0;

	// --- 이전 폴링의 bytes (diff 계산용) ---
	private final ConcurrentHashMap<String, long[]> previousBytes = new ConcurrentHashMap<>();

	// --- 마지막 스냅샷 시각 ---
	private volatile Instant lastSnapshotTime = Instant.now();

	// --- 오늘 날짜 ---
	private volatile LocalDate currentDate = LocalDate.now();

	public SessionTracker(Go2RtcService go2RtcService) {
		this.go2RtcService = go2RtcService;
	}

	/**
	 * 5초 간격으로 go2rtc 폴링
	 */
	@Scheduled(fixedRate = 5000)
	public void pollSessions() {
		try {
			// 자정 체크
			LocalDate today = LocalDate.now();
			if (!today.equals(currentDate)) {
				resetDaily();
				currentDate = today;
			}

			String json = go2RtcService.getStreams();
			JsonNode root = objectMapper.readTree(json);

			Set<String> currentKeys = new HashSet<>();
			Set<String> currentIps = new HashSet<>();
			Set<String> currentCameras = new HashSet<>();
			long totalRxDiff = 0;
			long totalTxDiff = 0;

			// 각 스트림(카메라) 순회
			for (Map.Entry<String, JsonNode> entry : root.properties()) {
				String cameraId = entry.getKey();
				JsonNode streamNode = entry.getValue();

				JsonNode consumers = streamNode.get("consumers");
				if (consumers == null || !consumers.isArray()) continue;

				boolean hasConsumer = false;
				for (JsonNode consumer : consumers) {
					hasConsumer = true;
					String remoteAddr = extractRemoteAddr(consumer);
					String clientIp = extractIp(remoteAddr);
					String protocol = extractProtocol(consumer);
					int consumerId = consumer.has("id") ? consumer.get("id").intValue() : 0;
					String sessionKey = cameraId + ":" + remoteAddr + ":" + protocol + ":" + consumerId;

					currentKeys.add(sessionKey);
					currentIps.add(clientIp);

					// 새 세션 감지
					if (!activeSessions.containsKey(sessionKey)) {
						StreamSession session = new StreamSession(sessionKey, cameraId, clientIp, protocol);
						activeSessions.put(sessionKey, session);
						todayUniqueIps.add(clientIp);
						log.info("세션 시작: {} (카메라={}, IP={}, 프로토콜={})", sessionKey, cameraId, clientIp, protocol);
					}

					// bytes diff 계산
					long recv = getLong(consumer, "recv");
					long send = getLong(consumer, "send");
					long[] prev = previousBytes.getOrDefault(sessionKey, new long[]{0, 0});
					totalRxDiff += Math.max(0, recv - prev[0]);
					totalTxDiff += Math.max(0, send - prev[1]);
					previousBytes.put(sessionKey, new long[]{recv, send});

					// 세션별 bytes 갱신
					StreamSession session = activeSessions.get(sessionKey);
					if (session != null) {
						session.setRxBytes(recv);
						session.setTxBytes(send);
					}
				}

				if (hasConsumer) {
					currentCameras.add(cameraId);
				}
			}

			// 종료된 세션 감지 (이전에 있었으나 지금 없는 키)
			Set<String> removedKeys = new HashSet<>(activeSessions.keySet());
			removedKeys.removeAll(currentKeys);
			for (String key : removedKeys) {
				StreamSession session = activeSessions.remove(key);
				if (session != null) {
					session.close();
					closedSessions.add(session);
					previousBytes.remove(key);
					log.info("세션 종료: {} (지속시간={}초)", key, session.getDurationSeconds());
				}
			}

			// 대역폭 계산 (5초 간격 기준 → Mbps)
			currentRxMbps = (totalRxDiff * 8.0) / (5 * 1_000_000);
			currentTxMbps = (totalTxDiff * 8.0) / (5 * 1_000_000);
			cumulativeRxBytes += totalRxDiff;
			cumulativeTxBytes += totalTxDiff;
			maxRxMbps = Math.max(maxRxMbps, currentRxMbps);
			maxTxMbps = Math.max(maxTxMbps, currentTxMbps);

			// CPU 샘플링
			OperatingSystemMXBean osBean = ManagementFactory.getOperatingSystemMXBean();
			double cpu = osBean.getSystemLoadAverage();
			if (cpu >= 0) {
				cpuAccumulator += cpu;
				cpuSampleCount++;
			}

			// 피크값 갱신
			int sessionCount = activeSessions.size();
			int ipCount = currentIps.size();
			int cameraCount = currentCameras.size();
			peakConcurrentSessions = Math.max(peakConcurrentSessions, sessionCount);
			peakConcurrentIps = Math.max(peakConcurrentIps, ipCount);
			peakConcurrentCameras = Math.max(peakConcurrentCameras, cameraCount);

			// 1분 간격 스냅샷 저장
			Instant now = Instant.now();
			if (now.getEpochSecond() - lastSnapshotTime.getEpochSecond() >= 60) {
				MetricSnapshot snapshot = new MetricSnapshot(
					now, sessionCount, ipCount, cameraCount,
					cpu >= 0 ? cpu : 0, currentRxMbps, currentTxMbps
				);
				hourlySnapshots.add(snapshot);
				lastSnapshotTime = now;

				// 최대 1440개 (24시간 x 60분) 제한
				while (hourlySnapshots.size() > 1440) {
					hourlySnapshots.remove(0);
				}
			}

		} catch (Exception e) {
			log.debug("go2rtc 폴링 실패 (go2rtc 미실행 가능): {}", e.getMessage());
		}
	}

	/**
	 * 자정 초기화
	 */
	private void resetDaily() {
		log.info("자정 초기화: closedSessions={}, uniqueIps={}", closedSessions.size(), todayUniqueIps.size());
		closedSessions.clear();
		todayUniqueIps.clear();
		hourlySnapshots.clear();
		peakConcurrentSessions = activeSessions.size();
		peakConcurrentIps = 0;
		peakConcurrentCameras = 0;
		maxRxMbps = 0;
		maxTxMbps = 0;
		cumulativeRxBytes = 0;
		cumulativeTxBytes = 0;
		cpuAccumulator = 0;
		cpuSampleCount = 0;
	}

	// --- go2rtc consumer JSON 필드 추출 헬퍼 ---

	private String extractRemoteAddr(JsonNode consumer) {
		return consumer.has("remote_addr") ? consumer.get("remote_addr").textValue() : "unknown";
	}

	private String extractIp(String remoteAddr) {
		// remote_addr 형식: "172.66.170.216:16165 prflx" 또는 "192.168.0.100:54321" 또는 "192.168.0.100"
		String addr = remoteAddr.split("\\s+")[0]; // " prflx" 같은 suffix 제거
		int lastColon = addr.lastIndexOf(':');
		if (lastColon > 0 && addr.indexOf('.') >= 0) {
			return addr.substring(0, lastColon);
		}
		return addr;
	}

	private String extractProtocol(JsonNode consumer) {
		// type 또는 protocol 필드
		if (consumer.has("type")) return consumer.get("type").textValue().toLowerCase();
		if (consumer.has("protocol")) return consumer.get("protocol").textValue().toLowerCase();
		return "unknown";
	}

	private long getLong(JsonNode node, String field) {
		return node.has(field) ? node.get(field).longValue() : 0;
	}

	// --- 외부에서 데이터 조회용 (NmsService에서 사용) ---

	public Map<String, StreamSession> getActiveSessions() {
		return Collections.unmodifiableMap(activeSessions);
	}

	public List<StreamSession> getClosedSessions() {
		return Collections.unmodifiableList(closedSessions);
	}

	public List<MetricSnapshot> getHourlySnapshots() {
		return Collections.unmodifiableList(hourlySnapshots);
	}

	public Set<String> getTodayUniqueIps() {
		return Collections.unmodifiableSet(todayUniqueIps);
	}

	public int getPeakConcurrentSessions() { return peakConcurrentSessions; }
	public int getPeakConcurrentIps() { return peakConcurrentIps; }
	public int getPeakConcurrentCameras() { return peakConcurrentCameras; }

	public double getCurrentRxMbps() { return currentRxMbps; }
	public double getCurrentTxMbps() { return currentTxMbps; }
	public long getCumulativeRxBytes() { return cumulativeRxBytes; }
	public long getCumulativeTxBytes() { return cumulativeTxBytes; }
	public double getMaxRxMbps() { return maxRxMbps; }
	public double getMaxTxMbps() { return maxTxMbps; }

	public double getAvgCpuPercent() {
		return cpuSampleCount > 0 ? cpuAccumulator / cpuSampleCount : 0;
	}
}
