package com.cctv.webrtc.service;

import com.cctv.webrtc.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

@Service
public class Go2RtcService {

	private static final Logger log = LoggerFactory.getLogger(Go2RtcService.class);

	private final HttpClient httpClient;
	private final String apiUrl;

	public Go2RtcService(AppProperties properties) {
		this.httpClient = HttpClient.newHttpClient();   // Java 내장 HTTP 클라이언트
		this.apiUrl = properties.go2rtc().apiUrl();     // localhost:1984 → application.yml 파일 참조하는 구조
	}

	/**
	 * SDP offer를 go2rtc에 전달하고 SDP answer를 받아온다.
	 */
	public String webrtcOffer(String streamName, String sdpOffer) {
		try {
			HttpRequest request = HttpRequest.newBuilder()
				.uri(URI.create(apiUrl + "/api/webrtc?src=" + streamName))
				.header("Content-Type", "application/sdp")
				.POST(HttpRequest.BodyPublishers.ofString(sdpOffer))
				.build();

			HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
			
			if (response.statusCode() < 200 || response.statusCode() >= 300) {
				log.error("go2rtc webrtc offer failed: status={}, body={}", response.statusCode(), response.body());
				throw new RuntimeException("go2rtc returned " + response.statusCode());
			}

			return response.body();
		} catch (Exception e) {
			log.error("go2rtc webrtc offer error", e);
			throw new RuntimeException("Failed to connect to go2rtc", e);
		}
	}

	/**
	 * go2rtc 스트림 목록 조회
	 */
	public String getStreams() {
		try {
			HttpRequest request = HttpRequest.newBuilder()
				.uri(URI.create(apiUrl + "/api/streams"))
				.GET()
				.build();

			HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
			return response.body();
		} catch (java.net.ConnectException e) {
			log.debug("go2rtc 미연결 (시작 대기 중)");
			throw new RuntimeException("go2rtc not ready", e);
		} catch (Exception e) {
			log.error("go2rtc getStreams error", e);
			throw new RuntimeException("Failed to get streams from go2rtc", e);
		}
	}
}
