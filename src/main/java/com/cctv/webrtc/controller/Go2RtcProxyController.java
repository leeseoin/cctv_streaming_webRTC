package com.cctv.webrtc.controller;

import com.cctv.webrtc.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.*;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;


/**
 * go2rtc API 리버스 프록시
 * 브라우저가 Java 포트(8085)를 통해 go2rtc의 MP4 스트림, HLS 등에 접근할 수 있게 해줌.
 *
 * 예시:
 *   브라우저 → GET /go2rtc/api/stream.mp4?src=cam01
 *           → go2rtc  GET http://localhost:1984/api/stream.mp4?src=cam01
 *           → 스트리밍 프록시 (청크 단위 전달)
 */
@RestController
@RequestMapping("/go2rtc")
public class Go2RtcProxyController {

	private static final Logger log = LoggerFactory.getLogger(Go2RtcProxyController.class);

	private final HttpClient httpClient;
	private final String apiUrl; // http://localhost:1984

	public Go2RtcProxyController(AppProperties properties) {
		this.httpClient = HttpClient.newHttpClient();
		this.apiUrl = properties.go2rtc().apiUrl();
	}

	/**
	 * go2rtc API 스트리밍 프록시
	 * MP4 같은 무한 스트림도 청크 단위로 전달 (메모리에 전체를 버퍼링하지 않음)
	 */
	@GetMapping("/api/**")
	public void proxyStream(HttpServletRequest request, HttpServletResponse response) {
		// /go2rtc/api/stream.mp4 → /api/stream.mp4
		String path = request.getRequestURI().substring("/go2rtc".length());
		String query = request.getQueryString();
		String targetUrl = apiUrl + path + (query != null ? "?" + query : "");

		try {
			HttpRequest proxyRequest = HttpRequest.newBuilder()
				.uri(URI.create(targetUrl))
				.GET()
				.build();

			// InputStream으로 받아서 청크 단위로 전달 (스트리밍)
			HttpResponse<InputStream> upstream = httpClient.send(
				proxyRequest, HttpResponse.BodyHandlers.ofInputStream()
			);

			// 상태 코드 전달
			response.setStatus(upstream.statusCode());

			// Content-Type 전달
			upstream.headers().firstValue("Content-Type")
				.ifPresent(ct -> response.setContentType(ct));
			response.setHeader("Access-Control-Allow-Origin", "*");

			// 스트리밍: go2rtc → Java → 브라우저 (8KB 버퍼)
			try (InputStream in = upstream.body();
				 OutputStream out = response.getOutputStream()) {
				byte[] buffer = new byte[8192];
				int bytesRead;
				while ((bytesRead = in.read(buffer)) != -1) {
					out.write(buffer, 0, bytesRead);
					out.flush(); // 즉시 브라우저로 전달
				}
			}

		} catch (Exception e) {
			// 클라이언트가 연결 끊으면 정상적으로 발생 (로그 레벨 낮춤)
			if (e.getMessage() != null && e.getMessage().contains("Broken pipe")) {
				log.debug("클라이언트 연결 종료: {}", targetUrl);
			} else {
				log.error("go2rtc 프록시 실패: {}", targetUrl, e);
				try {
					if (!response.isCommitted()) {
						response.setStatus(502);
					}
				} catch (Exception ignored) {}
			}
		}
	}
}
