package com.cctv.webrtc.model;

import java.time.Instant;

/**
 * 스트리밍 세션 정보.
 * go2rtc consumer 1개 = StreamSession 1개.
 */
public class StreamSession {

	private final String sessionKey;   // cameraId + ":" + clientIp + ":" + protocol
	private final String cameraId;
	private final String clientIp;
	private final String protocol;     // webrtc, hls, rtsp 등
	private final Instant startTime;

	private volatile Instant endTime;
	private volatile long rxBytes;
	private volatile long txBytes;

	public StreamSession(String sessionKey, String cameraId, String clientIp, String protocol) {
		this.sessionKey = sessionKey;
		this.cameraId = cameraId;
		this.clientIp = clientIp;
		this.protocol = protocol;
		this.startTime = Instant.now();
	}

	public void close() {
		this.endTime = Instant.now();
	}

	public long getDurationSeconds() {
		Instant end = endTime != null ? endTime : Instant.now();
		return end.getEpochSecond() - startTime.getEpochSecond();
	}

	// --- getters ---

	public String getSessionKey() { return sessionKey; }
	public String getCameraId() { return cameraId; }
	public String getClientIp() { return clientIp; }
	public String getProtocol() { return protocol; }
	public Instant getStartTime() { return startTime; }
	public Instant getEndTime() { return endTime; }
	public long getRxBytes() { return rxBytes; }
	public long getTxBytes() { return txBytes; }

	public void setRxBytes(long rxBytes) { this.rxBytes = rxBytes; }
	public void setTxBytes(long txBytes) { this.txBytes = txBytes; }
}
