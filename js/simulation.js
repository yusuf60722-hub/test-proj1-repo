// simulation.js - demo model (expects manual inputs)
const MAX_SOLAR_KW = 1000;
const MAX_WIND_KW = 1000;
const MAX_HYDRO_KW = 1000;

let solarNoise = 0, windNoise = 0, hydroNoise = 0;
function smooth(n) { return (n * 0.8) + ((Math.random() - 0.5) * 0.1); }

export function getSolarPower(lightLevel) {
    solarNoise = smooth(solarNoise);
    let output = (lightLevel / 100) * MAX_SOLAR_KW;
    output += output * solarNoise * 0.1;
    return Math.max(0, Math.round(output));
}

export function getWindPower(speed) {
    windNoise = smooth(windNoise);
    const rated = 12;
    let normalized = Math.pow(Math.min(speed, rated) / rated, 3);
    let output = MAX_WIND_KW * normalized;
    output += output * windNoise * 0.1;
    return Math.max(0, Math.round(output));
}

export function getHydroPower(flowPercent) {
    hydroNoise = smooth(hydroNoise);
    let output = (flowPercent / 100) * MAX_HYDRO_KW * 0.9;
    output += output * hydroNoise * 0.05;
    return Math.max(0, Math.round(output));
}
