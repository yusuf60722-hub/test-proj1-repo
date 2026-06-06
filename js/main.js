// main.js - full system logic: sources -> allocation -> batteries -> destinations -> charts + analytics + settings
import { getSolarPower, getWindPower, getHydroPower} from "./simulation.js";

// ---- CONFIG ----
const BASE_TICK_MS = 2000;          // 2 seconds per tick
const TICK_MS = BASE_TICK_MS;
const BASE_TICK_HOURS = TICK_MS / 1000 / 3600; // kW -> kWh conversion
const HISTORY_POINTS = 30;

let speedMultiplier = 1; // 1x, 2x, 5x, 10x

// Initial state
const state = {
    sources: {
        solar: { enabled: true, light: 80, toOutPct: 80, availableKW: 0, history: [] },
        wind: { enabled: true, speed: 8, toOutPct: 70, availableKW: 0, history: [] },
        hydro: { enabled: true, flow: 50, toOutPct: 60, availableKW: 0, history: [] },
        diesel: { enabled: false, on: false, toOutPct: 100, availableKW: 0, history: [] }
    },
    batteries: [],  // {id, capacity_kwh, stored_kwh, maxChargeKW, maxDischargeKW}
    destinations: [], // {id, name, allocPct, lastRecvKW}
    totals: {
        gen_kwh: 0,
        out_kwh: 0,
        saved_kwh: 0,
        perSource_kwh: { solar: 0, wind: 0, hydro: 0, diesel: 0 }
    },
    historyCombined: { gen: [], out: [], timeLabels: [] },
    historyBattery: [], // total stored kWh over time
    shedding: { active: false, shedCount: 0 },
    grid: {
        mode: "grid",
        importKW: 0,
        exportKW: 0
    },

    weather: {
        enabled: false,
        time: 0,              // minutes from 0 to 1440 (full day)
        sunlight: 0,          // 0–100
        wind: 0,              // 0–100
        hydro: 0,              // 0–100
        manualTime: true,   // if true → use slider value, not auto ticking
    },


};

// ---- Charts placeholders ----
let charts = {
    solar: null,
    wind: null,
    hydro: null,
    diesel: null,
    combined: null,
    stackedInputs: null,
    analyticsSourcePie: null,
    analyticsGenTrend: null,
    analyticsBatteryTrend: null,
    analyticsDestinations: null
};

// ---- Utils ----
function q(id) { return document.getElementById(id); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function nowLabel() { return new Date().toLocaleTimeString(); }
function uid(prefix = 'id') { return prefix + Math.random().toString(36).slice(2, 9); }
function pushHistory(arr, v) { arr.push(v); if (arr.length > HISTORY_POINTS) arr.shift(); }

// ---- Battery helpers ----
function addBattery(capacity_kwh, maxChargeKW, maxDischargeKW, initial_kwh = 0) {
    const b = {
        id: uid('bat'),
        capacity_kwh,
        stored_kwh: clamp(initial_kwh, 0, capacity_kwh),
        maxChargeKW,
        maxDischargeKW
    };
    state.batteries.push(b);
    renderBatteriesUI();
    updateSummaryCapacity();
}

function renderBatteriesUI() {
    const container = q('batteriesContainer');
    if (!container) return;
    container.innerHTML = '';
    state.batteries.forEach(b => {
        const card = document.createElement('article');
        card.className = 'card';
        card.innerHTML = `
      <h4>Battery ${b.id}</h4>
      <div>Capacity: <strong>${b.capacity_kwh}</strong> kWh</div>
      <div>Stored: <strong id="stored-${b.id}">${b.stored_kwh.toFixed(2)}</strong> kWh</div>
      <div>Charge rate: ${b.maxChargeKW} kW | Discharge rate: ${b.maxDischargeKW} kW</div>
      <div class="battery-visual"><div id="bar-${b.id}" style="height:${(b.stored_kwh / b.capacity_kwh) * 100}%"></div></div>
      <button data-bid="${b.id}" class="action-btn removeBatteryBtn">Remove</button>
    `;
        container.appendChild(card);
    });

    document.querySelectorAll('.removeBatteryBtn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-bid');
            state.batteries = state.batteries.filter(x => x.id !== id);
            renderBatteriesUI();
            updateSummaryCapacity();
        });
    });
}

function updateSummaryCapacity() {
    const cap = state.batteries.reduce((s, b) => s + b.capacity_kwh, 0);
    if (q('summaryCapacity')) q('summaryCapacity').innerText = cap.toFixed(2);
}

function chargeBatteries(available_kwh) {
    let remaining = available_kwh;
    const effTickHours = BASE_TICK_HOURS * speedMultiplier;
    for (const b of state.batteries) {
        if (remaining <= 0) break;
        const canAccept_kwh = b.capacity_kwh - b.stored_kwh;
        if (canAccept_kwh <= 0) continue;
        const perTickLimit = b.maxChargeKW * effTickHours;
        const chargeThis = Math.min(canAccept_kwh, perTickLimit, remaining);
        b.stored_kwh += chargeThis;
        remaining -= chargeThis;
    }
    return remaining;
}

function dischargeBatteries(deficit_kwh) {
    let need = deficit_kwh;
    let provided = 0;
    const effTickHours = BASE_TICK_HOURS * speedMultiplier;
    const order = [...state.batteries].sort((a, b) => b.stored_kwh - a.stored_kwh);
    for (const b of order) {
        if (need <= 0) break;
        const avail_kwh = b.stored_kwh;
        if (avail_kwh <= 0) continue;
        const perTickLimit = b.maxDischargeKW * effTickHours;
        const take = Math.min(avail_kwh, perTickLimit, need);
        b.stored_kwh -= take;
        need -= take;
        provided += take;
    }
    return provided;
}

