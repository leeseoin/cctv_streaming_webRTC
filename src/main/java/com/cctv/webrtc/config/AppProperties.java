package com.cctv.webrtc.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app")   // yml 파일에서 "app:" 아래를 매핑
public record AppProperties(Go2Rtc go2rtc, Camera camera) {

	public record Go2Rtc(String binary, String config, String apiUrl) {
	}

	public record Camera(String ip, int isapiPort, String isapiUser, String isapiPass,
					   int onvifPort, String onvifUser, String onvifPass) {
	}
}
