#!/bin/bash
# Spring Boot 서버 종료

PID_FILE="app.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "Not running (no PID file)"
    exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping (PID: $PID)..."
    kill "$PID"
    sleep 3
    if kill -0 "$PID" 2>/dev/null; then
        echo "Force killing..."
        kill -9 "$PID"
    fi
    echo "Stopped"
else
    echo "Process not found (PID: $PID)"
fi

rm -f "$PID_FILE"
