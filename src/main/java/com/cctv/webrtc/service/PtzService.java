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
 * ONVIF PTZ 제어 (SOAP over HTTP + Digest 인증)
 * - ContinuousMove: 상하좌우 이동 + 줌인/줌아웃
 * - Stop: 정지
 */
@Service
public class PtzService {

	private static final Logger log = LoggerFactory.getLogger(PtzService.class);

	private final String cameraIp;
	private final int onvifPort;
	private final String username;
	private final String password;
	private final HttpClient httpClient;
	private final AtomicInteger nc = new AtomicInteger(0);
	private String profileToken;

	public PtzService(AppProperties properties) {
		var cam = properties.camera();
		this.cameraIp = cam.ip().trim();
		this.onvifPort = cam.onvifPort();
		this.username = cam.onvifUser().trim();
		this.password = cam.onvifPass().trim();
		this.httpClient = HttpClient.newHttpClient();
		this.profileToken = fetchProfileToken();
	}

	/**
	 * 연속 이동 (ContinuousMove)
	 * @param pan   좌(-) / 우(+), 범위: -100 ~ 100
	 * @param tilt  하(-) / 상(+), 범위: -100 ~ 100
	 * @param zoom  축소(-) / 확대(+), 범위: -100 ~ 100
	 */
	public void continuousMove(int pan, int tilt, int zoom) {
		float panSpeed = pan / 100.0f;
		float tiltSpeed = tilt / 100.0f;
		float zoomSpeed = zoom / 100.0f;

		String soap = """
				<?xml version="1.0" encoding="UTF-8"?>
				<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
				            xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"
				            xmlns:tt="http://www.onvif.org/ver10/schema">
				  <s:Body>
				    <tptz:ContinuousMove>
				      <tptz:ProfileToken>%s</tptz:ProfileToken>
				      <tptz:Velocity>
				        <tt:PanTilt x="%.2f" y="%.2f"/>
				        <tt:Zoom x="%.2f"/>
				      </tptz:Velocity>
				    </tptz:ContinuousMove>
				  </s:Body>
				</s:Envelope>
				""".formatted(profileToken, panSpeed, tiltSpeed, zoomSpeed);

		sendOnvifCommand("/onvif/ptz_service", soap, "ContinuousMove");
	}

	/**
	 * 정지
	 */
	public void stop() {
		String soap = """
				<?xml version="1.0" encoding="UTF-8"?>
				<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
				            xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
				  <s:Body>
				    <tptz:Stop>
				      <tptz:ProfileToken>%s</tptz:ProfileToken>
				      <tptz:PanTilt>true</tptz:PanTilt>
				      <tptz:Zoom>true</tptz:Zoom>
				    </tptz:Stop>
				  </s:Body>
				</s:Envelope>
				""".formatted(profileToken);

		sendOnvifCommand("/onvif/ptz_service", soap, "Stop");
	}

	/**
	 * ONVIF 명령 전송 (Digest 인증)
	 */
	private void sendOnvifCommand(String path, String soapBody, String action) {
		try {
			URI uri = URI.create("http://" + cameraIp + ":" + onvifPort + path);

			// 1단계: 인증 없이 요청 → 401 + WWW-Authenticate
			HttpRequest firstRequest = HttpRequest.newBuilder()
					.uri(uri)
					.header("Content-Type", "application/soap+xml; charset=utf-8")
					.POST(HttpRequest.BodyPublishers.ofString(soapBody))
					.build();

			HttpResponse<String> firstResponse = httpClient.send(firstRequest, HttpResponse.BodyHandlers.ofString());

			if (firstResponse.statusCode() != 401) {
				handleResponse(action, firstResponse);
				return;
			}

			// 2단계: Digest Authorization 생성
			String wwwAuth = firstResponse.headers()
					.firstValue("WWW-Authenticate")
					.orElse(null);

			if (wwwAuth == null || !wwwAuth.startsWith("Digest")) {
				log.error("[ONVIF] {} Digest 인증 헤더 없음", action);
				return;
			}

			String authHeader = buildDigestAuth(wwwAuth, "POST", path);

			// 3단계: Authorization 포함해서 재요청
			HttpRequest authRequest = HttpRequest.newBuilder()
					.uri(uri)
					.header("Content-Type", "application/soap+xml; charset=utf-8")
					.header("Authorization", authHeader)
					.POST(HttpRequest.BodyPublishers.ofString(soapBody))
					.build();

			HttpResponse<String> authResponse = httpClient.send(authRequest, HttpResponse.BodyHandlers.ofString());
			handleResponse(action, authResponse);

		} catch (Exception e) {
			log.error("[ONVIF] {} 오류", action, e);
		}
	}

