package com.cctv.webrtc.controller;

import com.cctv.webrtc.service.ProcessManagerService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.OperatingSystemMXBean;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/monitor")
public class MonitorController {

	private final ProcessManagerService processManagerService;

	public MonitorController(ProcessManagerService processManagerService) {
		this.processManagerService = processManagerService;
	}

	/**
	 * JVM + go2rtc 리소스 사용량 조회
	 */
	@GetMapping
	public ResponseEntity<Map<String, Object>> getSystemStatus() {
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("jvm", getJvmStats());
		result.put("go2rtc", getGo2RtcStats());
		return ResponseEntity.ok(result);
	}

	private Map<String, Object> getJvmStats() {
		Map<String, Object> jvm = new LinkedHashMap<>();
		Runtime runtime = Runtime.getRuntime();
		MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
		OperatingSystemMXBean osBean = ManagementFactory.getOperatingSystemMXBean();

		long heapUsed = memoryBean.getHeapMemoryUsage().getUsed();
		long heapMax = memoryBean.getHeapMemoryUsage().getMax();

		jvm.put("heapUsedMB", heapUsed / 1024 / 1024);
		jvm.put("heapMaxMB", heapMax / 1024 / 1024);
		jvm.put("heapUsagePercent", heapMax > 0 ? Math.round((double) heapUsed / heapMax * 100) : 0);
		jvm.put("availableProcessors", runtime.availableProcessors());
		jvm.put("systemCpuLoad", Math.round(osBean.getSystemLoadAverage() * 100.0) / 100.0);
		jvm.put("threadCount", Thread.activeCount());

		// Java 프로세스 자체의 CPU 사용량 (ps 명령으로 조회)
		long jvmPid = ProcessHandle.current().pid();
		jvm.put("pid", jvmPid);
		try {
			ProcessBuilder pb = new ProcessBuilder("ps", "-p", String.valueOf(jvmPid), "-o", "pcpu=");
			Process proc = pb.start();
			try (BufferedReader reader = new BufferedReader(new InputStreamReader(proc.getInputStream()))) {
				String line = reader.readLine();
				if (line != null) {
					jvm.put("cpuPercent", Double.parseDouble(line.trim()));
				}
			}
		} catch (Exception e) {
			jvm.put("cpuPercent", -1);
		}

		return jvm;
	}

	private Map<String, Object> getGo2RtcStats() {
		Map<String, Object> stats = new LinkedHashMap<>();
		long pid = processManagerService.getPid();
		stats.put("running", processManagerService.isRunning());
		stats.put("pid", pid);

		if (pid > 0) {
			try {
				// macOS/Linux: ps 명령으로 go2rtc 프로세스의 CPU/메모리 조회
				ProcessBuilder pb = new ProcessBuilder("ps", "-p", String.valueOf(pid), "-o", "pcpu=,rss=,vsz=");
				Process proc = pb.start();
				try (BufferedReader reader = new BufferedReader(new InputStreamReader(proc.getInputStream()))) {
					String line = reader.readLine();
					if (line != null) {
						String[] parts = line.trim().split("\\s+");
						if (parts.length >= 3) {
							stats.put("cpuPercent", Double.parseDouble(parts[0]));
							stats.put("rssKB", Long.parseLong(parts[1]));
							stats.put("rssMB", Long.parseLong(parts[1]) / 1024);
							stats.put("vszKB", Long.parseLong(parts[2]));
						}
					}
				}
			} catch (Exception e) {
				stats.put("error", "Failed to read process stats: " + e.getMessage());
			}
		}

		return stats;
	}
}
