async function fetchStats() {
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/monitor`);
        const data = await res.json();

        // JVM
        const jvm = data.jvm;
        document.getElementById('jvm-heap').textContent =
            `${jvm.heapUsedMB} MB / ${jvm.heapMaxMB} MB (${jvm.heapUsagePercent}%)`;
        document.getElementById('jvm-cpu-process').textContent =
            jvm.cpuPercent !== undefined ? jvm.cpuPercent + '%' : '-';
        document.getElementById('jvm-cpu').textContent = jvm.systemCpuLoad;
        document.getElementById('jvm-threads').textContent = jvm.threadCount;
        document.getElementById('jvm-processors').textContent = jvm.availableProcessors + '코어';

        const heapBar = document.getElementById('jvm-heap-bar');
        heapBar.style.width = jvm.heapUsagePercent + '%';
        heapBar.textContent = jvm.heapUsagePercent + '%';
        heapBar.className = 'bar ' +
            (jvm.heapUsagePercent > 80 ? 'bar-red' : jvm.heapUsagePercent > 50 ? 'bar-yellow' : 'bar-green');

        // go2rtc
        const g = data.go2rtc;
        const statusEl = document.getElementById('go2rtc-status');
        if (g.running) {
            statusEl.innerHTML = '<span class="status-badge status-running">RUNNING</span>';
        } else {
            statusEl.innerHTML = '<span class="status-badge status-stopped">STOPPED</span>';
        }
        document.getElementById('go2rtc-pid').textContent = g.pid > 0 ? g.pid : '-';
        document.getElementById('go2rtc-cpu').textContent = g.cpuPercent !== undefined ? g.cpuPercent + '%' : '-';
        document.getElementById('go2rtc-mem').textContent = g.rssMB !== undefined ? g.rssMB + ' MB' : '-';

        const memBar = document.getElementById('go2rtc-mem-bar');
        if (g.rssMB !== undefined) {
            // 256MB 기준으로 바 표시 (go2rtc는 보통 매우 적게 씀)
            const memPercent = Math.min(Math.round(g.rssMB / 256 * 100), 100);
            memBar.style.width = memPercent + '%';
            memBar.textContent = g.rssMB + ' MB';
            memBar.className = 'bar ' +
                (memPercent > 80 ? 'bar-red' : memPercent > 50 ? 'bar-yellow' : 'bar-green');
        }

    } catch (e) {
        console.error('모니터링 데이터 로드 실패:', e);
    }
}

fetchStats();
setInterval(fetchStats, 3000);
