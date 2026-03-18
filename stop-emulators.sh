#!/bin/bash
# CCTV 에뮬레이터 전체 종료 스크립트

echo "=== 에뮬레이터 FFmpeg 프로세스 종료 ==="
pkill -f "ffmpeg.*sample.mp4.*rtsp://localhost:8553"
echo "완료"
