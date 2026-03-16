/**
 * bortleDetector.js
 *
 * Bortle detection with provider fallback chain:
 *   1) Nominatim reverse geocoding (primary)
 *   2) Open-Meteo reverse geocoding (secondary)
 *   3) Default Bortle 5 (last resort)
 *
 * Cache: 24 hr per 0.1° cell.
 */

const axios = require('axios');

const PLACE_BORTLE = {
  city: 8, city_block: 8, commercial: 8, industrial: 8,
  town: 6, suburb: 7, neighbourhood: 7, residential: 6, retail: 7,
  village: 4, allotments: 5, quarter: 6,
  hamlet: 3, isolated_dwelling: 2, farm: 2,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function resolveUserAgent() {
  const contact = (process.env.BORTLE_CONTACT || process.env.CONTACT_EMAIL || '').trim();
  return contact
    ? `orion-aurora-platform/1.0 (${contact})`
    : 'orion-aurora-platform/1.0 (backend service)';
}

function mapAddressToBortle(type, address = {}) {
  let bortle;
  if      (address.city || address.city_district) bortle = 8;
  else if (address.town)                           bortle = 6;
  else if (address.suburb)                         bortle = 7;
  else if (address.village)                        bortle = 4;
  else if (address.hamlet || address.isolated_dwelling) bortle = 3;
  else bortle = PLACE_BORTLE[type] || 5;
  return bortle;
}

function applyLatitudeAdjustment(lat, bortle) {
  if (Math.abs(lat) > 65 && bortle > 3) return Math.max(3, bortle - 1);
  return bortle;
}

async function bortleFromNominatim(lat, lon, attempt = 1) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&zoom=10&format=json&addressdetails=1`;
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': resolveUserAgent(),
        Accept: 'application/json',
      },
    });
    const { type, address = {} } = res.data;

    const bortle = applyLatitudeAdjustment(lat, mapAddressToBortle(type, address));

    console.log(`[bortleDetector] Nominatim (attempt ${attempt}) lat=${lat.toFixed(2)} lon=${lon.toFixed(2)} type=${type} → Bortle ${bortle}`);
    return { bortle, source: 'nominatim', placeType: type };
  } catch (e) {
    // Identify retriable network errors
    const code = e?.code;
    const status = e?.response?.status;
    const isNetworkError = code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED' || code === 'EAI_AGAIN';
    const isServerError = status >= 500 && status <= 599;
    const isRetriable = isNetworkError || isServerError || (status === 429);

    if (attempt < 3 && isRetriable) {
      const delayMs = 1000 * Math.pow(2, attempt - 1);
      console.warn(`[bortleDetector] Nominatim attempt ${attempt} failed (${code || status || e.message}), retrying in ${delayMs}ms…`);
      await sleep(delayMs);
      return bortleFromNominatim(lat, lon, attempt + 1);
    }
    throw e;
  }
}

async function bortleFromOpenMeteo(lat, lon) {
  const url = `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}&longitude=${lon}&language=en&format=json&count=1`;
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { Accept: 'application/json' },
  });

  const place = res.data?.results?.[0];
  if (!place) throw new Error('open_meteo_empty_result');

  const population = Number(place.population || 0);
  const type = String(place.feature_code || place.name || 'unknown').toLowerCase();
  let bortle = 5;

  if (population >= 1000000) bortle = 8;
  else if (population >= 200000) bortle = 7;
  else if (population >= 30000) bortle = 6;
  else if (population >= 5000) bortle = 5;
  else if (population >= 1000) bortle = 4;
  else bortle = 3;

  bortle = applyLatitudeAdjustment(lat, bortle);

  console.log(`[bortleDetector] Open-Meteo lat=${lat.toFixed(2)} lon=${lon.toFixed(2)} pop=${population} → Bortle ${bortle}`);
  return { bortle, source: 'open-meteo', placeType: type, population };
}

// ── Cache ─────────────────────────────────────────────────────────────────────
const bortleCache = new Map();
const CACHE_TTL   = 24 * 60 * 60 * 1000;

function cacheKey(lat, lon) {
  return `${Math.round(lat * 10) / 10},${Math.round(lon * 10) / 10}`;
}

async function getBortleForLocation(lat, lon) {
  const key = cacheKey(lat, lon);
  const hit = bortleCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return { ...hit.data, cached: true };

  try {
    const result = await bortleFromNominatim(lat, lon);
    bortleCache.set(key, { data: result, ts: Date.now() });
    return result;
  } catch (nominatimErr) {
    console.warn(`[bortleDetector] Nominatim unavailable for lat=${lat.toFixed(2)} lon=${lon.toFixed(2)} (${nominatimErr.code || nominatimErr.response?.status || nominatimErr.message})`);
  }

  try {
    const secondary = await bortleFromOpenMeteo(lat, lon);
    bortleCache.set(key, { data: secondary, ts: Date.now() });
    return secondary;
  } catch (secondaryErr) {
    // Network/provider failure: always fallback gracefully to fixed Bortle 5.
    const fallback = {
      bortle: 5,
      source: 'fallback',
      reason: `providers_failed: ${secondaryErr.code || secondaryErr.message}`,
      placeType: 'unknown',
    };
    console.warn(`[bortleDetector] Using fallback Bortle 5 for lat=${lat.toFixed(2)} lon=${lon.toFixed(2)} (${secondaryErr.code || secondaryErr.message})`);
    bortleCache.set(key, { data: fallback, ts: Date.now() - (CACHE_TTL - 30 * 60 * 1000) });
    return fallback;
  }
}

module.exports = { getBortleForLocation };