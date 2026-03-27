/* ============================================
   HWiNFO Benchmark Analyzer
   ============================================ */

// Global state
const state = {
    files: [],        // { name, headers, rows, analysis }
    activeIndex: 0,
    charts: {},
};

// ============================================
// SECTION 1: CSV PARSING
// ============================================

function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

    const headers = parseCSVLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const vals = parseCSVLine(lines[i]);
        if (vals.length >= headers.length - 1) {
            rows.push(vals);
        }
    }
    return { headers, rows };
}

function parseCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                fields.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
    }
    fields.push(current.trim());
    return fields;
}

// ============================================
// SECTION 2: COLUMN CLASSIFICATION
// ============================================

const CATEGORIES = {
    performance: { label: 'Performance', color: '#58a6ff' },
    cpu_temp: { label: 'CPU Temperature', color: '#f85149' },
    gpu_temp: { label: 'GPU Temperature', color: '#ff7b72' },
    cpu_clock: { label: 'CPU Clocks', color: '#58a6ff' },
    gpu_clock: { label: 'GPU Clocks', color: '#bc8cff' },
    cpu_usage: { label: 'CPU Usage', color: '#3fb950' },
    gpu_usage: { label: 'GPU Usage', color: '#39d2c0' },
    cpu_power: { label: 'CPU Power', color: '#d29922' },
    gpu_power: { label: 'GPU Power', color: '#f778ba' },
    memory: { label: 'Memory', color: '#bc8cff' },
    storage: { label: 'Storage', color: '#8b949e' },
    fans: { label: 'Fans & Cooling', color: '#39d2c0' },
    voltage: { label: 'Voltages', color: '#d29922' },
    throttle: { label: 'Throttling & Limits', color: '#f85149' },
    pcie: { label: 'PCIe', color: '#8b949e' },
    network: { label: 'Network', color: '#8b949e' },
    other: { label: 'Other', color: '#484f58' },
};

function classifyColumn(name) {
    const n = name.toLowerCase();
    if (/framerate|frame time|frame rate|\bfps\b/.test(n)) return 'performance';
    if (/gpu.*(temp|°c)/.test(n) && !/cpu/.test(n)) return 'gpu_temp';
    if (/(cpu|core\d*\s*\(ccd|tctl|tdie|iod|l3 temp|l3 cache.*°c)/.test(n) && /°c/.test(n)) return 'cpu_temp';
    if (/gpu.*(clock|mhz|ratio)/.test(n)) return 'gpu_clock';
    if (/(core.*clock|core.*ratio|bus clock|average effective|fclk|uclk|l3 clock|memory controller clock)/.test(n) && /mhz|x\]/.test(n)) return 'cpu_clock';
    if (/gpu.*(usage|load|utiliz)/.test(n) || /gpu d3d/.test(n)) return 'gpu_usage';
    if (/(core.*usage|core.*utility|total cpu|max cpu|cpu.*usage)/.test(n)) return 'cpu_usage';
    if (/gpu.*(power|tdp|\bw\])/.test(n) && !/cpu/.test(n)) return 'gpu_power';
    if (/(cpu.*power|core.*power|soc.*power|package power|ppt|tdc|edc|core\+soc)/.test(n) && /[wa\]%]/.test(n)) return 'cpu_power';
    if (/(memory|ram|physical mem|virtual mem|page file)/.test(n)) return 'memory';
    if (/(drive|host write|host read|nvme|ssd|remaining life|available spare)/.test(n)) return 'storage';
    if (/(fan|pump|rpm|liquid|coolant|aio)/.test(n) && !/gpu fan/.test(n)) return 'fans';
    if (/gpu.*fan/.test(n)) return 'fans';
    if (/(voltage|vcore|\bv\]|vid|vdd|vcc|vsb|vbat|vtt)/.test(n) && !/°c/.test(n) && !/power/.test(n) && !/current/.test(n) && !/mhz/.test(n)) return 'voltage';
    if (/(throttl|thermal.*limit|perf.*limit|limit.*%|htc|prochot)/.test(n)) return 'throttle';
    if (/pci|lane.*error|receiver error|replay|dllp|tlp|lcrc|nak/.test(n)) return 'pcie';
    if (/(network|download|upload|\bdl\b|\bup\b|current.*rate)/.test(n) && !/gpu/.test(n)) return 'network';
    if (/motherboard|chipset|spd hub|pmic/.test(n) && /°c/.test(n)) return 'other';
    if (/date|time/.test(n) && n.length < 10) return null; // skip date/time columns
    return 'other';
}

function classifyAllColumns(headers) {
    const categorized = {};
    for (const key of Object.keys(CATEGORIES)) categorized[key] = [];

    headers.forEach((h, i) => {
        if (i < 2) return; // skip Date, Time
        const cat = classifyColumn(h);
        if (cat && categorized[cat]) {
            categorized[cat].push({ index: i, name: h, unit: extractUnit(h) });
        }
    });
    return categorized;
}

function extractUnit(name) {
    const m = name.match(/\[([^\]]+)\]\s*$/);
    return m ? m[1] : '';
}

// ============================================
// SECTION 3: STATISTICS
// ============================================

function calcStats(values) {
    const nums = values.filter(v => v !== null && !isNaN(v));
    if (nums.length === 0) return null;

    const sorted = [...nums].sort((a, b) => a - b);
    const sum = nums.reduce((a, b) => a + b, 0);
    const avg = sum / nums.length;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];

    // Percentiles
    const p1 = sorted[Math.floor(sorted.length * 0.01)] ?? min;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? max;
    const p01 = sorted[Math.floor(sorted.length * 0.001)] ?? min;

    // 1% low (average of bottom 1%)
    const bottom1Count = Math.max(1, Math.floor(sorted.length * 0.01));
    const low1 = sorted.slice(0, bottom1Count).reduce((a, b) => a + b, 0) / bottom1Count;

    const bottom01Count = Math.max(1, Math.floor(sorted.length * 0.001));
    const low01 = sorted.slice(0, bottom01Count).reduce((a, b) => a + b, 0) / bottom01Count;

    return { min, max, avg, median, last: nums[nums.length - 1], count: nums.length, sum, p1, p99, p01, low1, low01 };
}

function getColumnValues(rows, colIndex) {
    return rows.map(row => {
        const v = row[colIndex];
        if (v === undefined || v === '' || v === 'Yes' || v === 'No') return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
    });
}

function getColumnBooleans(rows, colIndex) {
    return rows.map(row => row[colIndex] === 'Yes');
}

// ============================================
// SECTION 4: KEY METRICS EXTRACTION
// ============================================

function findColumn(headers, patterns, prefer) {
    // Find columns matching patterns, return best match
    const matches = [];
    headers.forEach((h, i) => {
        const lower = h.toLowerCase();
        for (const p of patterns) {
            if (typeof p === 'string' ? lower.includes(p.toLowerCase()) : p.test(lower)) {
                matches.push({ index: i, name: h });
                break;
            }
        }
    });
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    if (prefer) {
        const pref = matches.find(m => prefer.test(m.name.toLowerCase()));
        if (pref) return pref;
    }
    return matches[0];
}

function findBestGPUColumns(headers, rows) {
    // Find all GPU Clock columns and pick the discrete GPU (highest avg clock)
    const gpuClockIndices = [];
    headers.forEach((h, i) => {
        if (/^gpu clock \[mhz\]$/i.test(h.trim())) gpuClockIndices.push(i);
    });

    if (gpuClockIndices.length <= 1) {
        return { primaryGPUSection: null }; // no disambiguation needed
    }

    // Find which GPU clock has higher average (discrete GPU)
    let bestIdx = gpuClockIndices[0];
    let bestAvg = 0;
    for (const idx of gpuClockIndices) {
        const vals = getColumnValues(rows, idx);
        const stats = calcStats(vals);
        if (stats && stats.avg > bestAvg) {
            bestAvg = stats.avg;
            bestIdx = idx;
        }
    }

    // Determine the range of columns belonging to this GPU section
    // by finding the nearest GPU Clock index
    return { primaryGPUClockIndex: bestIdx, allGPUClockIndices: gpuClockIndices };
}

function findClosestColumn(headers, baseIndex, patterns) {
    // Find a column matching patterns closest to baseIndex
    let best = null;
    let bestDist = Infinity;
    headers.forEach((h, i) => {
        const lower = h.toLowerCase();
        for (const p of patterns) {
            const match = typeof p === 'string' ? lower.includes(p.toLowerCase()) : p.test(lower);
            if (match) {
                const dist = Math.abs(i - baseIndex);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = { index: i, name: h };
                }
            }
        }
    });
    return best;
}

