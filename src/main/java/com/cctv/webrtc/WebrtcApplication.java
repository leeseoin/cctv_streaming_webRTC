package com.cctv.webrtc;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication        // Spring Boot 어플리케이션이라고 선언
@ConfigurationPropertiesScan  // config/AppProperties 같은 설정 클래스를 자동으로 찾아서 등록
public class WebrtcApplication {

	public static void main(String[] args) {
		SpringApplication.run(WebrtcApplication.class, args);
	}

}
