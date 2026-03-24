package com.cctv.webrtc.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * TCP 소켓 기반 IP 분포 조회.
 * go2rtc 관련 포트(1984, 8555)로 연결된 소켓에서 클라이언트 IP를 추출한다.
 * macOS: lsof, Linux: ss 명령어 사용.
 */
@Service
public class NetworkMetricService {

	private static final Logger log = LoggerFactory.getLogger(NetworkMetricService.class);
	private static final boolean IS_MAC = System.getProperty("os.name", "").toLowerCase().contains("mac");

	/**
	 * IP별 소켓 수 분포 조회.
	 * @return IP → 소켓 수 맵 (내림차순 정렬)
	 */
	public List<Map<String, Object>> getIpDistribution() {
		Map<String, Integer> ipCounts = new LinkedHashMap<>();

		try {
			List<String> lines;
			if (IS_MAC) {
				lines = runCommand("lsof", "-i", "TCP", "-n", "-P");
			} else {
				lines = runCommand("ss", "-tn");
			}

			for (String line : lines) {
				String ip = IS_MAC ? extractIpFromLsof(line) : extractIpFromSs(line);
				if (ip != null && !isLocalIp(ip)) {
					ipCounts.merge(ip, 1, Integer::sum);
				}
			}
		} catch (Exception e) {
			log.debug("소켓 IP 분포 조회 실패: {}", e.getMessage());
		}

		// 소켓 수 내림차순 정렬
		List<Map<String, Object>> result = new ArrayList<>();
		ipCounts.entrySet().stream()
			.sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
			.forEach(entry -> {
				Map<String, Object> item = new LinkedHashMap<>();
				item.put("ip", entry.getKey());
				item.put("socketCount", entry.getValue());
				result.add(item);
			});

		return result;
	}

	/**
	 * 소켓 기준 고유 IP 수 반환
	 */
	public int getSocketIpCount() {
		List<Map<String, Object>> distribution = getIpDistribution();
		return distribution.size();
	}

	// --- lsof 출력에서 ESTABLISHED 클라이언트 IP 추출 ---
	// 예: java    12345 user  123u IPv4 ... TCP 192.168.0.10:8085->192.168.0.100:54321 (ESTABLISHED)
	private static final Pattern LSOF_PATTERN = Pattern.compile("->([\\d.]+):\\d+\\s+\\(ESTABLISHED\\)");

	private String extractIpFromLsof(String line) {
		if (!line.contains("ESTABLISHED")) return null;
		// go2rtc 또는 java 포트에 연결된 소켓만 필터
		if (!line.contains(":1984") && !line.contains(":8555") && !line.contains(":8085")) return null;
		Matcher m = LSOF_PATTERN.matcher(line);
		return m.find() ? m.group(1) : null;
	}

	// --- ss 출력에서 클라이언트 IP 추출 ---
	// 예: ESTAB  0  0  192.168.0.10:8085  192.168.0.100:54321
	private static final Pattern SS_PATTERN = Pattern.compile("ESTAB\\s+\\d+\\s+\\d+\\s+[\\d.]+:\\d+\\s+([\\d.]+):\\d+");

	private String extractIpFromSs(String line) {
		if (!line.contains("ESTAB")) return null;
		if (!line.contains(":1984") && !line.contains(":8555") && !line.contains(":8085")) return null;
		Matcher m = SS_PATTERN.matcher(line);
		return m.find() ? m.group(1) : null;
	}

	private boolean isLocalIp(String ip) {
		return "127.0.0.1".equals(ip) || "0.0.0.0".equals(ip) || "::1".equals(ip);
	}

	private List<String> runCommand(String... command) throws Exception {
		ProcessBuilder pb = new ProcessBuilder(command);
		pb.redirectErrorStream(true);
		Process proc = pb.start();
		List<String> lines = new ArrayList<>();
		try (BufferedReader reader = new BufferedReader(new InputStreamReader(proc.getInputStream()))) {
			String line;
			while ((line = reader.readLine()) != null) {
				lines.add(line);
			}
		}
		proc.waitFor();
		return lines;
	}
}