// ---- Destinations ----
function renderDestinationsUI() {
    const container = q('destinationsContainer');
    if (!container) return;
    container.innerHTML = '';

    if (state.destinations.length === 0) {
        container.innerHTML = '<p>No destinations added. Add one to allocate output.</p>';
        return;
    }

    state.destinations.forEach(dest => {
        if (dest.priority == null) dest.priority = 2;
        if (dest.demandKW == null) dest.demandKW = 50;
        if (dest.lastRecvKW == null) dest.lastRecvKW = 0;
        if (dest.shedKW == null) dest.shedKW = 0;

        const row = document.createElement('div');
        row.style.marginBottom = '8px';
        row.innerHTML = `
      <div class="dest-row">
        <div class="dest-header" style="display:flex;justify-content:space-between;align-items:center;">
          <strong>${dest.name}</strong>
          <span id="destStatus-${dest.id}" class="status-badge ${dest.shedKW > 0 ? 'error' : 'active'}">
            ${dest.shedKW > 0 ? 'SHED' : 'OK'}
          </span>
        </div>

        <div class="dest-controls" style="display:flex;flex-direction:column;gap:4px;margin:6px 0;">
          <label>Priority:
            <select class="destPriority" data-did="${dest.id}">
              <option value="1"${dest.priority === 1 ? ' selected' : ''}>1 (Critical)</option>
              <option value="2"${dest.priority === 2 ? ' selected' : ''}>2</option>
              <option value="3"${dest.priority === 3 ? ' selected' : ''}>3</option>
              <option value="4"${dest.priority === 4 ? ' selected' : ''}>4 (Low)</option>
            </select>
          </label>

          <label>Demand:
            <input type="range" min="0" max="500" value="${dest.demandKW}" class="destDemand" data-did="${dest.id}">
            <span id="destDemandVal-${dest.id}">${dest.demandKW} kW</span>
          </label>
        </div>

        <div>Supplied: <span id="destRecv-${dest.id}">${dest.lastRecvKW.toFixed(2)}</span> kW</div>
        <button data-did="${dest.id}" class="action-btn removeDestBtn" style="margin-top:6px;">Remove</button>
      </div>
    `;
        container.appendChild(row);
    });

    // priority change
    document.querySelectorAll('.destPriority').forEach(sel => {
        sel.addEventListener('change', () => {
            const id = sel.getAttribute('data-did');
            const d = state.destinations.find(x => x.id === id);
            if (d) d.priority = parseInt(sel.value);
        });
    });

    // demand slider
    document.querySelectorAll('.destDemand').forEach(sl => {
        sl.addEventListener('input', () => {
            const id = sl.getAttribute('data-did');
            const v = parseInt(sl.value);
            const d = state.destinations.find(x => x.id === id);
            if (d) d.demandKW = v;
            const label = q(`destDemandVal-${id}`);
            if (label) label.innerText = v + ' kW';
        });
    });

    // remove button
    document.querySelectorAll('.removeDestBtn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-did');
            state.destinations = state.destinations.filter(x => x.id !== id);
            renderDestinationsUI();
        });
    });
}


function addDestination(name = 'Dest ' + (state.destinations.length + 1)) {
    const id = uid('dst');
    state.destinations.push({
        id,
        name,
        priority: 2,
        demandKW: 50,
        lastRecvKW: 0,
        shedKW: 0
    });
    renderDestinationsUI();
}


