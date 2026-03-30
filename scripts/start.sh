#!/bin/bash
# Spring Boot 서버 시작 (prod 프로파일)

JAR_FILE="webrtc-0.0.1-SNAPSHOT.jar"
PID_FILE="app.pid"
LOG_FILE="app.log"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Already running (PID: $PID)"
        exit 1
    fi
    rm -f "$PID_FILE"
fi

echo "Starting Spring Boot..."
nohup java -Xmx512m -jar "$JAR_FILE" --spring.profiles.active=prod > "$LOG_FILE" 2>&1 &

echo $! > "$PID_FILE"
echo "Started (PID: $(cat $PID_FILE))"
echo "Log: tail -f $LOG_FILE"
