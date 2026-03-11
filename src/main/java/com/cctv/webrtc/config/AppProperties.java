package com.cctv.webrtc.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app")
public record AppProperties(Go2Rtc go2rtc) {

	public record Go2Rtc(String binary, String config, String apiUrl) {
	}
}
