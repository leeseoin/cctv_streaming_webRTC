#!/bin/bash
# CCTV 에뮬레이터 40채널 시작 스크립트
# FFmpeg 40개가 sample.mp4를 무한 반복하며 mediamtx로 RTSP 송출

RTSP_SERVER="rtsp://localhost:8553"
VIDEO_FILE="sample.mp4"
COUNT=40

echo "=== CCTV 에뮬레이터 시작 (${COUNT}채널) ==="

for i in $(seq -w 1 $COUNT); do
    ffmpeg -re -stream_loop -1 -i "$VIDEO_FILE" \
        -c:v copy -an \
        -f rtsp -rtsp_transport tcp \
        "${RTSP_SERVER}/emu${i}" \
        > /dev/null 2>&1 &
    echo "  emu${i} 시작 (PID: $!)"
done

echo ""
echo "=== ${COUNT}개 에뮬레이터 실행 완료 ==="
echo "종료하려면: ./stop-emulators.sh"
