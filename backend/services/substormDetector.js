/**
 * substormDetector.js
 * Monitors the rate of change of IMF Bz to issue 10-minute substorm
 * precursor alerts — catching events missed by the 3-hour Kp average.
 *
 * Alert conditions:
 *   1. Bz drops below –7 nT (threshold crossing)
 *   2. dBz/dt < –2 nT/min for 3+ consecutive readings (rapid southward turning)
 *   3. Solar wind speed > 500 km/s AND Bz < –5 nT (compound condition)
 *   4. Sustained southward Bz <= –4 nT (early watch condition)
 */
const { getCache } = require('./noaaPoller');

const BZ_THRESHOLD       = -7;    // nT
const BZ_RATE_THRESHOLD  = -2;    // nT/min
const BZ_WATCH_THRESHOLD = -4;    // nT
const SPEED_THRESHOLD    = 500;   // km/s
const HISTORY_LENGTH     = 10;    // readings to maintain for derivative
const MONITOR_INTERVAL_MS = 60000; // 1 minute

const bzHistory = [];
let alertCooldownUntilTs = 0;
let latestSubstormAlert = null;

let broadcastFn = null;

function computeDerivative(history) {
  if (history.length < 2) return 0;
  const recent = history.slice(-3);
  let totalRate = 0;
  for (let i = 1; i < recent.length; i++) {
    const dt = (recent[i].ts - recent[i - 1].ts) / 60000; // ms → minutes
    if (dt <= 0) continue;
    totalRate += (recent[i].bz - recent[i - 1].bz) / dt;
  }
  return totalRate / (recent.length - 1);
}

function classifyAlert(bz, bzRate, speed) {
  // Compound severe: fast solar wind + strongly negative Bz
  if (speed > SPEED_THRESHOLD && bz < -5) {
    return { level: 'SEVERE', message: `High-speed solar wind (${Math.round(speed)} km/s) with Bz=${bz.toFixed(1)} nT — elevated substorm risk`, confidence: 'HIGH' };
  }
  // Threshold crossing
  if (bz < BZ_THRESHOLD) {
    return { level: 'WARNING', message: `Bz crossed ${bz.toFixed(1)} nT — substorm conditions active`, confidence: 'HIGH' };
  }
  // Rapid southward turning
  if (bzRate < BZ_RATE_THRESHOLD) {
    return { level: 'WATCH', message: `Bz turning southward at ${bzRate.toFixed(1)} nT/min — substorm may develop within 10 minutes`, confidence: 'MEDIUM' };
  }
  // Sustained southward IMF even without extreme derivative.
  if (bz <= BZ_WATCH_THRESHOLD) {
    return { level: 'WATCH', message: `Bz is sustained southward at ${bz.toFixed(1)} nT — substorm risk elevated`, confidence: 'LOW' };
  }
  return null;
}

function cooldownMsForLevel(level) {
  if (level === 'WATCH') return 5 * 60 * 1000;
  return 15 * 60 * 1000;
}

function startSubstormMonitor(broadcast) {
  broadcastFn = broadcast;
  console.log('[substormDetector] monitor started');

  setInterval(() => {
    const cache = getCache();
    const sw = cache.solar_wind;
    if (!sw) return;

    const bz = Number(sw.bz);
    const speed = Number(sw.speed || 400);
    if (!Number.isFinite(bz)) return;

    // Append to history
    bzHistory.push({ ts: Date.now(), bz, speed });
    if (bzHistory.length > HISTORY_LENGTH) bzHistory.shift();

    const bzRate = computeDerivative(bzHistory);
    const alert = classifyAlert(bz, bzRate, speed);
    const now = Date.now();

    if (alert && now >= alertCooldownUntilTs) {
      console.log(`[substormDetector] ALERT: ${alert.level} — ${alert.message}`);
      latestSubstormAlert = {
        ...alert,
        bz,
        bzRate,
        speed,
        ts: new Date().toISOString(),
      };
      broadcastFn('substorm_alert', latestSubstormAlert);

      alertCooldownUntilTs = now + cooldownMsForLevel(alert.level);
    }

    // Always broadcast current telemetry for live gauge
    broadcastFn('solar_wind_update', {
      bz,
      bzRate: parseFloat(bzRate.toFixed(2)),
      speed,
      kp: cache.kp?.kp,
      ts: new Date().toISOString(),
    });
  }, MONITOR_INTERVAL_MS);
}

function getBzHistory() { return bzHistory; }
function getLatestSubstormAlert() { return latestSubstormAlert; }

module.exports = { startSubstormMonitor, getBzHistory, getLatestSubstormAlert };