// ---- Charts init ----
function initCharts() {
    function makeLineChart(ctxId, label, color) {
        const el = q(ctxId);
        if (!el || typeof Chart === 'undefined') return null;
        return new Chart(el.getContext('2d'), {
            type: 'line',
            data: { labels: Array(HISTORY_POINTS).fill(''), datasets: [{ label, data: Array(HISTORY_POINTS).fill(0), borderColor: color, tension: 0.3 }] },
            options: { responsive: true, animation: false, scales: { x: { display: false } } }
        });
    }

    charts.solar = makeLineChart('solarChart', 'Solar (kW)', '#f39c12');
    charts.wind = makeLineChart('windChart', 'Wind (kW)', '#3498db');
    charts.hydro = makeLineChart('hydroChart', 'Hydro (kW)', '#2ecc71');
    charts.diesel = makeLineChart('dieselChart', 'Diesel (kW)', '#95a5a6');

    const cEl = q('combinedChart');
    if (cEl && typeof Chart !== 'undefined') {
        charts.combined = new Chart(cEl.getContext('2d'), {
            type: 'line',
            data: {
                labels: Array(HISTORY_POINTS).fill(''),
                datasets: [
                    { label: 'Generation (kW)', data: Array(HISTORY_POINTS).fill(0), borderColor: '#27ae60', fill: false },
                    { label: 'Output (kW)', data: Array(HISTORY_POINTS).fill(0), borderColor: '#e74c3c', fill: false }
                ]
            },
            options: { responsive: true, animation: false }
        });
    }

    const sEl = q('stackedInputsChart');
    if (sEl && typeof Chart !== 'undefined') {
        charts.stackedInputs = new Chart(sEl.getContext('2d'), {
            type: 'bar',
            data: {
                labels: Array(HISTORY_POINTS).fill(''),
                datasets: [
                    { label: 'Solar', data: Array(HISTORY_POINTS).fill(0), backgroundColor: '#f39c12' },
                    { label: 'Wind', data: Array(HISTORY_POINTS).fill(0), backgroundColor: '#3498db' },
                    { label: 'Hydro', data: Array(HISTORY_POINTS).fill(0), backgroundColor: '#2ecc71' },
                    { label: 'Diesel', data: Array(HISTORY_POINTS).fill(0), backgroundColor: '#95a5a6' }
                ]
            },
            options: { responsive: true, animation: false, scales: { x: { display: false }, y: { beginAtZero: true } }, plugins: { legend: { position: 'bottom' } } }
        });
    }

    const pieEl = q('analyticsSourcePie');
    if (pieEl && typeof Chart !== 'undefined') {
        charts.analyticsSourcePie = new Chart(pieEl.getContext('2d'), {
            type: 'pie',
            data: {
                labels: ['Solar', 'Wind', 'Hydro', 'Diesel'],
                datasets: [{ data: [0, 0, 0, 0], backgroundColor: ['#f39c12', '#3498db', '#2ecc71', '#95a5a6'] }]
            },
            options: { responsive: true, animation: false }
        });
    }

    const genEl = q('analyticsGenTrend');
    if (genEl && typeof Chart !== 'undefined') {
        charts.analyticsGenTrend = new Chart(genEl.getContext('2d'), {
            type: 'line',
            data: { labels: Array(HISTORY_POINTS).fill(''), datasets: [{ label: 'Generation (kW)', data: Array(HISTORY_POINTS).fill(0), borderColor: '#27ae60', tension: 0.3 }] },
            options: { responsive: true, animation: false }
        });
    }

    const batEl = q('analyticsBatteryTrend');
    if (batEl && typeof Chart !== 'undefined') {
        charts.analyticsBatteryTrend = new Chart(batEl.getContext('2d'), {
            type: 'line',
            data: { labels: Array(HISTORY_POINTS).fill(''), datasets: [{ label: 'Stored (kWh)', data: Array(HISTORY_POINTS).fill(0), borderColor: '#9b59b6', tension: 0.3 }] },
            options: { responsive: true, animation: false }
        });
    }

    const destEl = q('analyticsDestinations');
    if (destEl && typeof Chart !== 'undefined') {
        charts.analyticsDestinations = new Chart(destEl.getContext('2d'), {
            type: 'bar',
            data: { labels: [], datasets: [{ label: 'Destinations (kW)', data: [], backgroundColor: '#34495e' }] },
            options: { responsive: true, animation: false, scales: { y: { beginAtZero: true } } }
        });
    }
}

