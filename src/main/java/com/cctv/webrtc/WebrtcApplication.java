package com.cctv.webrtc;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

@SpringBootApplication        // Spring Boot 어플리케이션이라고 선언
@ConfigurationPropertiesScan  // config/AppProperties 같은 설정 클래스를 자동으로 찾아서 등록
@EnableScheduling             // @Scheduled 어노테이션 활성화 (SessionTracker 폴링용)
public class WebrtcApplication {

	public static void main(String[] args) {
		loadEnvFile();
		SpringApplication.run(WebrtcApplication.class, args);
	}

	/**
	 * .env 파일의 환경변수를 System properties로 로드
	 * application.yml에서 ${VAR:default} 형태로 참조 가능
	 */
	private static void loadEnvFile() {
		Path envPath = Path.of(".env").toAbsolutePath();
		if (!Files.exists(envPath)) return;
		try {
			Files.readAllLines(envPath).stream()
					.map(String::trim)
					.filter(line -> !line.isEmpty() && !line.startsWith("#"))
					.filter(line -> line.contains("="))
					.forEach(line -> {
						int idx = line.indexOf('=');
						String key = line.substring(0, idx).trim();
						String value = line.substring(idx + 1).trim();
						if (System.getProperty(key) == null) {
							System.setProperty(key, value);
						}
					});
		} catch (IOException e) {
			System.err.println(".env 파일 로드 실패: " + e.getMessage());
		}
	}
}
