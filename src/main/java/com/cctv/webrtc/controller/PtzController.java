package com.cctv.webrtc.controller;

import com.cctv.webrtc.service.PtzService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * PTZ 제어 API
 * POST /api/ptz/{id}/move  — 연속 이동 (pan/tilt/zoom)
 * POST /api/ptz/{id}/stop  — 정지
 */
@RestController
@RequestMapping("/api/ptz")
public class PtzController {

	private final PtzService ptzService;

	public PtzController(PtzService ptzService) {
		this.ptzService = ptzService;
	}

	@PostMapping("/{id}/move")
	public ResponseEntity<Map<String, String>> move(
			@PathVariable String id,
			@RequestBody MoveRequest request) {

		ptzService.continuousMove(request.pan(), request.tilt(), request.zoom());
		return ResponseEntity.ok(Map.of("status", "ok", "camera", id));
	}

	@PostMapping("/{id}/stop")
	public ResponseEntity<Map<String, String>> stop(@PathVariable String id) {
		ptzService.stop();
		return ResponseEntity.ok(Map.of("status", "ok", "camera", id));
	}

	record MoveRequest(int pan, int tilt, int zoom) {}
}