function extractKeyMetrics(headers, rows) {
    const gpuInfo = findBestGPUColumns(headers, rows);
    const gpuClkIdx = gpuInfo.primaryGPUClockIndex;

    // Helper: find column near the primary GPU section
    function gpuCol(patterns) {
        if (gpuClkIdx != null) {
            return findClosestColumn(headers, gpuClkIdx, patterns);
        }
        return findColumn(headers, patterns);
    }

    const metrics = {};

    // Performance
    metrics.fps = findColumn(headers, [/^framerate \[fps\]$/i]);
    metrics.fps1low = findColumn(headers, [/^framerate 1% low \[fps\]$/i]);
    metrics.fps01low = findColumn(headers, [/^framerate 0\.1% low \[fps\]$/i]);
    metrics.frameTime = findColumn(headers, [/^frame time \[ms\]$/i]);
    metrics.fpsPresentedAvg = findColumn(headers, [/framerate presented \(avg\)/i]);
    metrics.fpsPresentedLow1 = findColumn(headers, [/framerate presented \(1% low\)/i]);
    metrics.fpsPresentedLow01 = findColumn(headers, [/framerate presented \(0\.1% low\)/i]);

    // CPU
    metrics.cpuTemp = findColumn(headers, [/cpu \(tctl\/tdie\)/i, /cpu.*tdie.*°c/i, /cpu die.*°c/i]);
    metrics.cpuClock = findColumn(headers, [/core clocks \(avg\)/i]);
    metrics.cpuUsage = findColumn(headers, [/total cpu usage/i]);
    metrics.cpuPower = findColumn(headers, [/cpu package power/i]);

    // GPU (prefer discrete)
    metrics.gpuTemp = gpuCol([/^gpu temperature \[°c\]$/i]);
    metrics.gpuJunctionTemp = gpuCol([/gpu memory junction temp/i]);
    metrics.gpuClock = gpuClkIdx != null ? { index: gpuClkIdx, name: headers[gpuClkIdx] } : findColumn(headers, [/^gpu clock \[mhz\]$/i]);
    metrics.gpuPower = gpuCol([/^gpu power \[w\]$/i]);
    metrics.gpuLoad = gpuCol([/gpu core load/i, /gpu utilization/i]);
    metrics.gpuMemUsed = gpuCol([/gpu d3d memory dedicated/i, /gpu memory allocated/i]);
    metrics.gpuVRAMUsage = gpuCol([/gpu memory usage \[%\]/i]);
    metrics.gpuFan1 = gpuCol([/gpu fan1 \[rpm\]/i]);
    metrics.gpuFan2 = gpuCol([/gpu fan2 \[rpm\]/i]);

    // System
    metrics.ramUsage = findColumn(headers, [/physical memory load/i]);
    metrics.ramUsed = findColumn(headers, [/physical memory used/i]);
    metrics.ramAvail = findColumn(headers, [/physical memory available/i]);
    metrics.liquidTemp = findColumn(headers, [/liquid temperature/i]);

    // Throttle booleans
    metrics.thermalThrottle = findColumn(headers, [/thermal throttling \(htc\)/i]);
    metrics.prochotCPU = findColumn(headers, [/thermal throttling \(prochot cpu\)/i]);
    metrics.perfLimitPower = findColumn(headers, [/performance limit - power/i, /throttle reason - power/i]);
    metrics.perfLimitThermal = findColumn(headers, [/performance limit - thermal/i, /throttle reason - thermal/i]);

    // Calculate stats for all found metrics
    const stats = {};
    for (const [key, col] of Object.entries(metrics)) {
        if (!col) continue;
        const vals = getColumnValues(rows, col.index);
        const s = calcStats(vals);
        if (s) {
            stats[key] = { ...s, name: col.name, values: vals };
        }
    }

    // Boolean stats (throttle)
    for (const key of ['thermalThrottle', 'prochotCPU', 'perfLimitPower', 'perfLimitThermal']) {
        if (!metrics[key]) continue;
        const bools = getColumnBooleans(rows, metrics[key].index);
        const yesCount = bools.filter(b => b).length;
        stats[key] = {
            name: metrics[key].name,
            yesCount,
            totalCount: bools.length,
            percentage: (yesCount / bools.length * 100),
            values: bools,
        };
    }

    return { metrics, stats };
}

// ============================================
// SECTION 5: ANOMALY DETECTION
// ============================================

function detectAnomalies(stats) {
    const alerts = [];

    function alert(severity, msg) {
        alerts.push({ severity, message: msg });
    }

    // CPU Temperature
    if (stats.cpuTemp) {
        if (stats.cpuTemp.max >= 95)
            alert('critical', `CPU temperature reached ${stats.cpuTemp.max.toFixed(0)}°C (critical threshold: 95°C)`);
        else if (stats.cpuTemp.max >= 85)
            alert('warning', `CPU temperature peaked at ${stats.cpuTemp.max.toFixed(0)}°C (high threshold: 85°C)`);
    }

    // GPU Temperature
    if (stats.gpuTemp) {
        if (stats.gpuTemp.max >= 95)
            alert('critical', `GPU temperature reached ${stats.gpuTemp.max.toFixed(0)}°C (critical threshold: 95°C)`);
        else if (stats.gpuTemp.max >= 85)
            alert('warning', `GPU temperature peaked at ${stats.gpuTemp.max.toFixed(0)}°C (high threshold: 85°C)`);
    }

    // GPU VRAM Junction
    if (stats.gpuJunctionTemp) {
        if (stats.gpuJunctionTemp.max >= 110)
            alert('critical', `GPU memory junction temp reached ${stats.gpuJunctionTemp.max.toFixed(0)}°C (critical: 110°C)`);
        else if (stats.gpuJunctionTemp.max >= 100)
            alert('warning', `GPU memory junction temp peaked at ${stats.gpuJunctionTemp.max.toFixed(0)}°C (high: 100°C)`);
    }

    // Thermal throttling
    if (stats.thermalThrottle && stats.thermalThrottle.yesCount > 0) {
        alert('critical', `Thermal throttling (HTC) detected in ${stats.thermalThrottle.percentage.toFixed(1)}% of samples`);
    }
    if (stats.prochotCPU && stats.prochotCPU.yesCount > 0) {
        alert('critical', `PROCHOT throttling detected in ${stats.prochotCPU.percentage.toFixed(1)}% of samples`);
    }

    // Performance limits
    if (stats.perfLimitPower && stats.perfLimitPower.yesCount > 0) {
        const pct = stats.perfLimitPower.percentage;
        if (pct > 50) {
            alert('warning', `GPU power limit hit in ${pct.toFixed(0)}% of samples — consider raising power limit or improving cooling`);
        } else if (pct > 5) {
            alert('info', `GPU power limit reached in ${pct.toFixed(0)}% of samples`);
        }
    }
    if (stats.perfLimitThermal && stats.perfLimitThermal.yesCount > 0) {
        alert('warning', `GPU thermal limit hit in ${stats.perfLimitThermal.percentage.toFixed(0)}% of samples`);
    }

    // FPS analysis
    if (stats.fps) {
        const avg = stats.fps.avg;
        const low1 = stats.fps.low1;
        const low01 = stats.fps.low01;
        const min = stats.fps.min;

        if (low1 < avg * 0.4) {
            alert('warning', `Large frametime spikes: 1% Low (${low1.toFixed(0)} FPS) is ${(low1/avg*100).toFixed(0)}% of average (${avg.toFixed(0)} FPS)`);
        }
        if (min < avg * 0.3) {
            alert('info', `Minimum FPS (${min.toFixed(0)}) dropped to ${(min/avg*100).toFixed(0)}% of average — possible stutter or loading spike`);
        }
    }

    // CPU Clock analysis - check for potential throttling
    if (stats.cpuClock) {
        const range = stats.cpuClock.max - stats.cpuClock.min;
        const pctDrop = range / stats.cpuClock.max * 100;
        if (pctDrop > 30 && stats.cpuClock.min < 2000) {
            alert('warning', `CPU clock dropped to ${stats.cpuClock.min.toFixed(0)} MHz (${pctDrop.toFixed(0)}% below max ${stats.cpuClock.max.toFixed(0)} MHz) — possible throttling`);
        }
    }

    // GPU Clock analysis
    if (stats.gpuClock) {
        const range = stats.gpuClock.max - stats.gpuClock.min;
        const pctDrop = range / stats.gpuClock.max * 100;
        if (pctDrop > 40) {
            alert('info', `GPU clock varied from ${stats.gpuClock.min.toFixed(0)} to ${stats.gpuClock.max.toFixed(0)} MHz (${pctDrop.toFixed(0)}% range)`);
        }
    }

    // RAM usage
    if (stats.ramUsage && stats.ramUsage.max >= 90) {
        alert('warning', `RAM usage peaked at ${stats.ramUsage.max.toFixed(0)}% — system may be memory constrained`);
    }

    return alerts;
}

