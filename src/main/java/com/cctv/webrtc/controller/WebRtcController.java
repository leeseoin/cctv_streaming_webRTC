package com.cctv.webrtc.controller;

import com.cctv.webrtc.service.Go2RtcService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController                     // JSON 반환하는 컨트롤러
@RequestMapping("/api/cameras")     // 모든 url이 '/api/cameras' 로 시작함
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
		
		// {id}는 url에서 카메라 이름 param(예: cam01)
		// 동작 순서1: 브라우저가 보낸 SCP offer를 꺼내서
		String sdpOffer = offer.get("sdp");
		// 동작 순서2: go2rtc에 전달하고 answer를 받아서
		String sdpAnswer = go2RtcService.webrtcOffer(id, sdpOffer);
        // 동작 순서3: 브라우저에 돌려주는 방식
		return ResponseEntity.ok(Map.of(
			"type", "answer",
			"sdp", sdpAnswer
		));
	}

	/**
	 * go2rtc 스트림 목록 조회(go2rtc에 등록된 카메라 리스트)
	 */
	@GetMapping
	public ResponseEntity<String> getStreams() {
		return ResponseEntity.ok(go2RtcService.getStreams());
	}
}
