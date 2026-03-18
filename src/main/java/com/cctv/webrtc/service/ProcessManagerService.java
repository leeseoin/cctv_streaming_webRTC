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
import java.nio.file.Path;

@Service
public class ProcessManagerService {

	private static final Logger log = LoggerFactory.getLogger(ProcessManagerService.class);

	private final String binaryPath;
	private final String configPath;
	private Process process;
	private volatile boolean shuttingDown = false;

	public ProcessManagerService(AppProperties properties) {
		this.binaryPath = properties.go2rtc().binary();
		this.configPath = properties.go2rtc().config();
	}

	@EventListener(ApplicationReadyEvent.class)
	public void startGo2Rtc() {
		launchProcess();
	}

	private void launchProcess() {
		try {
			Path binary = Path.of(binaryPath).toAbsolutePath();
			Path config = Path.of(configPath).toAbsolutePath();

			log.info("Starting go2rtc: binary={}, config={}", binary, config);

			ProcessBuilder pb = new ProcessBuilder(binary.toString(), "-config", config.toString());
			pb.redirectErrorStream(true);
			process = pb.start();

			// Virtual Thread로 go2rtc 로그 수집
			Thread.startVirtualThread(() -> collectLogs(process));

			// 비정상 종료 시 재시작
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

	@PreDestroy
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

	public boolean isRunning() {
		return process != null && process.isAlive();
	}

}
