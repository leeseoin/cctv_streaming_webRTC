package com.cctv.webrtc.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.ContentNegotiationConfigurer;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.nio.file.Path;

/**
 * hls/ 디렉토리를 /hls/** URL로 서빙.
 * FFmpeg이 생성한 .m3u8 + .ts 파일을 브라우저에서 접근 가능하게 함.
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

	@Override
	public void addResourceHandlers(ResourceHandlerRegistry registry) {
		String hlsPath = Path.of("hls").toAbsolutePath().toUri().toString();
		registry.addResourceHandler("/hls/**")
			.addResourceLocations(hlsPath)
			.setCachePeriod(0);
	}

	@Override
	public void configureContentNegotiation(ContentNegotiationConfigurer configurer) {
		configurer
			.mediaType("m3u8", org.springframework.http.MediaType.parseMediaType("application/vnd.apple.mpegurl"))
			.mediaType("ts", org.springframework.http.MediaType.parseMediaType("video/MP2T"));
	}
}
