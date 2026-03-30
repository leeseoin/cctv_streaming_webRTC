package com.cctv.webrtc.service;

import com.cctv.webrtc.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Hikvision ISAPI를 이용한 PTZ 제어
 * PUT /ISAPI/PTZCtrl/channels/1/continuous — 연속 이동 (pan/tilt/zoom)
 * Digest 인증을 수동으로 처리 (Java HttpClient Authenticator가 PUT에서 안 되는 문제 우회)
 */
@Service
public class PtzService {

	private static final Logger log = LoggerFactory.getLogger(PtzService.class);

	private final String baseUrl;
	private final String username;
	private final String password;
	private final HttpClient httpClient;
	private final AtomicInteger nc = new AtomicInteger(0);

	public PtzService(AppProperties properties) {
		var cam = properties.camera();
		this.baseUrl = "http://" + cam.ip().trim() + ":" + cam.isapiPort();
		this.username = cam.isapiUser().trim();
		this.password = cam.isapiPass().trim();
		this.httpClient = HttpClient.newHttpClient();
	}

	/**
	 * 연속 이동 (ContinuousMove)
	 * @param pan   좌(-) / 우(+), 범위: -100 ~ 100
	 * @param tilt  하(-) / 상(+), 범위: -100 ~ 100
	 * @param zoom  축소(-) / 확대(+), 범위: -100 ~ 100
	 */
	public void continuousMove(int pan, int tilt, int zoom) {
		String xml = """
				<PTZData>
				  <pan>%d</pan>
				  <tilt>%d</tilt>
				  <zoom>%d</zoom>
				</PTZData>
				""".formatted(pan, tilt, zoom);

		sendPtzCommand("/ISAPI/PTZCtrl/channels/1/continuous", xml);
	}

	/**
	 * 정지 (pan=0, tilt=0, zoom=0 전송)
	 */
	public void stop() {
		continuousMove(0, 0, 0);
	}

	private void sendPtzCommand(String path, String xmlBody) {
		try {
			URI uri = URI.create(baseUrl + path);

			// 1단계: 인증 없이 요청 → 401 + WWW-Authenticate 헤더 받기
			HttpRequest firstRequest = HttpRequest.newBuilder()
					.uri(uri)
					.header("Content-Type", "application/xml")
					.PUT(HttpRequest.BodyPublishers.ofString(xmlBody))
					.build();

			HttpResponse<String> firstResponse = httpClient.send(firstRequest, HttpResponse.BodyHandlers.ofString());

			if (firstResponse.statusCode() != 401) {
				// 인증 필요 없이 성공한 경우
				handleResponse(path, firstResponse);
				return;
			}

			// 2단계: WWW-Authenticate 파싱 → Digest Authorization 헤더 생성
			String wwwAuth = firstResponse.headers()
					.firstValue("WWW-Authenticate")
					.orElse(null);

			log.info("[Digest] WWW-Authenticate: {}", wwwAuth);
			log.info("[Digest] 사용 계정: {}:{}", username, password);

			if (wwwAuth == null || !wwwAuth.startsWith("Digest")) {
				log.error("Digest 인증 헤더 없음: {}", firstResponse.headers().map());
				return;
			}

			String authHeader = buildDigestAuth(wwwAuth, "PUT", path);
			log.info("[Digest] Authorization: {}", authHeader);

			// 3단계: Authorization 헤더 포함해서 재요청
			HttpRequest authRequest = HttpRequest.newBuilder()
					.uri(uri)
					.header("Content-Type", "application/xml")
					.header("Authorization", authHeader)
					.PUT(HttpRequest.BodyPublishers.ofString(xmlBody))
					.build();

			HttpResponse<String> authResponse = httpClient.send(authRequest, HttpResponse.BodyHandlers.ofString());
			handleResponse(path, authResponse);

		} catch (Exception e) {
			log.error("PTZ 명령 전송 오류: {}", path, e);
		}
	}

	private void handleResponse(String path, HttpResponse<String> response) {
		if (response.statusCode() >= 200 && response.statusCode() < 300) {
			log.debug("PTZ 명령 성공: {}", path);
		} else {
			log.warn("PTZ 명령 실패: {} → HTTP {}: {}", path, response.statusCode(), response.body());
		}
	}

	/**
	 * WWW-Authenticate 헤더를 파싱하여 Digest Authorization 헤더 생성
	 */
	private String buildDigestAuth(String wwwAuth, String method, String digestUri) {
		Map<String, String> params = parseDigestChallenge(wwwAuth);

		String realm = params.get("realm");
		String nonce = params.get("nonce");
		String qop = params.get("qop");
		String opaque = params.get("opaque");

		int ncValue = nc.incrementAndGet();
		String ncHex = String.format("%08x", ncValue);
		String cnonce = Long.toHexString(System.nanoTime());

		// HA1 = MD5(username:realm:password)
		String ha1 = md5(username + ":" + realm + ":" + password);
		// HA2 = MD5(method:digestUri)
		String ha2 = md5(method + ":" + digestUri);

		String response;
		if (qop != null && qop.contains("auth")) {
			// response = MD5(HA1:nonce:nc:cnonce:qop:HA2)
			response = md5(ha1 + ":" + nonce + ":" + ncHex + ":" + cnonce + ":auth:" + ha2);
		} else {
			// response = MD5(HA1:nonce:HA2)
			response = md5(ha1 + ":" + nonce + ":" + ha2);
		}

		StringBuilder sb = new StringBuilder("Digest ");
		sb.append("username=\"").append(username).append("\", ");
		sb.append("realm=\"").append(realm).append("\", ");
		sb.append("nonce=\"").append(nonce).append("\", ");
		sb.append("uri=\"").append(digestUri).append("\", ");
		if (qop != null) {
			sb.append("qop=auth, ");
			sb.append("nc=").append(ncHex).append(", ");
			sb.append("cnonce=\"").append(cnonce).append("\", ");
		}
		sb.append("response=\"").append(response).append("\"");
		if (opaque != null) {
			sb.append(", opaque=\"").append(opaque).append("\"");
		}

		return sb.toString();
	}

	/**
	 * Digest 챌린지 파싱: key="value" 또는 key=value
	 */
	private Map<String, String> parseDigestChallenge(String header) {
		Map<String, String> params = new HashMap<>();
		// "Digest " 이후 부분
		String content = header.substring(header.indexOf(' ') + 1);

		// key="value" 패턴 매칭
		var matcher = java.util.regex.Pattern.compile("(\\w+)=[\"']?([^\"',]+)[\"']?").matcher(content);
		while (matcher.find()) {
			params.put(matcher.group(1), matcher.group(2));
		}
		return params;
	}

	private String md5(String input) {
		try {
			MessageDigest md = MessageDigest.getInstance("MD5");
			byte[] digest = md.digest(input.getBytes());
			StringBuilder sb = new StringBuilder();
			for (byte b : digest) {
				sb.append(String.format("%02x", b));
			}
			return sb.toString();
		} catch (Exception e) {
			throw new RuntimeException("MD5 실패", e);
		}
	}
}