// ============================================
// SECTION 5B: WORTH CHECKING DETECTION
// ============================================

function detectWorthChecking(stats, headers, rows, allStats) {
    const items = [];

    function add(icon, title, detail, values) {
        items.push({ icon, title, detail, values });
    }

    // CPU temp in warm range (65-84)
    if (stats.cpuTemp && stats.cpuTemp.max >= 65 && stats.cpuTemp.max < 85) {
        add('yellow', `CPU temp reached ${stats.cpuTemp.max.toFixed(0)}°C`,
            'Not critical, but warmer than ideal. Check cooler mounting or case airflow if this is under light load.',
            [{ label: 'Avg', val: stats.cpuTemp.avg.toFixed(0) + '°C' }, { label: 'Peak', val: stats.cpuTemp.max.toFixed(0) + '°C' }]);
    }

    // GPU temp in warm range (70-84)
    if (stats.gpuTemp && stats.gpuTemp.max >= 70 && stats.gpuTemp.max < 85) {
        add('yellow', `GPU temp reached ${stats.gpuTemp.max.toFixed(0)}°C`,
            'Within spec but on the warmer side. Fan curve or case airflow could help.',
            [{ label: 'Avg', val: stats.gpuTemp.avg.toFixed(0) + '°C' }, { label: 'Peak', val: stats.gpuTemp.max.toFixed(0) + '°C' }]);
    }

    // VRAM junction warm range (80-99)
    if (stats.gpuJunctionTemp && stats.gpuJunctionTemp.max >= 80 && stats.gpuJunctionTemp.max < 100) {
        add('yellow', `VRAM junction temp at ${stats.gpuJunctionTemp.max.toFixed(0)}°C`,
            'GDDR6X memory can run hot. Consider replacing thermal pads if above 95°C consistently.',
            [{ label: 'Avg', val: stats.gpuJunctionTemp.avg.toFixed(0) + '°C' }, { label: 'Peak', val: stats.gpuJunctionTemp.max.toFixed(0) + '°C' }]);
    }

    // Liquid temp trending up
    if (stats.liquidTemp) {
        const vals = stats.liquidTemp.values.filter(v => v !== null);
        if (vals.length > 10) {
            const firstQuarter = vals.slice(0, Math.floor(vals.length / 4));
            const lastQuarter = vals.slice(-Math.floor(vals.length / 4));
            const firstAvg = firstQuarter.reduce((a, b) => a + b, 0) / firstQuarter.length;
            const lastAvg = lastQuarter.reduce((a, b) => a + b, 0) / lastQuarter.length;
            const rise = lastAvg - firstAvg;
            if (rise > 3) {
                add('cyan', `Liquid temp rose ${rise.toFixed(1)}°C during session`,
                    'Coolant temp increased noticeably. In longer sessions this could lead to higher component temps.',
                    [{ label: 'Start', val: firstAvg.toFixed(1) + '°C' }, { label: 'End', val: lastAvg.toFixed(1) + '°C' }]);
            }
        }
    }

    // High RAM usage (70-89%)
    if (stats.ramUsage && stats.ramUsage.max >= 70 && stats.ramUsage.max < 90) {
        add('purple', `RAM usage peaked at ${stats.ramUsage.max.toFixed(0)}%`,
            'Getting close to full. Background apps or browser tabs could push this into swap territory.',
            [{ label: 'Avg', val: stats.ramUsage.avg.toFixed(0) + '%' }, { label: 'Peak', val: stats.ramUsage.max.toFixed(0) + '%' }]);
    }

    // VRAM usage high
    if (stats.gpuVRAMUsage && stats.gpuVRAMUsage.max >= 80) {
        add('purple', `VRAM usage reached ${stats.gpuVRAMUsage.max.toFixed(0)}%`,
            'Close to VRAM capacity. Lowering texture quality or resolution may help if you see stuttering.',
            [{ label: 'Avg', val: stats.gpuVRAMUsage.avg.toFixed(0) + '%' }, { label: 'Peak', val: stats.gpuVRAMUsage.max.toFixed(0) + '%' }]);
    }

    // CPU usage very low (possible GPU bottleneck)
    if (stats.cpuUsage && stats.gpuLoad && stats.cpuUsage.avg < 30 && stats.gpuLoad.avg > 85) {
        add('blue', 'Possible GPU bottleneck',
            `CPU usage is low (${stats.cpuUsage.avg.toFixed(0)}%) while GPU is heavily loaded (${stats.gpuLoad.avg.toFixed(0)}%). GPU is likely the limiting factor for FPS.`,
            [{ label: 'CPU', val: stats.cpuUsage.avg.toFixed(0) + '%' }, { label: 'GPU', val: stats.gpuLoad.avg.toFixed(0) + '%' }]);
    }

    // GPU usage low (possible CPU bottleneck)
    if (stats.cpuUsage && stats.gpuLoad && stats.gpuLoad.avg < 70 && stats.cpuUsage.avg > 60) {
        add('blue', 'Possible CPU bottleneck',
            `GPU load is only ${stats.gpuLoad.avg.toFixed(0)}% while CPU usage is ${stats.cpuUsage.avg.toFixed(0)}%. CPU may be the limiting factor.`,
            [{ label: 'CPU', val: stats.cpuUsage.avg.toFixed(0) + '%' }, { label: 'GPU', val: stats.gpuLoad.avg.toFixed(0) + '%' }]);
    }

    // CPU clock variance (cores running at different speeds)
    if (stats.cpuClock) {
        const variance = stats.cpuClock.max - stats.cpuClock.min;
        const pctVariance = (variance / stats.cpuClock.max * 100);
        if (pctVariance > 15 && pctVariance <= 30) {
            add('cyan', `CPU clock varied by ${pctVariance.toFixed(0)}%`,
                `Clock speed ranged from ${(stats.cpuClock.min/1000).toFixed(2)} to ${(stats.cpuClock.max/1000).toFixed(2)} GHz. Some variation is normal under mixed workloads.`,
                [{ label: 'Min', val: (stats.cpuClock.min/1000).toFixed(2) + ' GHz' }, { label: 'Max', val: (stats.cpuClock.max/1000).toFixed(2) + ' GHz' }]);
        }
    }

    // Frame time consistency
    if (stats.fps) {
        const avg = stats.fps.avg;
        const low1 = stats.fps.low1;
        // Mild inconsistency (1% low between 40-60% of avg)
        if (low1 >= avg * 0.4 && low1 < avg * 0.6) {
            add('yellow', `1% Low is ${(low1/avg*100).toFixed(0)}% of average FPS`,
                'Noticeable frametime spikes. You may feel occasional hitches during gameplay.',
                [{ label: 'Avg', val: avg.toFixed(0) + ' FPS' }, { label: '1% Low', val: low1.toFixed(0) + ' FPS' }]);
        }
    }

    // Power close to limits (PPT)
    if (stats.cpuPower) {
        // Check if CPU power is fluctuating a lot
        const range = stats.cpuPower.max - stats.cpuPower.min;
        if (range > stats.cpuPower.avg * 0.5 && stats.cpuPower.max > 80) {
            add('cyan', `CPU power draw swings widely (${stats.cpuPower.min.toFixed(0)}-${stats.cpuPower.max.toFixed(0)}W)`,
                'Large power fluctuations can indicate bursty workloads. Generally normal for gaming.',
                [{ label: 'Min', val: stats.cpuPower.min.toFixed(0) + 'W' }, { label: 'Avg', val: stats.cpuPower.avg.toFixed(0) + 'W' }, { label: 'Max', val: stats.cpuPower.max.toFixed(0) + 'W' }]);
        }
    }

    // PCIe errors (skip avg/counter summary columns, only look at specific error types)
    if (allStats.pcie) {
        let totalErrors = 0;
        const errorTypes = [];
        for (const col of allStats.pcie) {
            if (/\b(receiver error|correctable error|non-fatal error|fatal error|bad dllp|bad tlp|lcrc error)\b/i.test(col.name)
                && col.stats && col.stats.max > 0) {
                totalErrors += col.stats.max;
                errorTypes.push(col.name.replace(/\s*\[\]$/, '') + ': ' + col.stats.max.toFixed(0));
            }
        }
        if (totalErrors > 0) {
            add('yellow', `PCIe errors detected (${totalErrors} total)`,
                `${errorTypes.join(', ')}. Occasional errors can be normal, but high counts may indicate a cable or slot issue.`,
                [{ label: 'Total', val: totalErrors.toString() }]);
        }
    }

    // Drive temps
    if (allStats.storage) {
        for (const col of allStats.storage) {
            if (/drive temperature/i.test(col.name) && !/temperature 2|temperature 3/i.test(col.name) && col.stats) {
                if (col.stats.max >= 50 && col.stats.max < 70) {
                    add('yellow', `Drive running warm at ${col.stats.max.toFixed(0)}°C`,
                        'NVMe drives can get hot under sustained load. Consider a heatsink if not already installed.',
                        [{ label: 'Avg', val: col.stats.avg.toFixed(0) + '°C' }, { label: 'Peak', val: col.stats.max.toFixed(0) + '°C' }]);
                    break;
                }
            }
        }
    }

    // Drive remaining life
    if (allStats.storage) {
        for (const col of allStats.storage) {
            if (/remaining life/i.test(col.name) && col.stats && col.stats.min < 80 && col.stats.min > 20) {
                add('purple', `Drive at ${col.stats.min.toFixed(0)}% remaining life`,
                    'Drive is wearing down. Not urgent yet, but start planning a replacement.',
                    [{ label: 'Life Left', val: col.stats.min.toFixed(0) + '%' }]);
                break;
            }
        }
    }

    // GPU fan speed check
    if (stats.gpuFan1 && stats.gpuFan1.max > 2000) {
        add('cyan', `GPU fans spinning up to ${stats.gpuFan1.max.toFixed(0)} RPM`,
            'Fans are working hard. Check your fan curve if noise is a concern.',
            [{ label: 'Avg', val: stats.gpuFan1.avg.toFixed(0) + ' RPM' }, { label: 'Peak', val: stats.gpuFan1.max.toFixed(0) + ' RPM' }]);
    }

    return items;
}