// ---- core tick ----
function tick() {

    updateWeather();

    const s = state.sources;
    const effTickHours = BASE_TICK_HOURS * speedMultiplier;

    // 1) compute available power from each source
    s.solar.availableKW = s.solar.enabled ? getSolarPower(s.solar.light) : 0;
    s.wind.availableKW = s.wind.enabled ? getWindPower(s.wind.speed) : 0;
    s.hydro.availableKW = s.hydro.enabled ? getHydroPower(s.hydro.flow) : 0;
    s.diesel.availableKW = s.diesel.enabled && s.diesel.on ? 50 : 0;

    // UI gauges
    if (q('solarGauge')) q('solarGauge').innerText = s.solar.availableKW + ' kW';
    if (q('windGauge')) q('windGauge').innerText = s.wind.availableKW + ' kW';
    if (q('hydroGauge')) q('hydroGauge').innerText = s.hydro.availableKW + ' kW';
    if (q('dieselGauge')) q('dieselGauge').innerText = s.diesel.availableKW + ' kW';

    // append histories
    pushHistory(s.solar.history, s.solar.availableKW);
    pushHistory(s.wind.history, s.wind.availableKW);
    pushHistory(s.hydro.history, s.hydro.availableKW);
    pushHistory(s.diesel.history, s.diesel.availableKW);

    // update small charts
    updateLineChart(charts.solar, s.solar.history);
    updateLineChart(charts.wind, s.wind.history);
    updateLineChart(charts.hydro, s.hydro.history);
    updateLineChart(charts.diesel, s.diesel.history);

    // 2) split into output vs surplus
    const sourceOutsKW = {
        solar: s.solar.availableKW * (s.solar.toOutPct / 100),
        wind: s.wind.availableKW * (s.wind.toOutPct / 100),
        hydro: s.hydro.availableKW * (s.hydro.toOutPct / 100),
        diesel: s.diesel.availableKW * (s.diesel.toOutPct / 100)
    };
    const sourceSurplusKW = {
        solar: s.solar.availableKW - sourceOutsKW.solar,
        wind: s.wind.availableKW - sourceOutsKW.wind,
        hydro: s.hydro.availableKW - sourceOutsKW.hydro,
        diesel: s.diesel.availableKW - sourceOutsKW.diesel
    };

    const totalGenKW = s.solar.availableKW + s.wind.availableKW + s.hydro.availableKW + s.diesel.availableKW;
    const totalOutKW = sourceOutsKW.solar + sourceOutsKW.wind + sourceOutsKW.hydro + sourceOutsKW.diesel;
    const surplusKW = Object.values(sourceSurplusKW).reduce((a, b) => a + Math.max(0, b), 0);

    // 3) destinations allocation with LOAD SHEDDING
    let remainingKW = totalOutKW;
    let shedCount = 0;

    // sort by priority: 1 (highest) → 4 (lowest)
    const sortedDests = [...state.destinations].sort((a, b) => (a.priority || 2) - (b.priority || 2));

    sortedDests.forEach(d => {
        const demand = d.demandKW || 0;
        let supplied = 0;

        if (remainingKW > 0 && demand > 0) {
            supplied = Math.min(demand, remainingKW);
            remainingKW -= supplied;
        }

        d.lastRecvKW = supplied;
        d.shedKW = Math.max(0, demand - supplied);
        if (d.shedKW > 0.1) shedCount++;
    });

    // update shedding state
    state.shedding.active = shedCount > 0;
    state.shedding.shedCount = shedCount;

    // recompute for analytics/UI
    const totalDestKW = state.destinations.reduce((s, d) => s + (d.lastRecvKW || 0), 0);
    const localUsedKW = totalOutKW - totalDestKW;
    void localUsedKW;


    // ========== GRID MODE LOGIC ==========
    let gridImport = 0;
    let gridExport = 0;

    // total demand = sum of ALL destination demand (not supplied)
    const totalDemandKW = state.destinations.reduce((s, d) => s + d.demandKW, 0);

    // actual supply = how much was given from system output
    const totalSuppliedKW = state.destinations.reduce((s, d) => s + d.lastRecvKW, 0);

    // deficit or surplus
    const deficitKW = totalDemandKW - totalSuppliedKW;
    {// need > 0
        const surplusKW = totalOutKW - totalSuppliedKW;      // extra > 0

        const mode = state.grid.mode;

        if (mode === "grid") {
            if (deficitKW > 0) gridImport = deficitKW;
            if (surplusKW > 0) gridExport = surplusKW;
        }

        if (mode === "island") {
            // NO import/export allowed
            gridImport = 0;
            gridExport = 0;
        }

        if (mode === "hybrid") {
            const totalCap = state.batteries.reduce((s, b) => s + b.capacity_kwh, 0);
            const totalStored = state.batteries.reduce((s, b) => s + b.stored_kwh, 0);
            const soc = totalStored / totalCap;

            // import only if battery low
            if (deficitKW > 0 && soc < 0.20) gridImport = deficitKW;

            // export always allowed
            if (surplusKW > 0) gridExport = surplusKW;
        }

        // store
        state.grid.importKW = gridImport;
        state.grid.exportKW = gridExport;

        // update UI
        if (q('gridImport')) q('gridImport').innerText = gridImport.toFixed(2);
        if (q('gridExport')) q('gridExport').innerText = gridExport.toFixed(2);

        // diesel override: island mode forces diesel ON
        if (mode === "island" && deficitKW > 0) {
            state.sources.diesel.on = true;
            const en = q('dieselEnable');
            if (en) en.checked = true;
        }

    }

    // 4) batteries: charge from surplus
    const surplus_kWh = surplusKW * effTickHours;
    const leftoverAfterCharge_kWh = chargeBatteries(surplus_kWh);
    const charged_kWh = surplus_kWh - leftoverAfterCharge_kWh;

    // 5) energy accounting
    const gen_kWh_thisTick = totalGenKW * effTickHours;
    const out_kWh_thisTick = totalOutKW * effTickHours;

    state.totals.gen_kwh += gen_kWh_thisTick;
    state.totals.out_kwh += out_kWh_thisTick;
    state.totals.saved_kwh += charged_kWh;

    state.totals.perSource_kwh.solar += s.solar.availableKW * effTickHours;
    state.totals.perSource_kwh.wind += s.wind.availableKW * effTickHours;
    state.totals.perSource_kwh.hydro += s.hydro.availableKW * effTickHours;
    state.totals.perSource_kwh.diesel += s.diesel.availableKW * effTickHours;

    // top UI
    if (q('topGen')) q('topGen').innerText = Math.round(totalGenKW) + ' kW';
    if (q('topOut')) q('topOut').innerText = Math.round(totalOutKW) + ' kW';
    const totalStored = state.batteries.reduce((s, b) => s + b.stored_kwh, 0);
    if (q('topStored')) q('topStored').innerText = totalStored.toFixed(2) + ' kWh';

    if (q('summaryGen')) q('summaryGen').innerText = state.totals.gen_kwh.toFixed(3);
    if (q('summaryOut')) q('summaryOut').innerText = state.totals.out_kwh.toFixed(3);
    if (q('summarySaved')) q('summarySaved').innerText = state.totals.saved_kwh.toFixed(3);
    if (q('energySaved')) q('energySaved').innerText = state.totals.saved_kwh.toFixed(3);

    // per-dest UI
    state.destinations.forEach(d => {
        const recv = q(`destRecv-${d.id}`);
        if (recv) recv.innerText = (d.lastRecvKW || 0).toFixed(2);

        const st = q(`destStatus-${d.id}`);
        if (st) {
            if (d.shedKW > 0.1) {
                st.innerText = 'SHED';
                st.classList.add('error');
                st.classList.remove('active');
            } else {
                st.innerText = 'OK';
                st.classList.remove('error');
                st.classList.add('active');
            }
        }
    });


    // battery visuals
    state.batteries.forEach(b => {
        const bar = q(`bar-${b.id}`);
        const storedEl = q(`stored-${b.id}`);
        if (bar) bar.style.height = ((b.stored_kwh / Math.max(1, b.capacity_kwh)) * 100) + '%';
        if (storedEl) storedEl.innerText = b.stored_kwh.toFixed(2);
    });

    // history for combined & battery
    pushHistoryCombined(totalGenKW, totalOutKW);
    pushHistory(state.historyBattery, totalStored);
    if (state.historyBattery.length > HISTORY_POINTS) state.historyBattery.shift();

    updateCombinedCharts();
    updateAnalyticsCharts();

    // slider labels (guard if missing)
    if (q('solarToOutVal')) q('solarToOutVal').innerText = s.solar.toOutPct + '%';
    if (q('windToOutVal')) q('windToOutVal').innerText = s.wind.toOutPct + '%';
    if (q('hydroToOutVal')) q('hydroToOutVal').innerText = s.hydro.toOutPct + '%';
    if (q('dieselToOutVal')) q('dieselToOutVal').innerText = s.diesel.toOutPct + '%';
}

