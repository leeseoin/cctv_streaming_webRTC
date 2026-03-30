// NMS Dashboard
let currentTab = 'nms1';
let hourlyChart = null;
let pollTimer = null;

// --- Tab Switch ---
function switchTab(btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    document.getElementById('tab-' + currentTab).classList.add('active');
    fetchCurrentTab();
}

// --- Fetch ---
async function fetchCurrentTab() {
    try {
        if (currentTab === 'nms1') await fetchDaily();
        else if (currentTab === 'nms2') await fetchRealtime();
        else if (currentTab === 'nms3') await fetchIpDistribution();
        document.getElementById('updateTime').textContent = new Date().toLocaleTimeString('ko-KR');
    } catch (e) {
        console.error('fetch error:', e);
    }
}

// --- nms1: Daily Summary ---
async function fetchDaily() {
    const res = await fetch(`${CONFIG.API_BASE}/api/nms/daily`);
    const data = await res.json();

    const kpi = data.kpi || {};
    setText('d-closedSessions', kpi.closedSessions ?? '-');
    setText('d-uniqueIps', kpi.uniqueIps ?? '-');
    setText('d-avgDuration', fmtDuration(kpi.avgDurationSec));
    setText('d-peakSessions', kpi.peakConcurrentSessions ?? '-');
    setText('d-mobilePercent', fmtPct(kpi.mobilePercent));
    setText('d-avgCpu', fmtPct(kpi.avgCpuPercent));
    setText('d-avgRx', fmtMbps(kpi.avgRxMbps));
    setText('d-maxRx', fmtMbps(kpi.maxRxMbps));
    setText('d-avgTx', fmtMbps(kpi.avgTxMbps));
    setText('d-maxTx', fmtMbps(kpi.maxTxMbps));
    setText('d-webrtcClosed', kpi.webrtcClosedSessions ?? '-');
    setText('d-rtspClosed', kpi.rtspClosedSessions ?? '-');

    const summary = data.summary || {};
    setText('d-totalWatchTime', fmtDuration(summary.totalWatchTimeSec));
    setText('d-longestSession', fmtDuration(summary.longestSessionSec));
    setText('d-shortestSession', fmtDuration(summary.shortestSessionSec));
    setText('d-peakIps', summary.peakConcurrentIps ?? '-');
    setText('d-peakCameras', summary.peakConcurrentCameras ?? '-');
    setText('d-cumulativeBytes', (summary.cumulativeRxMB ?? 0) + ' / ' + (summary.cumulativeTxMB ?? 0) + ' MB');

    renderHourlyChart(data.hourlyTrend || []);
    renderTable('cameraTop10', data.topCameras || [], ['camera', 'sessionCount', 'totalWatchTimeSec', 'maxReaders']);
    renderTable('ipTop10', data.topIps || [], ['ip', 'isp', 'mobile', 'sessionCount', 'totalWatchTimeSec']);
}

// --- nms2: Real-time ---
async function fetchRealtime() {
    const res = await fetch(`${CONFIG.API_BASE}/api/nms/realtime`);
    const data = await res.json();

    setText('r-cpu', fmtPct(data.cpuPercent));
    setText('r-activeIps', data.activeIps ?? '-');
    setText('r-activeSessions', data.activeSessions ?? '-');
    setText('r-activeCameras', data.activeCameras ?? '-');
    setText('r-mobileIps', data.mobileLikelyIps ?? '-');
    setText('r-currentRx', fmtMbps(data.currentRxMbps));
    setText('r-currentTx', fmtMbps(data.currentTxMbps));
    setText('r-cumulativeRx', fmtBytes(data.cumulativeRxBytes));
    setText('r-cumulativeTx', fmtBytes(data.cumulativeTxBytes));
    setText('r-socketIps', data.socketIpCount ?? '-');
}

// --- nms3: IP Distribution ---
async function fetchIpDistribution() {
    const res = await fetch(`${CONFIG.API_BASE}/api/nms/ip-distribution`);
    const json = await res.json();
    const data = json.distribution || [];
    const list = document.getElementById('ipBarList');

    if (!data.length) {
        list.innerHTML = '<div class="no-data">접속 중인 IP가 없습니다</div>';
        return;
    }

    const maxCount = data[0].socketCount || 1;
    list.innerHTML = data.map(item => `
        <div class="ip-bar-item">
            <div class="ip-bar-header">
                <span class="ip-bar-ip">${item.ip}</span>
                <span class="ip-bar-count">${item.socketCount} sockets</span>
            </div>
            <div class="ip-bar-track">
                <div class="ip-bar-fill" style="width:${(item.socketCount / maxCount * 100).toFixed(1)}%"></div>
            </div>
        </div>
    `).join('');
}

// --- Hourly Chart ---
function renderHourlyChart(trends) {
    const ctx = document.getElementById('hourlyChart');
    if (!ctx) return;

    const labels = trends.map(t => String(t.hour ?? '').padStart(2, '0') + ':00');
    const sessions = trends.map(t => t.sessions ?? 0);
    const ips = trends.map(t => t.ips ?? 0);
    const rx = trends.map(t => t.rxMbps ?? 0);
    const tx = trends.map(t => t.txMbps ?? 0);

    if (hourlyChart) hourlyChart.destroy();
    hourlyChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Sessions', data: sessions, borderColor: '#4a9eff', backgroundColor: 'rgba(74,158,255,0.1)', tension: 0.3, pointRadius: 2 },
                { label: 'IPs', data: ips, borderColor: '#e94560', backgroundColor: 'rgba(233,69,96,0.1)', tension: 0.3, pointRadius: 2 },
                { label: 'RX Mbps', data: rx, borderColor: '#e9c46a', backgroundColor: 'rgba(233,196,106,0.1)', tension: 0.3, pointRadius: 2 },
                { label: 'TX Mbps', data: tx, borderColor: '#f4a261', backgroundColor: 'rgba(244,162,97,0.1)', tension: 0.3, pointRadius: 2 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#aaa', font: { size: 11 }, boxWidth: 12 } }
            },
            scales: {
                x: { ticks: { color: '#666', font: { size: 10 } }, grid: { color: '#1a1a3e' } },
                y: { ticks: { color: '#666', font: { size: 10 } }, grid: { color: '#1a1a3e' }, beginAtZero: true }
            }
        }
    });
}

// --- Table Renderer ---
function renderTable(tbodyId, rows, keys) {
    const tbody = document.getElementById(tbodyId);
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="${keys.length}" style="text-align:center;color:#666">데이터 없음</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(row =>
        '<tr>' + keys.map(k => `<td>${row[k] ?? '-'}</td>`).join('') + '</tr>'
    ).join('');
}

// --- Formatting ---
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function fmtDuration(totalSec) {
    if (totalSec == null || totalSec === 0) return '0s';
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
}

function fmtPct(val) {
    return val != null ? val + '%' : '-';
}

function fmtMbps(val) {
    return val != null ? val + ' Mbps' : '-';
}

function fmtBytes(bytes) {
    if (bytes == null) return '-';
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
}

// --- Polling ---
function startPolling() {
    fetchCurrentTab();
    pollTimer = setInterval(fetchCurrentTab, 5000);
}

startPolling();
