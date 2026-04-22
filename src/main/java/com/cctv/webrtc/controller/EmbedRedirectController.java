package com.cctv.webrtc.controller;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.context.annotation.Profile;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.regex.Pattern;

/**
 * iptest.devsp.kr/embed.html 요청 시, 주소창은 그대로 유지하면서
 * On-Premise go2rtc 도메인(stream1/stream2/...)을 iframe으로 감싸 반환.
 *
 * 호스트 지정: ?to=<URL-safe Base64(hostname)>
 *   예) stream2.flexformular.com → URL-safe base64 → c3RyZWFtMi5mbGV4Zm9ybXVsYXIuY29t
 *   미지정 시 기본값 stream1.
 *
 * URL-safe base64: `+`→`-`, `/`→`_`, 패딩(`=`) 생략 가능. Java `Base64.getUrlDecoder()`.
 *
 * @Profile("docker") — AWS-A에서만 활성화 (On-Premise에선 Nginx가 직접 서빙)
 */
@Controller
@Profile("docker")
public class EmbedRedirectController {

    private static final String DEFAULT_HOST = "stream1.flexformular.com";
    private static final int ONPREM_PORT = 8443;
    private static final String ALLOWED_SUFFIX = ".flexformular.com";
    private static final Pattern HOST_PATTERN = Pattern.compile("^[a-zA-Z0-9.-]+$");

    @GetMapping(value = "/embed.html", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> embed(HttpServletRequest req) {
        return wrapWithIframe("/embed.html", req);
    }

    @GetMapping(value = "/dashboard-real.html", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> dashboardReal(HttpServletRequest req) {
        return wrapWithIframe("/dashboard-real.html", req);
    }

    private ResponseEntity<String> wrapWithIframe(String path, HttpServletRequest req) {
        String host = resolveHost(req.getParameter("to"));

        // iframe src = https://{host}:8443{path}?{기존쿼리 - to}
        StringBuilder iframeSrc = new StringBuilder("https://")
                .append(host).append(':').append(ONPREM_PORT).append(path);
        String query = stripToParam(req.getQueryString());
        if (query != null && !query.isEmpty()) iframeSrc.append('?').append(query);

        String html = "<!doctype html>\n" +
                "<html lang=\"ko\"><head><meta charset=\"UTF-8\">" +
                "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
                "<title>CCTV</title>" +
                "<style>html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}" +
                "iframe{width:100%;height:100%;border:0;display:block}</style>" +
                "</head><body>" +
                "<iframe src=\"" + escapeHtml(iframeSrc.toString()) + "\" " +
                "allow=\"autoplay; fullscreen; microphone\" allowfullscreen></iframe>" +
                "</body></html>";

        return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(html);
    }

    private String stripToParam(String query) {
        if (query == null) return null;
        StringBuilder out = new StringBuilder();
        for (String pair : query.split("&")) {
            if (pair.isEmpty() || pair.startsWith("to=") || pair.equals("to")) continue;
            if (out.length() > 0) out.append('&');
            out.append(pair);
        }
        return out.toString();
    }

    private String resolveHost(String toParam) {
        if (toParam == null || toParam.isEmpty()) return DEFAULT_HOST;
        try {
            // URL-safe base64: + → -, / → _, 패딩 생략 허용
            String host = new String(Base64.getUrlDecoder().decode(toParam), StandardCharsets.UTF_8).trim();
            if (!HOST_PATTERN.matcher(host).matches()) return DEFAULT_HOST;
            if (!host.endsWith(ALLOWED_SUFFIX)) return DEFAULT_HOST;
            return host;
        } catch (IllegalArgumentException e) {
            return DEFAULT_HOST;
        }
    }

    private String escapeHtml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }
}