function updateLineChart(chart, dataArr) {
    if (!chart) return;
    chart.data.labels = dataArr.map(() => '');
    chart.data.datasets[0].data = dataArr;
    chart.update();
}

function pushStackedHistory(solar, wind, hydro, diesel) {
    if (!charts.stackedInputs) return;
    const ds = charts.stackedInputs.data.datasets;
    ds[0].data.push(solar);
    ds[1].data.push(wind);
    ds[2].data.push(hydro);
    ds[3].data.push(diesel);
    if (ds[0].data.length > HISTORY_POINTS) ds.forEach(d => d.data.shift());
    charts.stackedInputs.update();
}

function pushHistoryCombined(genKW, outKW) {
    pushHistory(state.historyCombined.gen, genKW);
    pushHistory(state.historyCombined.out, outKW);
    pushHistory(state.historyCombined.timeLabels, nowLabel());
}

function updateCombinedCharts() {
    if (charts.combined) {
        charts.combined.data.labels = state.historyCombined.timeLabels.slice();
        charts.combined.data.datasets[0].data = state.historyCombined.gen.slice();
        charts.combined.data.datasets[1].data = state.historyCombined.out.slice();
        charts.combined.update();
    }

    const s = state.sources;
    pushStackedHistory(s.solar.availableKW, s.wind.availableKW, s.hydro.availableKW, s.diesel.availableKW);
}

// ---- Analytics charts update ----
function updateAnalyticsCharts() {
    const src = state.totals.perSource_kwh;
    if (charts.analyticsSourcePie) {
        charts.analyticsSourcePie.data.datasets[0].data = [
            src.solar, src.wind, src.hydro, src.diesel
        ];
        charts.analyticsSourcePie.update();
    }

    if (charts.analyticsGenTrend) {
        charts.analyticsGenTrend.data.labels = state.historyCombined.timeLabels.slice();
        charts.analyticsGenTrend.data.datasets[0].data = state.historyCombined.gen.slice();
        charts.analyticsGenTrend.update();
    }

    if (charts.analyticsBatteryTrend) {
        charts.analyticsBatteryTrend.data.labels = state.historyBattery.map(() => '');
        charts.analyticsBatteryTrend.data.datasets[0].data = state.historyBattery.slice();
        charts.analyticsBatteryTrend.update();
    }

    if (charts.analyticsDestinations) {
        const labels = state.destinations.map(d => d.name);
        const data = state.destinations.map(d => d.lastRecvKW || 0);
        charts.analyticsDestinations.data.labels = labels;
        charts.analyticsDestinations.data.datasets[0].data = data;
        charts.analyticsDestinations.update();
    }
}

// ---- UI binding ----
function bindUI() {
    // Sources controls
    q('solarLight')?.addEventListener('input', e => {
        state.sources.solar.light = parseInt(e.target.value);
        if (q('solarLightValue')) q('solarLightValue').innerText = e.target.value + '%';
    });
    q('solarToOut')?.addEventListener('input', e => {
        state.sources.solar.toOutPct = parseInt(e.target.value);
        if (q('solarToOutVal')) q('solarToOutVal').innerText = e.target.value + '%';
    });

    q('windSpeed')?.addEventListener('input', e => {
        state.sources.wind.speed = parseInt(e.target.value);
        if (q('windSpeedValue')) q('windSpeedValue').innerText = e.target.value + ' m/s';
    });
    q('windToOut')?.addEventListener('input', e => {
        state.sources.wind.toOutPct = parseInt(e.target.value);
        if (q('windToOutVal')) q('windToOutVal').innerText = e.target.value + '%';
    });

    q('hydroFlow')?.addEventListener('input', e => {
        state.sources.hydro.flow = parseInt(e.target.value);
        if (q('hydroFlowVal')) q('hydroFlowVal').innerText = e.target.value + '%';
    });
    q('hydroToOut')?.addEventListener('input', e => {
        state.sources.hydro.toOutPct = parseInt(e.target.value);
        if (q('hydroToOutVal')) q('hydroToOutVal').innerText = e.target.value + '%';
    });

    q('dieselEnable')?.addEventListener('change', e => {
        state.sources.diesel.on = e.target.checked;
        if (q('dieselStatus')) q('dieselStatus').innerText = e.target.checked ? 'Active' : 'Offline';
    });
    q('dieselToOut')?.addEventListener('input', e => {
        state.sources.diesel.toOutPct = parseInt(e.target.value);
        if (q('dieselToOutVal')) q('dieselToOutVal').innerText = e.target.value + '%';
    });

    // Destinations / Batteries
    q('addDestinationBtn')?.addEventListener('click', () => {
        const name = prompt('Destination name (e.g. Grid, Plant A)') || ('Dest ' + (state.destinations.length + 1));
        addDestination(name);
    });

    q('addBatteryBtn')?.addEventListener('click', () => {
        const cap = parseFloat(q('newBatteryCapacity').value) || 500;
        const cr = parseFloat(q('newBatteryChargeRate').value) || 200;
        const dr = parseFloat(q('newBatteryDischargeRate').value) || 200;
        addBattery(cap, cr, dr, 0);
    });

    q('forceAllToOutput')?.addEventListener('click', () => {
        for (const key of Object.keys(state.sources)) state.sources[key].toOutPct = 100;
        ['solarToOut', 'windToOut', 'hydroToOut', 'dieselToOut'].forEach(id => { if (q(id)) q(id).value = 100; });
    });

    q('forceAllToBattery')?.addEventListener('click', () => {
        for (const key of Object.keys(state.sources)) state.sources[key].toOutPct = 0;
        ['solarToOut', 'windToOut', 'hydroToOut', 'dieselToOut'].forEach(id => { if (q(id)) q(id).value = 0; });
    });

    // Theme toggle (existing)
    q('themeToggleBtn')?.addEventListener('click', () => {
        document.body.classList.toggle('dark');
    });

    // Settings: explicit theme
    q('themeLight')?.addEventListener('click', () => {
        document.body.classList.remove('dark');
    });
    q('themeDark')?.addEventListener('click', () => {
        document.body.classList.add('dark');    
    });

    q('gridMode')?.addEventListener('change', e => {
        state.grid.mode = e.target.value;
    });

    q('weatherEnabled')?.addEventListener('change', e => {
        state.weather.enabled = e.target.checked;
    });

    q('weatherTimeSlider')?.addEventListener('input', e => {
        state.weather.manualTime = true;
        state.weather.time = parseInt(e.target.value);
        updateWeather(true);  // force update immediately
    });




    // Simulation speed
    document.querySelectorAll('.simSpeed').forEach(btn => {
        btn.addEventListener('click', () => {
            const sp = parseFloat(btn.getAttribute('data-speed')) || 1;
            speedMultiplier = sp;
        });
    });

    // Reset buttons
    q('resetBatteries')?.addEventListener('click', () => {
        state.batteries.forEach(b => b.stored_kwh = 0);
        renderBatteriesUI();
    });

    q('resetDestinations')?.addEventListener('click', () => {
        state.destinations = [];
        renderDestinationsUI();
    });

    q('resetAll')?.addEventListener('click', () => {
        location.reload();
    });

    // Presets
    document.querySelectorAll('.preset').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.getAttribute('data-preset');
            applyPreset(type);
        });
    });

    // Logout
    q('logoutBtn')?.addEventListener('click', () => {
        localStorage.removeItem('userRole');
        localStorage.removeItem('username');
        window.location.href = 'index.html';
    });

    // Tabs
    initTabs();

    // Role display (basic)
    applyRolePermissions();
}

