#!/bin/bash
# ─────────────────────────────────────────────
# HLS/WebRTC Stress Test 측정 스크립트
# 사용법: ./stress-test.sh [모드] [채널수] [측정시간(초)]
# 예시:   ./stress-test.sh webrtc 10 30
#         ./stress-test.sh hls 40 60
# ─────────────────────────────────────────────

NETDATA_URL="http://localhost:19999"
MODE=${1:-"webrtc"}
CHANNELS=${2:-10}
DURATION=${3:-30}
REPORT_DIR="docs/reports/stress-test"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_FILE="${REPORT_DIR}/${MODE}_${CHANNELS}ch_${TIMESTAMP}.txt"

mkdir -p "$REPORT_DIR"

# Netdata에서 메트릭 가져오기
get_cpu() {
    curl -s "${NETDATA_URL}/api/v1/data?chart=system.cpu&after=-${1:-5}&points=1&format=json" \
        | python3 -c "
import sys,json
d = json.load(sys.stdin)
row = d['data'][0]
labels = d['labels']
# user + system + softirq + irq
total = sum(row[1:])
print(f'{total:.2f}')
"
}

get_memory() {
    curl -s "${NETDATA_URL}/api/v1/data?chart=system.ram&after=-${1:-5}&points=1&format=json" \
        | python3 -c "
import sys,json
d = json.load(sys.stdin)
row = d['data'][0]
labels = d['labels']
# labels: time, free, used, cached, buffers
used = row[2]
print(f'{used:.1f}')
"
}

get_network() {
    curl -s "${NETDATA_URL}/api/v1/data?chart=system.net&after=-${1:-5}&points=1&format=json" \
        | python3 -c "
import sys,json
d = json.load(sys.stdin)
row = d['data'][0]
# received in kbps → Mbps
recv_mbps = row[1] / 1000
sent_mbps = abs(row[2]) / 1000
print(f'{recv_mbps:.2f},{sent_mbps:.2f}')
"
}

get_docker_cpu() {
    curl -s "${NETDATA_URL}/api/v1/data?chart=app.dockerd_cpu_utilization&after=-${1:-5}&points=1&format=json" \
        | python3 -c "
import sys,json
d = json.load(sys.stdin)
row = d['data'][0]
total = sum(row[1:])
print(f'{total:.2f}')
" 2>/dev/null || echo "N/A"
}

echo "════════════════════════════════════════════════"
echo "  CCTV Streamer Stress Test"
echo "════════════════════════════════════════════════"
echo "  모드: ${MODE}"
echo "  채널 수: ${CHANNELS}"
echo "  측정 시간: ${DURATION}초"
echo "  리포트: ${REPORT_FILE}"
echo "════════════════════════════════════════════════"
echo ""

# ── STEP 1: 기준선 (연결 전) ──
echo "[1/4] 기준선 측정 중 (연결 전)..."
BASELINE_CPU=$(get_cpu 10)
BASELINE_MEM=$(get_memory 10)
BASELINE_NET=$(get_network 10)
BASELINE_NET_RECV=$(echo "$BASELINE_NET" | cut -d',' -f1)
BASELINE_NET_SENT=$(echo "$BASELINE_NET" | cut -d',' -f2)

echo "  CPU: ${BASELINE_CPU}%"
echo "  Memory: ${BASELINE_MEM} MB"
echo "  Network: recv ${BASELINE_NET_RECV} Mbps / sent ${BASELINE_NET_SENT} Mbps"
echo ""

# ── STEP 2: 사용자에게 연결 요청 ──
echo "[2/4] 대시보드에서 연결해주세요!"
echo "  1. 채널 수를 ${CHANNELS}으로 설정"
echo "  2. 모드를 ${MODE}으로 선택"
echo "  3. '전체 연결' 클릭"
echo ""
read -p "  연결 완료 후 Enter 키를 누르세요... "
echo ""

# ── STEP 3: 안정화 대기 + 측정 ──
echo "[3/4] ${DURATION}초간 측정 중..."

# 5초 안정화 대기
sleep 5

# 측정 시간 동안 5초 간격으로 샘플링
SAMPLES=0
SUM_CPU=0
SUM_MEM=0
SUM_NET_RECV=0
SUM_NET_SENT=0
MAX_CPU=0
MAX_MEM=0

