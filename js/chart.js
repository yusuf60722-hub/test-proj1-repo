// charts.js - optional demo charts (NOT required by main simulation)
let charts = {};
let baseOptions = {
    responsive: true,
    animation: false,
    plugins: {
        legend: { position: "bottom" }
    },
    scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true }
    }
};

export function initCharts() {
    if (typeof Chart === "undefined") {
        console.warn("Chart.js not loaded; skipping charts.js init");
        return;
    }

    const mixCtx = document.getElementById("mixedSourcesChart");
    if (mixCtx) {
        charts.mixedSourcesChart = new Chart(mixCtx, {
            type: "bar",
            data: {
                labels: ["1", "2", "3", "4", "5", "6"],
                datasets: [
                    { label: "Solar", data: [8, 10, 12, 14, 16, 18], backgroundColor: "#FFD60A" },
                    { label: "Wind", data: [5, 7, 6, 8, 9, 9], backgroundColor: "#0A84FF" },
                    { label: "Hydro", data: [4, 5, 5, 6, 6, 7], backgroundColor: "#30D158" }
                ]
            },
            options: {
                ...baseOptions,
                scales: {
                    x: { stacked: true, grid: { display: false } },
                    y: { stacked: true, beginAtZero: true }
                }
            }
        });
    }

    const outCtx = document.getElementById("outputBreakdownChart");
    if (outCtx) {
        charts.outputBreakdownChart = new Chart(outCtx, {
            type: "doughnut",
            data: {
                labels: ["Homes", "Industry", "Backup"],
                datasets: [
                    { data: [45, 35, 20], backgroundColor: ["#0A84FF", "#32D74B", "#FF9F0A"] }
                ]
            },
            options: { responsive: true, cutout: "50%" }
        });
    }

    charts.solarChart = createLiveLineChart("solarChart", "#FFD60A");
    charts.windChart = createLiveLineChart("windChart", "#0A84FF");
    charts.hydroChart = createLiveLineChart("hydroChart", "#30D158");
    charts.dieselChart = createLiveLineChart("dieselChart", "#FF453A");

    console.log("charts.js demo charts initialized");
}

function createLiveLineChart(id, color) {
    const el = document.getElementById(id);
    if (!el || typeof Chart === "undefined") return null;

    return new Chart(el, {
        type: "line",
        data: {
            labels: ["1", "2", "3", "4", "5", "6"],
            datasets: [{
                data: [5, 10, 7, 12, 11, 14],
                borderColor: color,
                tension: 0.4
            }]
        },
        options: baseOptions
    });
}