// ============================================
// SECTION 6: TIMELINE
// ============================================

function parseTimeline(rows) {
    const times = [];
    let startTime = null;
    for (const row of rows) {
        const timeParts = row[1]?.match(/(\d+):(\d+):(\d+)\.?(\d*)/);
        if (timeParts) {
            const secs = parseInt(timeParts[1]) * 3600 + parseInt(timeParts[2]) * 60 + parseInt(timeParts[3]) + (parseInt(timeParts[4] || 0) / 1000);
            if (startTime === null) startTime = secs;
            times.push(secs - startTime);
        } else {
            times.push(times.length > 0 ? times[times.length - 1] + 2 : 0);
        }
    }
    return times;
}

function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
}

function formatTimeLabel(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ============================================
// SECTION 7: ANALYSIS PIPELINE
// ============================================

function analyzeFile(name, headers, rows) {
    const timeline = parseTimeline(rows);
    const categories = classifyAllColumns(headers);
    const { metrics, stats } = extractKeyMetrics(headers, rows);
    const anomalies = detectAnomalies(stats);
    const duration = timeline[timeline.length - 1] || 0;

    // Date from first row
    const date = rows[0]?.[0] || '';

    // Compute all column stats for the All Stats section
    const allStats = {};
    for (const [catKey, cols] of Object.entries(categories)) {
        if (cols.length === 0) continue;
        allStats[catKey] = cols.map(col => {
            const vals = getColumnValues(rows, col.index);
            const s = calcStats(vals);
            return { ...col, stats: s };
        }).filter(c => c.stats !== null);
    }

    const worthChecking = detectWorthChecking(stats, headers, rows, allStats);

    return { name, headers, rows, timeline, categories, metrics, stats, anomalies, worthChecking, allStats, duration, date };
}

// ============================================
// SECTION 8: UI RENDERING
// ============================================

function showUploadView() {
    document.getElementById('upload-view').classList.remove('hidden');
    document.getElementById('dashboard-view').classList.add('hidden');
}

function showDashboardView() {
    document.getElementById('upload-view').classList.add('hidden');
    document.getElementById('dashboard-view').classList.remove('hidden');
}

function renderFileTabs() {
    const container = document.getElementById('file-tabs');
    container.innerHTML = '';
    state.files.forEach((f, i) => {
        const btn = document.createElement('button');
        btn.className = 'file-tab' + (i === state.activeIndex ? ' active' : '');
        btn.textContent = f.name.replace(/\.csv$/i, '');
        btn.onclick = () => switchToFile(i);
        container.appendChild(btn);
    });
}

function switchToFile(index) {
    state.activeIndex = index;
    renderFileTabs();
    renderDashboard(state.files[index]);
}

function renderDashboard(analysis) {
    renderRunInfo(analysis);
    renderAlerts(analysis.anomalies);
    renderMetrics(analysis);
    renderCharts(analysis);
    renderWorthChecking(analysis.worthChecking);
    renderAllStats(analysis);
}

function renderRunInfo(analysis) {
    const el = document.getElementById('run-info');
    el.innerHTML = `
        <span>${analysis.date}</span>
        <span>Duration: ${formatDuration(analysis.duration)}</span>
        <span>${analysis.rows.length} samples</span>
    `;
}

function renderAlerts(anomalies) {
    const section = document.getElementById('alerts-section');
    if (anomalies.length === 0) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');

    const iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

    section.innerHTML = `
        <div class="alerts-header">${iconSvg} ${anomalies.length} item${anomalies.length > 1 ? 's' : ''} to review</div>
        ${anomalies.map(a => `
            <div class="alert-item">
                <div class="alert-dot ${a.severity}"></div>
                <span>${a.message}</span>
            </div>
        `).join('')}
    `;
}

function renderMetrics(analysis) {
    const grid = document.getElementById('metrics-grid');
    const s = analysis.stats;
    grid.innerHTML = '';

    // Helper to create a metric panel
    function panel(title, dotColor, badge, items, sparklineData, sparklineColor) {
        const div = document.createElement('div');
        div.className = 'metric-panel';

        let badgeHtml = '';
        if (badge) {
            badgeHtml = `<span class="panel-badge ${badge.class}">${badge.text}</span>`;
        }

        let sparkHtml = '';
        if (sparklineData && sparklineData.length > 0) {
            sparkHtml = `<div class="metric-sparkline"><canvas></canvas></div>`;
        }

        div.innerHTML = `
            <div class="panel-header">
                <div class="panel-title"><span class="dot" style="background:${dotColor}"></span>${title}</div>
                ${badgeHtml}
            </div>
            <div class="metric-items">
                ${items.map(it => `
                    <div class="metric-item${it.fullWidth ? ' full-width' : ''}">
                        <span class="metric-label">${it.label}</span>
                        <span class="metric-value${it.small ? ' small' : ''} ${it.colorClass || ''}">${it.value}</span>
                        ${it.range ? `<span class="metric-range">${it.range}</span>` : ''}
                    </div>
                `).join('')}
                ${sparkHtml}
            </div>
        `;
        grid.appendChild(div);

        if (sparklineData && sparklineData.length > 0) {
            requestAnimationFrame(() => {
                const canvas = div.querySelector('.metric-sparkline canvas');
                if (canvas) drawSparkline(canvas, sparklineData, sparklineColor);
            });
        }
    }

    // Performance Panel
    if (s.fps) {
        const avgFPS = s.fps.avg;
        const low1 = s.fps.low1;
        const low01 = s.fps.low01;
        const badge = avgFPS >= 60 ? { text: 'Smooth', class: 'badge-good' } :
                      avgFPS >= 30 ? { text: 'Playable', class: 'badge-warn' } :
                      { text: 'Low', class: 'badge-bad' };

        panel('Performance', '#58a6ff', badge, [
            { label: 'Avg FPS', value: avgFPS.toFixed(1), colorClass: 'color-blue', range: `Min ${s.fps.min.toFixed(0)} / Max ${s.fps.max.toFixed(0)}` },
            { label: 'Avg Frame Time', value: s.frameTime ? s.frameTime.avg.toFixed(1) + ' ms' : (1000/avgFPS).toFixed(1) + ' ms', colorClass: 'color-cyan', small: true },
            { label: '1% Low', value: low1.toFixed(1) + ' FPS', colorClass: 'color-orange', small: true },
            { label: '0.1% Low', value: low01.toFixed(1) + ' FPS', colorClass: 'color-red', small: true },
        ], s.fps.values, '#58a6ff');
    }

    // CPU Panel
    if (s.cpuTemp || s.cpuClock || s.cpuUsage) {
        const maxTemp = s.cpuTemp?.max || 0;
        const badge = maxTemp >= 95 ? { text: 'Critical', class: 'badge-bad' } :
                      maxTemp >= 85 ? { text: 'Hot', class: 'badge-warn' } :
                      maxTemp > 0 ? { text: 'Normal', class: 'badge-good' } : null;

        const items = [];
        if (s.cpuTemp) items.push({ label: 'Peak Temp', value: s.cpuTemp.max.toFixed(0) + '°C', colorClass: 'color-red', range: `Avg ${s.cpuTemp.avg.toFixed(0)}°C / Min ${s.cpuTemp.min.toFixed(0)}°C` });
        if (s.cpuClock) items.push({ label: 'Avg Clock', value: (s.cpuClock.avg / 1000).toFixed(2) + ' GHz', colorClass: 'color-blue', small: true, range: `${(s.cpuClock.min/1000).toFixed(2)} - ${(s.cpuClock.max/1000).toFixed(2)} GHz` });
        if (s.cpuUsage) items.push({ label: 'Avg Usage', value: s.cpuUsage.avg.toFixed(0) + '%', colorClass: 'color-green', small: true, range: `Peak ${s.cpuUsage.max.toFixed(0)}%` });
        if (s.cpuPower) items.push({ label: 'Avg Power', value: s.cpuPower.avg.toFixed(0) + ' W', colorClass: 'color-orange', small: true, range: `Peak ${s.cpuPower.max.toFixed(0)} W` });

        panel('CPU', '#f85149', badge, items, s.cpuTemp?.values, '#f85149');
    }

    // GPU Panel
    if (s.gpuTemp || s.gpuClock || s.gpuLoad) {
        const maxTemp = s.gpuTemp?.max || 0;
        const badge = maxTemp >= 95 ? { text: 'Critical', class: 'badge-bad' } :
                      maxTemp >= 85 ? { text: 'Hot', class: 'badge-warn' } :
                      maxTemp > 0 ? { text: 'Normal', class: 'badge-good' } : null;

        const items = [];
        if (s.gpuTemp) items.push({ label: 'Peak Temp', value: s.gpuTemp.max.toFixed(0) + '°C', colorClass: 'color-red', range: `Avg ${s.gpuTemp.avg.toFixed(0)}°C / Min ${s.gpuTemp.min.toFixed(0)}°C` });
        if (s.gpuJunctionTemp) items.push({ label: 'VRAM Junction', value: s.gpuJunctionTemp.max.toFixed(0) + '°C', colorClass: 'color-pink', small: true, range: `Avg ${s.gpuJunctionTemp.avg.toFixed(0)}°C` });
        if (s.gpuClock) items.push({ label: 'Avg Clock', value: (s.gpuClock.avg / 1000).toFixed(2) + ' GHz', colorClass: 'color-purple', small: true, range: `${(s.gpuClock.min/1000).toFixed(2)} - ${(s.gpuClock.max/1000).toFixed(2)} GHz` });
        if (s.gpuPower) items.push({ label: 'Avg Power', value: s.gpuPower.avg.toFixed(0) + ' W', colorClass: 'color-orange', small: true, range: `Peak ${s.gpuPower.max.toFixed(0)} W` });
        if (s.gpuLoad) items.push({ label: 'GPU Load', value: s.gpuLoad.avg.toFixed(0) + '%', colorClass: 'color-cyan', small: true, range: `Peak ${s.gpuLoad.max.toFixed(0)}%` });

        panel('GPU', '#bc8cff', badge, items, s.gpuTemp?.values, '#bc8cff');
    }

    // System Panel
    {
        const items = [];
        if (s.ramUsage) items.push({ label: 'RAM Usage', value: s.ramUsage.avg.toFixed(0) + '%', colorClass: 'color-purple', small: true, range: `Peak ${s.ramUsage.max.toFixed(0)}%` });
        if (s.ramUsed) items.push({ label: 'RAM Used', value: (s.ramUsed.avg / 1024).toFixed(1) + ' GB', colorClass: 'color-blue', small: true, range: `Peak ${(s.ramUsed.max / 1024).toFixed(1)} GB` });
        if (s.liquidTemp) items.push({ label: 'Liquid Temp', value: s.liquidTemp.avg.toFixed(1) + '°C', colorClass: 'color-cyan', small: true, range: `${s.liquidTemp.min.toFixed(1)} - ${s.liquidTemp.max.toFixed(1)}°C` });
        if (s.gpuFan1) items.push({ label: 'GPU Fan', value: s.gpuFan1.avg.toFixed(0) + ' RPM', colorClass: 'color-green', small: true, range: `${s.gpuFan1.min.toFixed(0)} - ${s.gpuFan1.max.toFixed(0)} RPM` });

        if (items.length > 0) {
            panel('System', '#39d2c0', null, items, s.liquidTemp?.values || s.ramUsage?.values, '#39d2c0');
        }
    }
}

function drawSparkline(canvas, data, color) {
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;

    // Filter out nulls and subsample if needed
    const clean = data.filter(v => v !== null && !isNaN(v));
    if (clean.length === 0) return;

    const maxSamples = Math.min(clean.length, 200);
    const step = clean.length / maxSamples;
    const sampled = [];
    for (let i = 0; i < maxSamples; i++) {
        sampled.push(clean[Math.floor(i * step)]);
    }

    const min = Math.min(...sampled);
    const max = Math.max(...sampled);
    const range = max - min || 1;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';

    sampled.forEach((v, i) => {
        const x = (i / (sampled.length - 1)) * w;
        const y = h - ((v - min) / range) * (h - 4) - 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill gradient below
    const lastX = w;
    const lastY = h - ((sampled[sampled.length - 1] - min) / range) * (h - 4) - 2;
    ctx.lineTo(lastX, h);
    ctx.lineTo(0, h);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + '30');
    grad.addColorStop(1, color + '05');
    ctx.fillStyle = grad;
    ctx.fill();
}

// ============================================
// SECTION 9: CHART RENDERING
// ============================================

function destroyCharts() {
    for (const key of Object.keys(state.charts)) {
        state.charts[key]?.destroy();
    }
    state.charts = {};
}

function makeChartOptions(yLabel, suggestedMin) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: {
                position: 'top',
                labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12, padding: 12 }
            },
            tooltip: {
                backgroundColor: '#1c2333',
                titleColor: '#e6edf3',
                bodyColor: '#8b949e',
                borderColor: '#30363d',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 6,
            }
        },
        scales: {
            x: {
                grid: { color: 'rgba(48,54,61,0.4)', drawBorder: false },
                ticks: { color: '#484f58', font: { size: 10 }, maxTicksLimit: 10 },
                title: { display: true, text: 'Time', color: '#484f58', font: { size: 11 } },
            },
            y: {
                grid: { color: 'rgba(48,54,61,0.4)', drawBorder: false },
                ticks: { color: '#484f58', font: { size: 10 } },
                title: { display: true, text: yLabel, color: '#484f58', font: { size: 11 } },
                suggestedMin: suggestedMin,
            }
        },
        elements: { point: { radius: 0 }, line: { tension: 0.3, borderWidth: 2 } },
    };
}