// ---- Presets ----
function applyPreset(type) {
    const s = state.sources;
    switch (type) {
        case 'sunny':
            s.solar.light = 100; s.solar.toOutPct = 90;
            s.wind.speed = 5; s.wind.toOutPct = 40;
            s.hydro.flow = 40; s.hydro.toOutPct = 50;
            s.diesel.on = false;
            break;
        case 'windy':
            s.solar.light = 30; s.solar.toOutPct = 30;
            s.wind.speed = 18; s.wind.toOutPct = 90;
            s.hydro.flow = 50; s.hydro.toOutPct = 50;
            s.diesel.on = false;
            break;
        case 'hydro':
            s.solar.light = 40; s.solar.toOutPct = 40;
            s.wind.speed = 8; s.wind.toOutPct = 40;
            s.hydro.flow = 100; s.hydro.toOutPct = 90;
            s.diesel.on = false;
            break;
        case 'diesel':
            s.solar.light = 0; s.solar.toOutPct = 0;
            s.wind.speed = 0; s.wind.toOutPct = 0;
            s.hydro.flow = 0; s.hydro.toOutPct = 0;
            s.diesel.on = true; s.diesel.toOutPct = 100;
            break;
    }

    if (q('solarLight')) { q('solarLight').value = s.solar.light; if (q('solarLightValue')) q('solarLightValue').innerText = s.solar.light + '%'; }
    if (q('solarToOut')) { q('solarToOut').value = s.solar.toOutPct; if (q('solarToOutVal')) q('solarToOutVal').innerText = s.solar.toOutPct + '%'; }

    if (q('windSpeed')) { q('windSpeed').value = s.wind.speed; if (q('windSpeedValue')) q('windSpeedValue').innerText = s.wind.speed + ' m/s'; }
    if (q('windToOut')) { q('windToOut').value = s.wind.toOutPct; if (q('windToOutVal')) q('windToOutVal').innerText = s.wind.toOutPct + '%'; }

    if (q('hydroFlow')) { q('hydroFlow').value = s.hydro.flow; if (q('hydroFlowVal')) q('hydroFlowVal').innerText = s.hydro.flow + '%'; }
    if (q('hydroToOut')) { q('hydroToOut').value = s.hydro.toOutPct; if (q('hydroToOutVal')) q('hydroToOutVal').innerText = s.hydro.toOutPct + '%'; }

    if (q('dieselEnable')) q('dieselEnable').checked = s.diesel.on;
    if (q('dieselToOut')) { q('dieselToOut').value = s.diesel.toOutPct; if (q('dieselToOutVal')) q('dieselToOutVal').innerText = s.diesel.toOutPct + '%'; }

    if (q('dieselStatus')) q('dieselStatus').innerText = s.diesel.on ? 'Active' : 'Offline';
}

// ---- Tabs ----
function initTabs() {
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabs = document.querySelectorAll('.tab');
    if (!navButtons.length || !tabs.length) return;

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            navButtons.forEach(b => b.classList.remove('active'));
            tabs.forEach(t => t.classList.remove('active'));

            btn.classList.add('active');
            const tabId = btn.getAttribute('data-tab');
            const activeTab = document.getElementById(`tab-${tabId}`);
            if (activeTab) activeTab.classList.add('active');
        });
    });
}