ELAPSED=0
while [ $ELAPSED -lt $DURATION ]; do
    CPU=$(get_cpu 5)
    MEM=$(get_memory 5)
    NET=$(get_network 5)
    NET_RECV=$(echo "$NET" | cut -d',' -f1)
    NET_SENT=$(echo "$NET" | cut -d',' -f2)

    SUM_CPU=$(python3 -c "print(${SUM_CPU} + ${CPU})")
    SUM_MEM=$(python3 -c "print(${SUM_MEM} + ${MEM})")
    SUM_NET_RECV=$(python3 -c "print(${SUM_NET_RECV} + ${NET_RECV})")
    SUM_NET_SENT=$(python3 -c "print(${SUM_NET_SENT} + ${NET_SENT})")
    MAX_CPU=$(python3 -c "print(max(${MAX_CPU}, ${CPU}))")
    MAX_MEM=$(python3 -c "print(max(${MAX_MEM}, ${MEM}))")

    SAMPLES=$((SAMPLES + 1))
    ELAPSED=$((ELAPSED + 5))

    printf "  [%3ds/%ds] CPU: %s%% | Mem: %s MB | Net: recv %s / sent %s Mbps\n" \
        "$ELAPSED" "$DURATION" "$CPU" "$MEM" "$NET_RECV" "$NET_SENT"

    if [ $ELAPSED -lt $DURATION ]; then
        sleep 5
    fi
done

echo ""

# ── STEP 4: 결과 계산 + 리포트 ──
echo "[4/4] 결과 계산 중..."

AVG_CPU=$(python3 -c "print(f'{${SUM_CPU} / ${SAMPLES}:.2f}')")
AVG_MEM=$(python3 -c "print(f'{${SUM_MEM} / ${SAMPLES}:.1f}')")
AVG_NET_RECV=$(python3 -c "print(f'{${SUM_NET_RECV} / ${SAMPLES}:.2f}')")
AVG_NET_SENT=$(python3 -c "print(f'{${SUM_NET_SENT} / ${SAMPLES}:.2f}')")

DELTA_CPU=$(python3 -c "print(f'{${AVG_CPU} - ${BASELINE_CPU}:.2f}')")
DELTA_MEM=$(python3 -c "print(f'{${AVG_MEM} - ${BASELINE_MEM}:.1f}')")
PER_CH_CPU=$(python3 -c "print(f'{(${AVG_CPU} - ${BASELINE_CPU}) / ${CHANNELS}:.3f}')")
PER_CH_MEM=$(python3 -c "print(f'{(${AVG_MEM} - ${BASELINE_MEM}) / ${CHANNELS}:.2f}')")

# 리포트 출력 + 파일 저장
REPORT=$(cat <<EOF
════════════════════════════════════════════════
  Stress Test 결과: ${MODE} ${CHANNELS}채널
  측정 시간: ${DURATION}초 (${SAMPLES}회 샘플링)
  일시: $(date '+%Y-%m-%d %H:%M:%S')
════════════════════════════════════════════════

┌──────────────┬──────────┬──────────┬──────────┐
│ 항목         │ 기준선   │ 평균     │ 최대     │
├──────────────┼──────────┼──────────┼──────────┤
│ CPU (%)      │ ${BASELINE_CPU}     │ ${AVG_CPU}     │ ${MAX_CPU}     │
│ Memory (MB)  │ ${BASELINE_MEM}  │ ${AVG_MEM}  │ ${MAX_MEM}  │
│ Net Recv(Mbps)│ ${BASELINE_NET_RECV}  │ ${AVG_NET_RECV}  │ -        │
│ Net Sent(Mbps)│ ${BASELINE_NET_SENT}  │ ${AVG_NET_SENT}  │ -        │
└──────────────┴──────────┴──────────┴──────────┘

── 증가량 ──
  CPU 증가: +${DELTA_CPU}%
  Memory 증가: +${DELTA_MEM} MB

── 채널당 리소스 ──
  채널당 CPU: ${PER_CH_CPU}%
  채널당 Memory: ${PER_CH_MEM} MB

EOF
)

echo "$REPORT"
echo "$REPORT" > "$REPORT_FILE"
echo "리포트 저장: ${REPORT_FILE}"
