package com.cctv.webrtc.controller;

import com.cctv.webrtc.service.Go2RtcService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/cameras")
public class WebRtcController {

	private final Go2RtcService go2RtcService;

	public WebRtcController(Go2RtcService go2RtcService) {
		this.go2RtcService = go2RtcService;
	}

	/**
	 * WebRTC 시그널링 프록시
	 * 브라우저 SDP offer → go2rtc → SDP answer 반환
	 */
	@PostMapping(value = "/{id}/webrtc", consumes = MediaType.APPLICATION_JSON_VALUE)
	public ResponseEntity<Map<String, String>> webrtcOffer(
			@PathVariable String id,
			@RequestBody Map<String, String> offer) {

		String sdpOffer = offer.get("sdp");
		String sdpAnswer = go2RtcService.webrtcOffer(id, sdpOffer);

		return ResponseEntity.ok(Map.of(
			"type", "answer",
			"sdp", sdpAnswer
		));
	}

	/**
	 * go2rtc 스트림 목록 조회
	 */
	@GetMapping
	public ResponseEntity<String> getStreams() {
		return ResponseEntity.ok(go2RtcService.getStreams());
	}
}