	/**
	 * Profile Token 자동 조회
	 */
	private String fetchProfileToken() {
		try {
			String soap = """
					<?xml version="1.0" encoding="UTF-8"?>
					<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
					            xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
					  <s:Body>
					    <trt:GetProfiles/>
					  </s:Body>
					</s:Envelope>
					""";

			URI uri = URI.create("http://" + cameraIp + ":" + onvifPort + "/onvif/media_service");

			// 1단계: 인증 없이 → 401
			HttpRequest firstRequest = HttpRequest.newBuilder()
					.uri(uri)
					.header("Content-Type", "application/soap+xml; charset=utf-8")
					.POST(HttpRequest.BodyPublishers.ofString(soap))
					.build();

			HttpResponse<String> firstResponse = httpClient.send(firstRequest, HttpResponse.BodyHandlers.ofString());

			if (firstResponse.statusCode() != 401) {
				return parseProfileToken(firstResponse.body());
			}

			// 2단계: Digest 인증
			String wwwAuth = firstResponse.headers()
					.firstValue("WWW-Authenticate")
					.orElse(null);

			if (wwwAuth == null || !wwwAuth.startsWith("Digest")) {
				log.warn("[ONVIF] Profile Token 조회: Digest 헤더 없음, 기본값 사용");
				return "Profile_1";
			}

			String authHeader = buildDigestAuth(wwwAuth, "POST", "/onvif/media_service");

			HttpRequest authRequest = HttpRequest.newBuilder()
					.uri(uri)
					.header("Content-Type", "application/soap+xml; charset=utf-8")
					.header("Authorization", authHeader)
					.POST(HttpRequest.BodyPublishers.ofString(soap))
					.build();

			HttpResponse<String> authResponse = httpClient.send(authRequest, HttpResponse.BodyHandlers.ofString());
			return parseProfileToken(authResponse.body());

		} catch (Exception e) {
			log.warn("[ONVIF] Profile Token 조회 실패, 기본값 사용: {}", e.getMessage());
			return "Profile_1";
		}
	}

	private String parseProfileToken(String body) {
		var matcher = java.util.regex.Pattern.compile("token=\"([^\"]+)\"").matcher(body);
		if (matcher.find()) {
			String token = matcher.group(1);
			log.info("[ONVIF] Profile Token 조회 성공: {}", token);
			return token;
		}
		log.warn("[ONVIF] Profile Token 미발견, 기본값 사용");
		return "Profile_1";
	}

	private void handleResponse(String action, HttpResponse<String> response) {
		if (response.statusCode() >= 200 && response.statusCode() < 300) {
			log.info("[ONVIF] {} 성공", action);
		} else {
			log.warn("[ONVIF] {} 실패: HTTP {} - {}", action, response.statusCode(),
					response.body().substring(0, Math.min(response.body().length(), 200)));
		}
	}

	/**
	 * Digest Authorization 헤더 생성
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

		String ha1 = md5(username + ":" + realm + ":" + password);
		String ha2 = md5(method + ":" + digestUri);

		String response;
		if (qop != null && qop.contains("auth")) {
			response = md5(ha1 + ":" + nonce + ":" + ncHex + ":" + cnonce + ":auth:" + ha2);
		} else {
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

	private Map<String, String> parseDigestChallenge(String header) {
		Map<String, String> params = new HashMap<>();
		String content = header.substring(header.indexOf(' ') + 1);
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
