/**
 * substormDetector.js
 * Monitors IMF Bz dynamics to issue short-horizon substorm nowcasts
 * that catch photogenic events missed by the 3-hour Kp average.
 *
 * Trigger model:
 *   1) WATCH   => dBz/dt < -2 nT/min for 3+ consecutive 1-minute readings
 *   2) WARNING => Bz < -7 nT
 *   3) SEVERE  => speed > 500 km/s AND Bz < -5 nT
 *
 * State machine behavior:
 *   - Escalation is immediate (WATCH -> WARNING -> SEVERE)
 *   - De-escalation uses hysteresis thresholds to avoid flapping
 *   - Alert clears only after several consecutive quiet samples
 */
const { getCache } = require('./noaaPoller');

const HISTORY_LENGTH = 10;            // readings to maintain for derivative
const MONITOR_INTERVAL_MS = 60000; // 1 minute
const PROFILES = {
  test: {
    bzWarningThreshold: -1.5,
    bzSevereThreshold: -2,
    bzRateWatchThreshold: -0.3,
    speedSevereThreshold: 360,
    watchConsecutiveRequired: 1,
    quietClearRequired: 5,
    sameLevelRebroadcastMs: 2 * 60 * 1000,
    maxActiveAlertAgeMs: 45 * 60 * 1000,
    hysteresis: {
      severe: { bz: -1.5, speed: 340 },
      warning: { bz: -1.0 },
      watch: { bzRate: -0.2 },
    },
  },
  real: {
    bzWarningThreshold: -7,
    bzSevereThreshold: -5,
    bzRateWatchThreshold: -2,
    speedSevereThreshold: 500,
    watchConsecutiveRequired: 3,
    quietClearRequired: 3,
    sameLevelRebroadcastMs: 10 * 60 * 1000,
    maxActiveAlertAgeMs: 20 * 60 * 1000,
    hysteresis: {
      severe: { bz: -4.5, speed: 470 },
      warning: { bz: -5.5 },
      watch: { bzRate: -1.2 },
    },
  },
  // Legacy support
  strict: {
    bzWarningThreshold: -7,
    bzSevereThreshold: -5,
    bzRateWatchThreshold: -2,
    speedSevereThreshold: 500,
    watchConsecutiveRequired: 3,
    quietClearRequired: 3,
    sameLevelRebroadcastMs: 10 * 60 * 1000,
    maxActiveAlertAgeMs: 20 * 60 * 1000,
    hysteresis: {
      severe: { bz: -4.5, speed: 470 },
      warning: { bz: -5.5 },
      watch: { bzRate: -1.2 },
    },
  },
  lenient: {
    bzWarningThreshold: -1.5,
    bzSevereThreshold: -2,
    bzRateWatchThreshold: -0.3,
    speedSevereThreshold: 360,
    watchConsecutiveRequired: 1,
    quietClearRequired: 5,
    sameLevelRebroadcastMs: 2 * 60 * 1000,
    maxActiveAlertAgeMs: 45 * 60 * 1000,
    hysteresis: {
      severe: { bz: -1.5, speed: 340 },
      warning: { bz: -1.0 },
      watch: { bzRate: -0.2 },
    },
  },
};

const bzHistory = [];
let latestSubstormAlert = null;
let activeLevel = null;
let activeEventId = null;
let watchRateBreachCount = 0;
let quietSampleCount = 0;
let lastBroadcastLevel = null;
let lastBroadcastTs = 0;

let broadcastFn = null;
let currentProfile = (() => {
  const env = String(process.env.SUBSTORM_PROFILE || 'test').toLowerCase();
  if (env === 'real' || env === 'strict') return 'real';
  if (env === 'test' || env === 'lenient') return 'test';
  return 'test';
})();

const LEVEL_RANK = { WATCH: 1, WARNING: 2, SEVERE: 3 };

function profileConfig() {
  return PROFILES[currentProfile] || PROFILES.test;
}

function resetState() {
  latestSubstormAlert = null;
  activeLevel = null;
  activeEventId = null;
  watchRateBreachCount = 0;
  quietSampleCount = 0;
  lastBroadcastLevel = null;
  lastBroadcastTs = 0;
}

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

function candidateLevel(bz, bzRate, speed, cfg) {
  if (bzRate < cfg.bzRateWatchThreshold) watchRateBreachCount += 1;
  else watchRateBreachCount = 0;

  // Compound severe: fast solar wind + strongly negative Bz.
  if (speed > cfg.speedSevereThreshold && bz < cfg.bzSevereThreshold) {
    return { level: 'SEVERE', message: `High-speed solar wind (${Math.round(speed)} km/s) with Bz=${bz.toFixed(1)} nT — elevated substorm risk`, confidence: 'HIGH' };
  }

  // Absolute strong southward field.
  if (bz < cfg.bzWarningThreshold) {
    return { level: 'WARNING', message: `Bz crossed ${bz.toFixed(1)} nT — substorm conditions active`, confidence: 'HIGH' };
  }

  // Precursor only when trend persists.
  if (watchRateBreachCount >= cfg.watchConsecutiveRequired) {
    return { level: 'WATCH', message: `Bz turning southward at ${bzRate.toFixed(1)} nT/min — substorm may develop within 10 minutes`, confidence: 'MEDIUM' };
  }

  return null;
}

