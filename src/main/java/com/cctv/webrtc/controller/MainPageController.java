package com.cctv.webrtc.controller;

import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ResponseBody;

import java.nio.charset.StandardCharsets;

/**
 * index.html 접근 제어:
 *   /                        → redirect /mainpage/index.html
 *   /index.html              → redirect /mainpage/index.html (직접 접근 차단)
 *   /mainpage/index.html     → static/index.html 직접 서빙 (URL 유지)
 *
 * forward: 방식은 DispatcherServlet을 재진입해 무한 루프 발생 → ClassPathResource로 직접 반환.
 */
@Controller
public class MainPageController {

    private static final MediaType TEXT_HTML_UTF8 =
            new MediaType("text", "html", StandardCharsets.UTF_8);

    @GetMapping({"/", "/index.html"})
    public String root() {
        return "redirect:/mainpage/index.html";
    }

    @GetMapping("/mainpage/index.html")
    @ResponseBody
    public ResponseEntity<Resource> mainPage() {
        Resource resource = new ClassPathResource("static/index.html");
        return ResponseEntity.ok()
                .contentType(TEXT_HTML_UTF8)
                .body(resource);
    }
}