function subsample(arr, maxPoints = 300) {
    if (arr.length <= maxPoints) return arr;
    const step = arr.length / maxPoints;
    const result = [];
    for (let i = 0; i < maxPoints; i++) {
        result.push(arr[Math.floor(i * step)]);
    }
    return result;
}

function renderCharts(analysis) {
    destroyCharts();

    const { stats, timeline } = analysis;
    const labels = subsample(timeline).map(formatTimeLabel);

    // FPS Chart
    if (stats.fps) {
        const datasets = [
            { label: 'FPS', data: subsample(stats.fps.values), borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.1)', fill: true },
        ];
        if (stats.fpsPresentedLow1) {
            datasets.push({ label: '1% Low', data: subsample(stats.fpsPresentedLow1.values), borderColor: '#d29922', backgroundColor: 'transparent', borderDash: [4, 2] });
        }
        if (stats.fpsPresentedLow01) {
            datasets.push({ label: '0.1% Low', data: subsample(stats.fpsPresentedLow01.values), borderColor: '#f85149', backgroundColor: 'transparent', borderDash: [2, 2] });
        }
        state.charts.fps = new Chart(document.getElementById('chart-fps'), {
            type: 'line', data: { labels, datasets }, options: makeChartOptions('FPS', 0),
        });
    }

    // Temperature Chart
    {
        const datasets = [];
        if (stats.cpuTemp) datasets.push({ label: 'CPU Temp', data: subsample(stats.cpuTemp.values), borderColor: '#f85149', backgroundColor: 'transparent' });
        if (stats.gpuTemp) datasets.push({ label: 'GPU Temp', data: subsample(stats.gpuTemp.values), borderColor: '#bc8cff', backgroundColor: 'transparent' });
        if (stats.gpuJunctionTemp) datasets.push({ label: 'VRAM Junction', data: subsample(stats.gpuJunctionTemp.values), borderColor: '#f778ba', backgroundColor: 'transparent', borderDash: [4, 2] });
        if (stats.liquidTemp) datasets.push({ label: 'Liquid', data: subsample(stats.liquidTemp.values), borderColor: '#39d2c0', backgroundColor: 'transparent' });
        if (datasets.length > 0) {
            state.charts.temp = new Chart(document.getElementById('chart-temp'), {
                type: 'line', data: { labels, datasets }, options: makeChartOptions('°C'),
            });
        }
    }

    // Clock Speeds Chart
    {
        const datasets = [];
        if (stats.cpuClock) datasets.push({ label: 'CPU Clock', data: subsample(stats.cpuClock.values), borderColor: '#58a6ff', backgroundColor: 'transparent' });
        if (stats.gpuClock) datasets.push({ label: 'GPU Clock', data: subsample(stats.gpuClock.values), borderColor: '#bc8cff', backgroundColor: 'transparent' });
        if (datasets.length > 0) {
            state.charts.clocks = new Chart(document.getElementById('chart-clocks'), {
                type: 'line', data: { labels, datasets }, options: makeChartOptions('MHz'),
            });
        }
    }

    // Power & Usage Chart (dual axis)
    {
        const datasets = [];
        if (stats.cpuPower) datasets.push({ label: 'CPU Power', data: subsample(stats.cpuPower.values), borderColor: '#d29922', backgroundColor: 'rgba(210,153,34,0.1)', fill: true, yAxisID: 'y' });
        if (stats.gpuPower) datasets.push({ label: 'GPU Power', data: subsample(stats.gpuPower.values), borderColor: '#f778ba', backgroundColor: 'rgba(247,120,186,0.1)', fill: true, yAxisID: 'y' });
        if (stats.cpuUsage) datasets.push({ label: 'CPU Usage', data: subsample(stats.cpuUsage.values), borderColor: '#3fb950', backgroundColor: 'transparent', yAxisID: 'y1', borderDash: [4, 2] });
        if (stats.gpuLoad) datasets.push({ label: 'GPU Load', data: subsample(stats.gpuLoad.values), borderColor: '#39d2c0', backgroundColor: 'transparent', yAxisID: 'y1', borderDash: [4, 2] });

        if (datasets.length > 0) {
            const opts = makeChartOptions('Watts', 0);
            opts.scales.y.title.text = 'Watts';
            opts.scales.y1 = {
                position: 'right',
                grid: { drawOnChartArea: false },
                ticks: { color: '#484f58', font: { size: 10 } },
                title: { display: true, text: 'Usage %', color: '#484f58', font: { size: 11 } },
                suggestedMin: 0,
                suggestedMax: 100,
            };
            state.charts.power = new Chart(document.getElementById('chart-power'), {
                type: 'line', data: { labels, datasets }, options: opts,
            });
        }
    }
}

