package com.cctv.webrtc.service;

import com.cctv.webrtc.config.AppProperties;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/**
 * go2rtc 프로세스 관리자
 * Spring Boot가 시작되면 go2rtc 바이너리를 자동 실행하고, 죽으면 재시작해주는 애
 */
@Service
public class ProcessManagerService {

	private static final Logger log = LoggerFactory.getLogger(ProcessManagerService.class);

	private final String binaryPath;
	private final String configPath;
	private Process process;
	// 사용자가 의도대로 종료하는 거라는 flag, 해당 flag가 없으면 Spring Boot 종료시 go2rtc가 꺼지는데 이때, "비정상 종료"로 인식해서 재시작하려고 함 
	private volatile boolean shuttingDown = false;

	public ProcessManagerService(AppProperties properties) {
		this.binaryPath = properties.go2rtc().binary();
		this.configPath = properties.go2rtc().config();
	}

	@EventListener(ApplicationReadyEvent.class) // Spring Boot가 완전이 뜨면 실행하도록 함
	public void startGo2Rtc() {
		launchProcess(); // - go2rtc 실행
	}

	private void launchProcess() {
		try {
			Path binary = Path.of(binaryPath).toAbsolutePath();
			Path config = Path.of(configPath).toAbsolutePath();

			log.info("Starting go2rtc: binary={}, config={}", binary, config);
			
			// 터미널에서 ./go2rtc -config ./go2rtc.yml 치는 것과 동일함
			ProcessBuilder pb = new ProcessBuilder(binary.toString(), "-config", config.toString());
			pb.redirectErrorStream(true);

			// .env 파일에서 환경변수 로드 → go2rtc 프로세스에 전달
			loadEnvFile(pb.environment());

			process = pb.start();

			// go2rtc 로그를 Spring 로그에 합쳐서 출력(Virtual Thread로 go2rtc 로그 수집하는 방식)
			Thread.startVirtualThread(() -> collectLogs(process));

			// go2rtc가 갑자기 죽으면 5초 후 자동 재시작
			process.onExit().thenAccept(p -> {
				if (!shuttingDown) {
					log.warn("go2rtc exited with code {}. Restarting in 5 seconds...", p.exitValue());
					try {
						Thread.sleep(5000);
						launchProcess();
					} catch (InterruptedException e) {
						Thread.currentThread().interrupt();
					}
				}
			});

			log.info("go2rtc started (PID: {})", process.pid());
		} catch (IOException e) {
			log.error("Failed to start go2rtc", e);
		}
	}

	private void collectLogs(Process proc) {
		try (BufferedReader reader = proc.inputReader()) {
			String line;
			while ((line = reader.readLine()) != null) {
				log.info("[go2rtc] {}", line);
			}
		} catch (IOException e) {
			if (!shuttingDown) {
				log.error("Error reading go2rtc logs", e);
			}
		}
	}


	@PreDestroy // spring boot가 종료가 될 때, go2rtc도 같이 정리함(SIGTERM → 5초 대기 → 강제 종료)
	public void stopGo2Rtc() {
		shuttingDown = true;
		if (process != null && process.isAlive()) {
			log.info("Stopping go2rtc (PID: {})...", process.pid());
			process.destroy();
			try {
				boolean exited = process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
				if (!exited) {
					log.warn("go2rtc did not exit gracefully, force killing...");
					process.destroyForcibly();
				}
			} catch (InterruptedException e) {
				process.destroyForcibly();
				Thread.currentThread().interrupt();
			}
			log.info("go2rtc stopped.");
		}
	}

	/**
	 * .env 파일을 읽어서 환경변수 Map에 추가
	 * go2rtc.yml에서 ${VAR} 형태로 참조하는 값들을 주입
	 */
	private void loadEnvFile(Map<String, String> environment) {
		Path envPath = Path.of(".env").toAbsolutePath();
		if (!Files.exists(envPath)) {
			log.warn(".env 파일 없음: {}. go2rtc에 환경변수가 전달되지 않습니다.", envPath);
			return;
		}
		try {
			Files.readAllLines(envPath).stream()
					.map(String::trim)
					.filter(line -> !line.isEmpty() && !line.startsWith("#"))
					.filter(line -> line.contains("="))
					.forEach(line -> {
						int idx = line.indexOf('=');
						String key = line.substring(0, idx).trim();
						String value = line.substring(idx + 1).trim();
						environment.put(key, value);
					});
			log.info(".env 로드 완료: {}", envPath);
		} catch (IOException e) {
			log.error(".env 파일 읽기 실패", e);
		}
	}

	public boolean isRunning() {
		return process != null && process.isAlive();
	}

	public long getPid() {
		return (process != null && process.isAlive()) ? process.pid() : -1;
	}
}
