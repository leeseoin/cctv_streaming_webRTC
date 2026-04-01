package com.cctv.webrtc.controller;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.net.InetAddress;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * NMS 모니터링 API.
 *
 * GET /api/nms/daily            → nms1 Daily Summary
 * GET /api/nms/realtime         → nms2 Real-time
 * GET /api/nms/ip-distribution  → nms3 IP별 소켓 수 분포
 * GET /api/nms/network-check    → 클라이언트 네트워크 판별 (LAN/외부)
 */
@RestController
@RequestMapping("/api/nms")
public class NmsController {	

	/**
	 * 클라이언트 IP가 LAN(사설 IP)인지 판별.
	 * LAN이면 WebRTC 추천, 외부면 HLS 추천.
	 */
	@GetMapping("/network-check")
	public ResponseEntity<Map<String, Object>> networkCheck(HttpServletRequest request) {
		String clientIp = request.getHeader("X-Forwarded-For");
		if (clientIp != null) {
			clientIp = clientIp.split(",")[0].trim();
		} else {
			clientIp = request.getRemoteAddr();
		}

		boolean isLocal = isPrivateIp(clientIp);
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("clientIp", clientIp);
		result.put("local", isLocal);
		result.put("recommendedMode", isLocal ? "webrtc" : "hls");
		// LAN이면 go2rtc 직접 연결 (프록시 경유하면 HLS 끊김)
		// 외부면 Spring Boot 프록시 경유
		result.put("hlsBaseUrl", isLocal
			? "http://" + request.getServerName() + ":1984/api"
			: "/go2rtc/api");
		return ResponseEntity.ok(result);
	}

	private boolean isPrivateIp(String ip) {
		try {
			InetAddress addr = InetAddress.getByName(ip);
			return addr.isSiteLocalAddress() || addr.isLoopbackAddress();
		} catch (Exception e) {
			return false;
		}
	}
}