// ---- Role display (minimal) ----
function applyRolePermissions() {
    const role = localStorage.getItem('userRole') || 'admin';
    const username = localStorage.getItem('username') || '';

    const roleLabel = q('roleLabel');
    if (roleLabel) roleLabel.innerText = role.charAt(0).toUpperCase() + role.slice(1);

    const avatar = document.querySelector('.avatar');
    if (avatar && username) avatar.innerText = username.slice(0, 2).toUpperCase();

    if (role === 'viewer') {
        const controls = document.querySelectorAll('button, input, select');
        controls.forEach(el => {
            if (el.id === 'logoutBtn' || el.classList.contains('nav-btn')) return;
            el.disabled = true;
            el.classList.add('disabled-control');
        });
    }
}

// ---- PUBLIC ENTRY ----
export function initApp() {
    if (!q('combinedChart')) return;

    if (state.batteries.length === 0) {
        addBattery(2000, 500, 500, 1000);
        addBattery(500, 200, 200, 250);
    }

    if (state.destinations.length === 0) {
        addDestination('Grid');
        addDestination('Local Factory');
    }

    initCharts();
    bindUI();

    setInterval(tick, TICK_MS);
}


// =========================
// ADVANCED FEATURES (Tier 1 + Themes)
// =========================

// simple flag for auto-balance
let autoBalanceOn = false;

// init extra controls after page load (runs only on dashboard)
window.addEventListener("load", () => {
    // if not on dashboard, skip
    if (!document.getElementById("tab-dashboard")) return;

    // Auto-balance toggle
    const ab = document.getElementById("autoBalanceToggle");
    if (ab) {
        autoBalanceOn = ab.checked;
        ab.addEventListener("change", () => {
            autoBalanceOn = ab.checked;
        });
    }

    // Theme presets
    const themeBtns = [
        { id: "themeLight", mode: "light" },
        { id: "themeDark", mode: "dark" },
        { id: "themeSolar", mode: "solar" },
        { id: "themeBlue", mode: "blue" },
        { id: "themeGreen", mode: "green" }
    ];
    themeBtns.forEach(t => {
        const btn = document.getElementById(t.id);
        if (!btn) return;
        btn.addEventListener("click", () => applyTheme(t.mode));
    });

    // Housekeeping loop: auto-balance + forecast + alerts every 3s
    setInterval(() => {
        if (!document.getElementById("tab-dashboard")) return;
        runAutoBalance();
        updateForecastPanel();
        updateAlertsPanel();
    }, 3000);
});

// apply visual theme
function applyTheme(mode) {
    const body = document.body;
    body.classList.remove("dark", "theme-solar", "theme-blue", "theme-green");

    switch (mode) {
        case "dark":
            body.classList.add("dark");
            break;
        case "solar":
            body.classList.add("theme-solar");
            break;
        case "blue":
            body.classList.add("theme-blue");
            break;
        case "green":
            body.classList.add("theme-green");
            break;
        case "light":
        default:
            // default light: nothing
            break;
    }
}

// auto-balance logic: adjust source output % and diesel based on battery SOC
function runAutoBalance() {
    if (!autoBalanceOn) return;
    if (!window.state) return; // safety if state not in scope (but in our file it is)

    try {
        const s = state.sources;
        const totalCap = state.batteries.reduce((sum, b) => sum + b.capacity_kwh, 0);
        const totalStored = state.batteries.reduce((sum, b) => sum + b.stored_kwh, 0);
        const soc = totalCap > 0 ? totalStored / totalCap : 0;

        const lastGen = state.historyCombined.gen.length
            ? state.historyCombined.gen[state.historyCombined.gen.length - 1]
            : 0;

        // Low battery → charge more, maybe use diesel
        if (soc < 0.2) {
            s.solar.toOutPct = Math.max(30, s.solar.toOutPct - 10);
            s.wind.toOutPct = Math.max(30, s.wind.toOutPct - 10);
            s.hydro.toOutPct = Math.max(30, s.hydro.toOutPct - 10);

            if (lastGen < 200) {
                s.diesel.on = true;
                const dieselEnable = document.getElementById("dieselEnable");
                if (dieselEnable) dieselEnable.checked = true;
            }
        }

        // High battery → send more to output, shut diesel
        if (soc > 0.8) {
            s.solar.toOutPct = Math.min(95, s.solar.toOutPct + 10);
            s.wind.toOutPct = Math.min(95, s.wind.toOutPct + 10);
            s.hydro.toOutPct = Math.min(95, s.hydro.toOutPct + 10);

            s.diesel.on = false;
            const dieselEnable = document.getElementById("dieselEnable");
            if (dieselEnable) dieselEnable.checked = false;
        }

        // push new values into sliders & labels if they exist
        const ids = [
            ["solarToOut", "solarToOutVal", s.solar.toOutPct],
            ["windToOut", "windToOutVal", s.wind.toOutPct],
            ["hydroToOut", "hydroToOutVal", s.hydro.toOutPct],
            ["dieselToOut", "dieselToOutVal", s.diesel.toOutPct]
        ];

        ids.forEach(([sliderId, labelId, val]) => {
            const sl = document.getElementById(sliderId);
            const lb = document.getElementById(labelId);
            if (sl) sl.value = val;
            if (lb) lb.innerText = val + "%";
        });

        // update diesel status text
        const dStatus = document.getElementById("dieselStatus");
        if (dStatus) dStatus.innerText = s.diesel.on ? "Active" : "Offline";
    } catch (e) {
        // fail silent; demo only
    }
}

