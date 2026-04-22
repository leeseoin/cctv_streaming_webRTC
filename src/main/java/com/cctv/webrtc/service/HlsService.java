package com.cctv.webrtc.service;

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

/**
 * FFmpeg HLS 프로세스 관리.
 * go2rtc RTSP 리스트림(8554) → FFmpeg -c copy → HLS 파일 생성.
 *
 * go2rtc가 카메라 RTSP를 받아서 8554로 리스트림하면,
 * FFmpeg이 그걸 받아서 4초 segment의 정상적인 HLS로 변환.
 */
@Service
@org.springframework.context.annotation.Profile("ffmpeg-hls") // FFmpeg HLS 필요할 때만 활성화
public class HlsService {

	private static final Logger log = LoggerFactory.getLogger(HlsService.class);

	private Process ffmpegProcess;
	private volatile boolean shuttingDown = false;

	@EventListener(ApplicationReadyEvent.class)
	public void startHls() {
		// go2rtc 시작 후 잠시 대기
		Thread.startVirtualThread(() -> {
			try {
				Thread.sleep(3000); // go2rtc가 RTSP 연결할 시간
				launchFfmpeg("cam01");
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
		});
	}

	private void launchFfmpeg(String cameraId) {
		try {
			Path hlsDir = Path.of("hls").toAbsolutePath();
			Files.createDirectories(hlsDir);

			String rtspUrl = "rtsp://localhost:8554/" + cameraId;
			String outputPath = hlsDir.resolve(cameraId + ".m3u8").toString();

			log.info("Starting FFmpeg HLS: {} → {}", rtspUrl, outputPath);

			ProcessBuilder pb = new ProcessBuilder(
				"ffmpeg",
				"-i", rtspUrl,
				"-c", "copy",
				"-f", "hls",
				"-hls_time", "4",
				"-hls_list_size", "5",
				"-hls_flags", "delete_segments+append_list",
				outputPath
			);
			pb.redirectErrorStream(true);

			ffmpegProcess = pb.start();

			// FFmpeg 로그 수집
			Thread.startVirtualThread(() -> collectLogs(ffmpegProcess));

			// 비정상 종료 시 재시작
			ffmpegProcess.onExit().thenAccept(p -> {
				if (!shuttingDown) {
					log.warn("FFmpeg exited with code {}. Restarting in 5 seconds...", p.exitValue());
					try {
						Thread.sleep(5000);
						launchFfmpeg(cameraId);
					} catch (InterruptedException e) {
						Thread.currentThread().interrupt();
					}
				}
			});

			log.info("FFmpeg HLS started (PID: {})", ffmpegProcess.pid());
		} catch (IOException e) {
			log.error("Failed to start FFmpeg", e);
		}
	}

	private void collectLogs(Process proc) {
		try (BufferedReader reader = proc.inputReader()) {
			String line;
			while ((line = reader.readLine()) != null) {
				log.debug("[ffmpeg] {}", line);
			}
		} catch (IOException e) {
			if (!shuttingDown) {
				log.debug("FFmpeg log read error: {}", e.getMessage());
			}
		}
	}

	@PreDestroy
	public void stopHls() {
		shuttingDown = true;
		if (ffmpegProcess != null && ffmpegProcess.isAlive()) {
			log.info("Stopping FFmpeg (PID: {})...", ffmpegProcess.pid());
			ffmpegProcess.destroy();
			try {
				boolean exited = ffmpegProcess.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
				if (!exited) {
					ffmpegProcess.destroyForcibly();
				}
			} catch (InterruptedException e) {
				ffmpegProcess.destroyForcibly();
				Thread.currentThread().interrupt();
			}
			log.info("FFmpeg stopped.");
		}
	}

	public boolean isRunning() {
		return ffmpegProcess != null && ffmpegProcess.isAlive();
	}
}
