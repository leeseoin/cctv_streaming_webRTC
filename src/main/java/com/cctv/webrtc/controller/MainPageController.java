package com.cctv.webrtc.controller;

import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ResponseBody;

import java.nio.charset.StandardCharsets;

@Controller
public class MainPageController {

    private static final MediaType TEXT_HTML_UTF8 =
            new MediaType("text", "html", StandardCharsets.UTF_8);

    /**
     * 기본적으로 spring boot는 static/index.html로 가게 됨
     * "/"과 "/index.html"로 접근 할 시, 404 error 발생하도록 처리함
     */
    @GetMapping({"/", "/index.html"})
    @ResponseBody
    public ResponseEntity<Void> root() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
    }
    
    /**
     * {등록된 도메인}/mainpage/index.html로만 접근 가능하도록 처리함
     * 
     */
    @GetMapping("/mainpage/index.html")
    @ResponseBody
    public ResponseEntity<Resource> mainPage() {
        Resource resource = new ClassPathResource("static/index.html");
        return ResponseEntity.ok()
                .contentType(TEXT_HTML_UTF8)
                .body(resource);
    }
}