// simple forecast based on last 5 points
function updateForecastPanel() {
    if (!document.getElementById("forecastGen")) return;
    if (!state.historyCombined.gen.length) return;

    const genHist = state.historyCombined.gen;
    const batHist = state.historyBattery;

    const lastN = 5;
    const sliceGen = genHist.slice(-lastN);
    const avgGen =
        sliceGen.reduce((a, b) => a + b, 0) / (sliceGen.length || 1);

    const lastStored =
        batHist.length ? batHist[batHist.length - 1] : 0;

    // super-simple: assume same net trend for next 15 min
    const forecastGen = avgGen;
    const forecastBattery = lastStored; // keep flat to avoid nonsense

    document.getElementById("forecastGen").innerText =
        Math.round(forecastGen) + " kW";
    document.getElementById("forecastBattery").innerText =
        forecastBattery.toFixed(2) + " kWh";
}

// alert system (battery low, diesel running, high gen)
function updateAlertsPanel() {
    const alertList = document.getElementById("alertList");
    const logBox = document.getElementById("logBox");
    if (!alertList || !logBox) return;

    alertList.innerHTML = "";

    const totalCap = state.batteries.reduce((s, b) => s + b.capacity_kwh, 0);
    const totalStored = state.batteries.reduce((s, b) => s + b.stored_kwh, 0);
    const soc = totalCap > 0 ? totalStored / totalCap : 0;

    const lastGen = state.historyCombined.gen.length
        ? state.historyCombined.gen[state.historyCombined.gen.length - 1]
        : 0;

    const dieselOn = state.sources.diesel.on;

    const alerts = [];

    if (soc < 0.15) alerts.push({ msg: "Battery critically low!", level: "high" });
    else if (soc < 0.3) alerts.push({ msg: "Battery low", level: "normal" });

    if (dieselOn) alerts.push({ msg: "Diesel generator running", level: "normal" });

    if (lastGen > 400) alerts.push({ msg: "High generation, consider exporting to grid", level: "normal" });

    if (state.shedding && state.shedding.active) {
        alerts.push({
            msg: `Load shedding active (${state.shedding.shedCount} destination(s) curtailed)`,
            level: "high"
        });
    }

    if (state.grid.importKW > 0) {
        alerts.push({ msg: `Grid Import: ${state.grid.importKW.toFixed(1)} kW`, level: "normal" });
    }

    if (state.grid.exportKW > 0) {
        alerts.push({ msg: `Grid Export: ${state.grid.exportKW.toFixed(1)} kW`, level: "normal" });
    }



    const ts = new Date().toLocaleTimeString();

    alerts.forEach(a => {
        const li = document.createElement("li");
        li.className = "alert " + (a.level === "high" ? "high-alert" : "normal-alert");
        li.textContent = `[${ts}] ${a.msg}`;
        alertList.appendChild(li);

        const p = document.createElement("p");
        p.textContent = `[${ts}] ${a.msg}`;
        logBox.appendChild(p);
        if (logBox.children.length > 100) logBox.removeChild(logBox.firstChild);
        logBox.scrollTop = logBox.scrollHeight;
    });
}


// ========== WEATHER ENGINE ==========

// Smooth noise for wind
function smoothNoise(prev, speed = 0.03, intensity = 5) {
    return prev + (Math.random() - 0.5) * intensity * speed;
}

// Update weather every tick
function updateWeather() {
    if (!state.weather.enabled) return;

    // Advance time: 1 tick = ~1 min
    state.weather.time = (state.weather.time + 1) % 1440;

    const t = state.weather.time;

    // --- SOLAR (sunlight curve) ---
    // Peak at noon (720 minutes), near zero at night
    const dayProgress = Math.abs(t - 720) / 720;  // 0 at noon, 1 at night
    let sunlight = 100 * (1 - dayProgress);       // inverted bell curve

    sunlight = Math.max(0, sunlight);             // clamp
    state.weather.sunlight = sunlight;

    // --- WIND (smooth noise) ---
    state.weather.wind = Math.min(100, Math.max(0,
        smoothNoise(state.weather.wind, 0.05, 8)
    ));

    // --- HYDRO (slow drift) ---
    state.weather.hydro = Math.min(100, Math.max(0,
        smoothNoise(state.weather.hydro, 0.01, 3)
    ));

    // Update UI
    const hh = String(Math.floor(t / 60)).padStart(2, '0');
    const mm = String(t % 60).padStart(2, '0');

    q('weatherTime').innerText = `${hh}:${mm}`;
    q('weatherSun').innerText = `${state.weather.sunlight.toFixed(1)} %`;
    q('weatherWind').innerText = `${state.weather.wind.toFixed(1)} %`;
    q('weatherHydro').innerText = `${state.weather.hydro.toFixed(1)} %`;

    // Push weather values into simulation ONLY IF manual sliders are untouched
    applyWeatherToSources();
}


// Apply weather values as "available" production
function applyWeatherToSources() {
    if (!state.weather.enabled) return;

    // YOUR MANUAL SLIDERS CONTROL PERCENT → NOT RAW AVAILABLE KW
    // Weather sets the BASE available KW
    const s = state.sources;

    // we assume each source max = 100 kW for simplicity
    s.solar.availableKW = (state.weather.sunlight / 100) * 100;
    s.wind.availableKW = (state.weather.wind / 100) * 100;
    s.hydro.availableKW = (state.weather.hydro / 100) * 100;
}