function applyStateMachine(candidate, bz, bzRate, speed, cfg) {
  if (!activeLevel) {
    if (candidate) {
      quietSampleCount = 0;
      return candidate;
    }
    quietSampleCount = Math.min(quietSampleCount + 1, cfg.quietClearRequired);
    return null;
  }

  const currentRank = LEVEL_RANK[activeLevel] || 0;
  const candidateRank = LEVEL_RANK[candidate?.level] || 0;

  // Immediate escalation.
  if (candidate && candidateRank > currentRank) {
    quietSampleCount = 0;
    return candidate;
  }

  // Maintain current level while hysteresis still holds.
  if (activeLevel === 'SEVERE' && speed >= cfg.hysteresis.severe.speed && bz <= cfg.hysteresis.severe.bz) {
    quietSampleCount = 0;
    return { level: 'SEVERE', message: `High-speed solar wind (${Math.round(speed)} km/s) with Bz=${bz.toFixed(1)} nT — elevated substorm risk`, confidence: 'HIGH' };
  }
  if (activeLevel === 'WARNING' && bz <= cfg.hysteresis.warning.bz) {
    quietSampleCount = 0;
    return { level: 'WARNING', message: `Bz remains strongly southward at ${bz.toFixed(1)} nT`, confidence: 'HIGH' };
  }
  if (activeLevel === 'WATCH' && bzRate <= cfg.hysteresis.watch.bzRate) {
    quietSampleCount = 0;
    return { level: 'WATCH', message: `Bz turning southward at ${bzRate.toFixed(1)} nT/min — substorm may develop within 10 minutes`, confidence: 'MEDIUM' };
  }

  // Controlled de-escalation if candidate is lower than active level.
  if (candidate && candidateRank > 0 && candidateRank < currentRank) {
    quietSampleCount = 0;
    return candidate;
  }

  // Clear only after consecutive quiet samples.
  quietSampleCount += 1;
  if (quietSampleCount >= cfg.quietClearRequired) {
    return null;
  }

  return { level: activeLevel, message: 'Monitoring ongoing geomagnetic disturbance', confidence: activeLevel === 'WATCH' ? 'MEDIUM' : 'HIGH' };
}

function shouldBroadcast(nextLevel, cfg) {
  const now = Date.now();
  if (!nextLevel) return false;
  if (!lastBroadcastLevel) return true;
  if (nextLevel !== lastBroadcastLevel) return true;
  return now - lastBroadcastTs >= cfg.sameLevelRebroadcastMs;
}

function isFreshAlert(alert, cfg) {
  if (!alert?.ts) return false;
  const ts = Date.parse(alert.ts);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= cfg.maxActiveAlertAgeMs;
}

function buildEventId(level) {
  return `substorm_${level.toLowerCase()}_${Date.now()}`;
}

function startSubstormMonitor(broadcast) {
  broadcastFn = broadcast;
  console.log('[substormDetector] monitor started');

  setInterval(() => {
    const cfg = profileConfig();
    if (latestSubstormAlert && !isFreshAlert(latestSubstormAlert, cfg)) {
      latestSubstormAlert = null;
      activeLevel = null;
      activeEventId = null;
    }

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
    const candidate = candidateLevel(bz, bzRate, speed, cfg);
    const next = applyStateMachine(candidate, bz, bzRate, speed, cfg);

    if (!next) {
      activeLevel = null;
      activeEventId = null;
      latestSubstormAlert = null;
    } else {
      const previousLevel = activeLevel;
      activeLevel = next.level;
      if (!activeEventId || previousLevel !== activeLevel) {
        activeEventId = buildEventId(activeLevel);
      }
      latestSubstormAlert = {
        ...next,
        eventId: activeEventId,
        bz,
        bzRate,
        speed,
        ts: new Date().toISOString(),
      };

      if (shouldBroadcast(activeLevel, cfg)) {
        console.log(`[substormDetector] ALERT: ${latestSubstormAlert.level} — ${latestSubstormAlert.message}`);
        broadcastFn('substorm_alert', latestSubstormAlert);
        lastBroadcastLevel = activeLevel;
        lastBroadcastTs = Date.now();
      }
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
function getLatestSubstormAlert() {
  const cfg = profileConfig();
  if (!isFreshAlert(latestSubstormAlert, cfg)) {
    latestSubstormAlert = null;
    return null;
  }
  return latestSubstormAlert;
}

function getSubstormProfile() {
  return currentProfile;
}

function setSubstormProfile(profile) {
  const normalized = String(profile || '').toLowerCase();
  // Support both new (test/real) and legacy (lenient/strict) names
  let mapped = normalized;
  if (normalized === 'strict') mapped = 'real';
  if (normalized === 'lenient') mapped = 'test';
  
  if (!Object.prototype.hasOwnProperty.call(PROFILES, mapped)) {
    return { ok: false, error: 'profile must be test, real, lenient, or strict' };
  }
  if (mapped === currentProfile) {
    return { ok: true, profile: currentProfile, changed: false };
  }

  currentProfile = mapped;
  resetState();
  return { ok: true, profile: currentProfile, changed: true };
}

module.exports = { startSubstormMonitor, getBzHistory, getLatestSubstormAlert, getSubstormProfile, setSubstormProfile };