// ============================================
// SECTION 9B: WORTH CHECKING
// ============================================

function renderWorthChecking(items) {
    const section = document.getElementById('worth-checking-section');
    const container = document.getElementById('worth-checking-items');

    if (!items || items.length === 0) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');
    container.innerHTML = '';

    const grid = document.createElement('div');
    grid.className = 'wc-grid';

    for (const item of items) {
        const el = document.createElement('div');
        el.className = 'wc-item';

        const valuesHtml = item.values ? `
            <div class="wc-values">
                ${item.values.map(v => `<div class="wc-val">${v.label}: <span>${v.val}</span></div>`).join('')}
            </div>
        ` : '';

        el.innerHTML = `
            <div class="wc-icon ${item.icon}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
            </div>
            <div class="wc-content">
                <div class="wc-title">${item.title}</div>
                <div class="wc-detail">${item.detail}</div>
                ${valuesHtml}
            </div>
        `;
        grid.appendChild(el);
    }

    container.appendChild(grid);
}

// ============================================
// SECTION 10: ALL STATS
// ============================================

function renderAllStats(analysis) {
    const container = document.getElementById('all-stats-content');
    container.innerHTML = '';

    for (const [catKey, columns] of Object.entries(analysis.allStats)) {
        if (!columns || columns.length === 0) continue;
        const cat = CATEGORIES[catKey];

        const section = document.createElement('div');
        section.className = 'stats-category';

        const chevronSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

        const header = document.createElement('div');
        header.className = 'stats-category-header';
        header.innerHTML = `<span>${cat.label}<span class="stats-category-count">${columns.length} metrics</span></span>${chevronSvg}`;

        const body = document.createElement('div');
        body.className = 'hidden';
        body.innerHTML = `
            <div class="stats-table-wrap">
                <table class="stats-table">
                    <thead><tr><th>Metric</th><th>Min</th><th>Avg</th><th>Max</th><th>Last</th></tr></thead>
                    <tbody>
                        ${columns.map(c => `
                            <tr>
                                <td title="${c.name}">${c.name}</td>
                                <td class="val-min">${c.stats.min.toFixed(2)}</td>
                                <td class="val-avg">${c.stats.avg.toFixed(2)}</td>
                                <td class="val-max">${c.stats.max.toFixed(2)}</td>
                                <td>${c.stats.last.toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;

        header.addEventListener('click', () => {
            body.classList.toggle('hidden');
            header.classList.toggle('open');
        });

        section.appendChild(header);
        section.appendChild(body);
        container.appendChild(section);
    }
}

// ============================================
// SECTION 11: IMAGE EXPORT
// ============================================

// Benchmark color grading: green = good, yellow = ok, red = bad
const BM_GREEN = '#3fb950';
const BM_YELLOW = '#d29922';
const BM_RED = '#f85149';

function gradeMetric(type, value, context) {
    // context carries extra info for relative checks (e.g. avg fps for 1% low)
    switch (type) {
        case 'fps':
            if (value >= 60) return BM_GREEN;
            if (value >= 30) return BM_YELLOW;
            return BM_RED;
        case 'fps_1low': {
            const avg = context?.avg || 60;
            const ratio = value / avg;
            if (ratio >= 0.6) return BM_GREEN;
            if (ratio >= 0.4) return BM_YELLOW;
            return BM_RED;
        }
        case 'frametime':
            if (value <= 16.7) return BM_GREEN;
            if (value <= 33.3) return BM_YELLOW;
            return BM_RED;
        case 'cpu_temp':
            if (value < 70) return BM_GREEN;
            if (value < 85) return BM_YELLOW;
            return BM_RED;
        case 'gpu_temp':
            if (value < 75) return BM_GREEN;
            if (value < 85) return BM_YELLOW;
            return BM_RED;
        case 'vram_temp':
            if (value < 85) return BM_GREEN;
            if (value < 100) return BM_YELLOW;
            return BM_RED;
        case 'cpu_clock': {
            // grade based on how close avg is to max
            const max = context?.max || value;
            const ratio = value / max;
            if (ratio >= 0.92) return BM_GREEN;
            if (ratio >= 0.75) return BM_YELLOW;
            return BM_RED;
        }
        case 'gpu_clock': {
            const max = context?.max || value;
            const ratio = value / max;
            if (ratio >= 0.90) return BM_GREEN;
            if (ratio >= 0.70) return BM_YELLOW;
            return BM_RED;
        }
        case 'cpu_usage':
            // low is good (not bottlenecking)
            if (value < 80) return BM_GREEN;
            if (value < 95) return BM_YELLOW;
            return BM_RED;
        case 'gpu_load':
            // high is good (fully utilized)
            if (value >= 90) return BM_GREEN;
            if (value >= 70) return BM_YELLOW;
            return BM_RED;
        case 'ram':
            if (value < 70) return BM_GREEN;
            if (value < 90) return BM_YELLOW;
            return BM_RED;
        case 'power':
            // power is informational, grade neutral-to-warm
            return BM_GREEN;
        default:
            return BM_GREEN;
    }
}

function gradeLabel(color) {
    if (color === BM_GREEN) return 'GOOD';
    if (color === BM_YELLOW) return 'OK';
    return 'HIGH';
}

function gradeBgTint(color) {
    if (color === BM_GREEN) return 'rgba(63,185,80,0.08)';
    if (color === BM_YELLOW) return 'rgba(210,153,34,0.08)';
    return 'rgba(248,81,73,0.08)';
}

function gradeBorder(color) {
    if (color === BM_GREEN) return 'rgba(63,185,80,0.3)';
    if (color === BM_YELLOW) return 'rgba(210,153,34,0.3)';
    return 'rgba(248,81,73,0.3)';
}

function buildExportMetrics(stats) {
    const s = stats;
    const metrics = [];

    if (s.fps) {
        const fpsColor = gradeMetric('fps', s.fps.avg);
        metrics.push({ label: 'Avg FPS', value: s.fps.avg.toFixed(1), range: `Min ${s.fps.min.toFixed(0)} / Max ${s.fps.max.toFixed(0)}`, color: fpsColor, grade: gradeLabel(fpsColor) });
        const lowColor = gradeMetric('fps_1low', s.fps.low1, { avg: s.fps.avg });
        metrics.push({ label: '1% Low FPS', value: s.fps.low1.toFixed(1), range: `0.1% Low: ${s.fps.low01.toFixed(1)}`, color: lowColor, grade: gradeLabel(lowColor) });
    }
    if (s.frameTime) {
        const c = gradeMetric('frametime', s.frameTime.avg);
        metrics.push({ label: 'Avg Frame Time', value: s.frameTime.avg.toFixed(1) + ' ms', range: `Max ${s.frameTime.max.toFixed(1)} ms`, color: c, grade: gradeLabel(c) });
    }
    if (s.cpuTemp) {
        const c = gradeMetric('cpu_temp', s.cpuTemp.max);
        metrics.push({ label: 'CPU Temp (Peak)', value: s.cpuTemp.max.toFixed(0) + '\u00B0C', range: `Avg ${s.cpuTemp.avg.toFixed(0)}\u00B0C`, color: c, grade: gradeLabel(c) });
    }
    if (s.gpuTemp) {
        const c = gradeMetric('gpu_temp', s.gpuTemp.max);
        metrics.push({ label: 'GPU Temp (Peak)', value: s.gpuTemp.max.toFixed(0) + '\u00B0C', range: `Avg ${s.gpuTemp.avg.toFixed(0)}\u00B0C`, color: c, grade: gradeLabel(c) });
    }
    if (s.gpuJunctionTemp) {
        const c = gradeMetric('vram_temp', s.gpuJunctionTemp.max);
        metrics.push({ label: 'VRAM Junction', value: s.gpuJunctionTemp.max.toFixed(0) + '\u00B0C', range: `Avg ${s.gpuJunctionTemp.avg.toFixed(0)}\u00B0C`, color: c, grade: gradeLabel(c) });
    }
    if (s.cpuClock) {
        const c = gradeMetric('cpu_clock', s.cpuClock.avg, { max: s.cpuClock.max });
        metrics.push({ label: 'CPU Clock (Avg)', value: (s.cpuClock.avg / 1000).toFixed(2) + ' GHz', range: `${(s.cpuClock.min/1000).toFixed(2)} - ${(s.cpuClock.max/1000).toFixed(2)}`, color: c, grade: gradeLabel(c) });
    }
    if (s.gpuClock) {
        const c = gradeMetric('gpu_clock', s.gpuClock.avg, { max: s.gpuClock.max });
        metrics.push({ label: 'GPU Clock (Avg)', value: (s.gpuClock.avg / 1000).toFixed(2) + ' GHz', range: `${(s.gpuClock.min/1000).toFixed(2)} - ${(s.gpuClock.max/1000).toFixed(2)}`, color: c, grade: gradeLabel(c) });
    }
    if (s.cpuPower) {
        const c = gradeMetric('power', s.cpuPower.avg);
        metrics.push({ label: 'CPU Power (Avg)', value: s.cpuPower.avg.toFixed(0) + ' W', range: `Peak ${s.cpuPower.max.toFixed(0)} W`, color: c, grade: gradeLabel(c) });
    }
    if (s.gpuPower) {
        const c = gradeMetric('power', s.gpuPower.avg);
        metrics.push({ label: 'GPU Power (Avg)', value: s.gpuPower.avg.toFixed(0) + ' W', range: `Peak ${s.gpuPower.max.toFixed(0)} W`, color: c, grade: gradeLabel(c) });
    }
    if (s.cpuUsage) {
        const c = gradeMetric('cpu_usage', s.cpuUsage.avg);
        metrics.push({ label: 'CPU Usage (Avg)', value: s.cpuUsage.avg.toFixed(0) + '%', range: `Peak ${s.cpuUsage.max.toFixed(0)}%`, color: c, grade: gradeLabel(c) });
    }
    if (s.gpuLoad) {
        const c = gradeMetric('gpu_load', s.gpuLoad.avg);
        metrics.push({ label: 'GPU Load (Avg)', value: s.gpuLoad.avg.toFixed(0) + '%', range: `Peak ${s.gpuLoad.max.toFixed(0)}%`, color: c, grade: gradeLabel(c) });
    }
    if (s.ramUsage) {
        const c = gradeMetric('ram', s.ramUsage.max);
        metrics.push({ label: 'RAM Usage (Avg)', value: s.ramUsage.avg.toFixed(0) + '%', range: `Peak ${s.ramUsage.max.toFixed(0)}%`, color: c, grade: gradeLabel(c) });
    }

    // Pad to multiple of 4 for grid
    while (metrics.length % 4 !== 0 && metrics.length < 16) {
        metrics.push(null);
    }
    return metrics;
}

function buildExportTemplate(analysis) {
    const template = document.getElementById('export-template');
    const metrics = buildExportMetrics(analysis.stats);

    const warningsHtml = analysis.anomalies.length > 0 ? `
        <div class="export-warnings">
            <div class="export-warnings-title">Attention Items</div>
            ${analysis.anomalies.map(a => `<div class="export-warning-item">${a.message}</div>`).join('')}
        </div>
    ` : '';

    template.innerHTML = `
        <div class="export-card">
            <div class="export-header">
                <div class="export-title">${analysis.name.replace(/\.csv$/i, '')} Benchmark</div>
                <div class="export-meta">
                    <div>${analysis.date}</div>
                    <div>Duration: ${formatDuration(analysis.duration)}</div>
                    <div>${analysis.rows.length} samples</div>
                </div>
            </div>
            <div class="export-grid">
                ${metrics.map(m => m ? `
                    <div class="export-metric" style="border-left:3px solid ${m.color};background:${gradeBgTint(m.color)}">
                        <div class="export-metric-label">
                            <span>${m.label}</span>
                            <span class="export-grade" style="color:${m.color}">${m.grade}</span>
                        </div>
                        <div class="export-metric-value" style="color:${m.color}">${m.value}</div>
                        <div class="export-metric-range">${m.range}</div>
                    </div>
                ` : '<div></div>').join('')}
            </div>
            ${warningsHtml}
            <div class="export-footer">
                <span>HWiNFO Benchmark Analyzer</span>
                <span>Generated ${new Date().toLocaleDateString()}</span>
            </div>
        </div>
    `;
}

async function exportSummaryImage() {
    const analysis = state.files[state.activeIndex];
    if (!analysis) return;

    const btn = document.getElementById('export-btn');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    // Show a loading overlay so the user doesn't see the template flash
    showLoading('Generating summary image...');

    buildExportTemplate(analysis);

    const template = document.getElementById('export-template');

    // Clone into a temporary container that's on-screen but behind the overlay
    const captureHost = document.createElement('div');
    captureHost.style.cssText = 'position:fixed;top:0;left:0;width:1200px;z-index:999;pointer-events:none;';
    captureHost.innerHTML = template.innerHTML;
    // Copy export-template class styles inline for the clone
    const card = captureHost.querySelector('.export-card');
    if (card) {
        card.style.cssText = 'padding:40px;background:linear-gradient(135deg,#0d1117 0%,#161b22 100%);color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
    }
    document.body.appendChild(captureHost);

    try {
        await new Promise(r => setTimeout(r, 150));
        const canvas = await html2canvas(captureHost, {
            backgroundColor: '#0d1117',
            scale: 2,
            useCORS: true,
            logging: false,
            width: 1200,
        });

        const link = document.createElement('a');
        link.download = `${analysis.name.replace(/\.csv$/i, '')}_benchmark_summary.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
    } catch (e) {
        console.error('Export failed, falling back to canvas draw:', e);
        // Fallback: draw manually on canvas
        try {
            const canvas = drawExportCanvas(analysis);
            const link = document.createElement('a');
            link.download = `${analysis.name.replace(/\.csv$/i, '')}_benchmark_summary.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
        } catch (e2) {
            console.error('Canvas fallback also failed:', e2);
            alert('Export failed. See console for details.');
        }
    } finally {
        captureHost.remove();
        hideLoading();
        btn.disabled = false;
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export Summary`;
    }
}

// Pure canvas fallback for image export
function drawExportCanvas(analysis) {
    const baseMetrics = buildExportMetrics(analysis.stats);
    const W = 1200, PAD = 40;
    // Convert to canvas format (range -> sub), filter nulls
    const metrics = baseMetrics.filter(m => m !== null).map(m => ({
        label: m.label, value: m.value, sub: m.range, color: m.color, grade: m.grade,
    }));

    const COLS = 4;
    const rows = Math.ceil(metrics.length / COLS);
    const cellW = (W - PAD * 2 - (COLS - 1) * 16) / COLS;
    const cellH = 90;
    const headerH = 100;
    const warningH = analysis.anomalies.length > 0 ? 30 + analysis.anomalies.length * 22 : 0;
    const footerH = 50;
    const H = PAD + headerH + rows * (cellH + 16) + warningH + footerH + PAD;

    const canvas = document.createElement('canvas');
    canvas.width = W * 2;
    canvas.height = H * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);

    // Background
    const bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, '#0d1117');
    bgGrad.addColorStop(1, '#161b22');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Title
    ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    ctx.fillStyle = '#58a6ff';
    ctx.fillText(analysis.name.replace(/\.csv$/i, '') + ' Benchmark', PAD, PAD + 34);

    ctx.font = '13px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    ctx.fillStyle = '#8b949e';
    const metaText = `${analysis.date}  |  Duration: ${formatDuration(analysis.duration)}  |  ${analysis.rows.length} samples`;
    ctx.fillText(metaText, PAD, PAD + 58);

    // Divider
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, PAD + headerH - 10);
    ctx.lineTo(W - PAD, PAD + headerH - 10);
    ctx.stroke();

    // Metric cards
    let yOff = PAD + headerH;
    metrics.forEach((m, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const x = PAD + col * (cellW + 16);
        const y = yOff + row * (cellH + 16);

        // Card background with color tint
        ctx.fillStyle = gradeBgTint(m.color);
        roundRect(ctx, x, y, cellW, cellH, 8);
        ctx.fill();
        ctx.strokeStyle = '#21262d';
        roundRect(ctx, x, y, cellW, cellH, 8);
        ctx.stroke();

        // Left color accent bar
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.moveTo(x + 4, y);
        ctx.lineTo(x + 4, y + cellH);
        ctx.lineTo(x, y + cellH - 8);
        ctx.quadraticCurveTo(x, y + cellH, x, y + cellH - 8);
        ctx.lineTo(x, y + 8);
        ctx.quadraticCurveTo(x, y, x + 4, y);
        ctx.closePath();
        ctx.fill();

        // Label
        ctx.font = '600 10px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
        ctx.fillStyle = '#8b949e';
        ctx.fillText(m.label.toUpperCase(), x + 16, y + 22);

        // Grade badge (top right)
        if (m.grade) {
            ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
            const badgeW = ctx.measureText(m.grade).width + 12;
            const bx = x + cellW - badgeW - 10;
            const by = y + 10;
            ctx.fillStyle = gradeBgTint(m.color);
            roundRect(ctx, bx, by, badgeW, 18, 9);
            ctx.fill();
            ctx.strokeStyle = gradeBorder(m.color);
            roundRect(ctx, bx, by, badgeW, 18, 9);
            ctx.stroke();
            ctx.fillStyle = m.color;
            ctx.fillText(m.grade, bx + 6, by + 13);
        }

        // Value
        ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
        ctx.fillStyle = m.color;
        ctx.fillText(m.value, x + 16, y + 56);

        // Sub
        ctx.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
        ctx.fillStyle = '#484f58';
        ctx.fillText(m.sub, x + 16, y + 76);
    });

    // Warnings
    if (analysis.anomalies.length > 0) {
        const wy = yOff + rows * (cellH + 16) + 8;
        ctx.fillStyle = 'rgba(248,81,73,0.06)';
        roundRect(ctx, PAD, wy, W - PAD * 2, warningH - 8, 8);
        ctx.fill();

        ctx.font = '600 12px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
        ctx.fillStyle = '#d29922';
        ctx.fillText('Attention Items', PAD + 16, wy + 20);

        ctx.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
        ctx.fillStyle = '#8b949e';
        analysis.anomalies.forEach((a, i) => {
            ctx.fillText('\u2022  ' + a.message, PAD + 16, wy + 40 + i * 22);
        });
    }

    // Footer
    const fy = H - PAD - 10;
    ctx.strokeStyle = '#21262d';
    ctx.beginPath();
    ctx.moveTo(PAD, fy - 16);
    ctx.lineTo(W - PAD, fy - 16);
    ctx.stroke();

    ctx.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    ctx.fillStyle = '#484f58';
    ctx.fillText('HWiNFO Benchmark Analyzer', PAD, fy);
    const dateStr = 'Generated ' + new Date().toLocaleDateString();
    const dateW = ctx.measureText(dateStr).width;
    ctx.fillText(dateStr, W - PAD - dateW, fy);

    return canvas;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ============================================
// SECTION 12: EVENT HANDLERS
// ============================================

function showLoading(text) {
    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.id = 'loading-overlay';
    overlay.innerHTML = `<div class="spinner"></div><div class="loading-text">${text}</div>`;
    document.body.appendChild(overlay);
}

function hideLoading() {
    document.getElementById('loading-overlay')?.remove();
}

async function handleFiles(files) {
    const csvFiles = Array.from(files).filter(f => /\.csv$/i.test(f.name));
    if (csvFiles.length === 0) {
        alert('Please select HWiNFO64 CSV log files.');
        return;
    }

    showLoading('Analyzing benchmark data...');

    // Small delay so loading UI renders
    await new Promise(r => setTimeout(r, 50));

    try {
        state.files = [];
        for (const file of csvFiles) {
            const text = await file.text();
            const { headers, rows } = parseCSV(text);
            const analysis = analyzeFile(file.name, headers, rows);
            state.files.push(analysis);
        }

        state.activeIndex = 0;
        showDashboardView();
        renderFileTabs();
        renderDashboard(state.files[0]);
    } catch (e) {
        console.error('Parse error:', e);
        alert('Error parsing CSV: ' + e.message);
    } finally {
        hideLoading();
    }
}

// Setup event listeners
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) handleFiles(fileInput.files);
    });

    document.getElementById('back-btn').addEventListener('click', () => {
        destroyCharts();
        showUploadView();
    });

    document.getElementById('export-btn').addEventListener('click', exportSummaryImage);

    document.getElementById('toggle-all-stats').addEventListener('click', function () {
        const content = document.getElementById('all-stats-content');
        content.classList.toggle('hidden');
        this.classList.toggle('open');
    });

    // Allow dropping anywhere on the page in upload view
    document.body.addEventListener('dragover', e => e.preventDefault());
    document.body.addEventListener('drop', e => {
        e.preventDefault();
        if (!document.getElementById('upload-view').classList.contains('hidden')) {
            handleFiles(e.dataTransfer.files);
        }
    });
});
