const axios = require('axios');
const pool = require('../../config/db');

const CACHE_MINUTES = 15;

const WMO_DESCRIPTIONS = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  56: 'Freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
  85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'
};

function describeCode(code) {
  return WMO_DESCRIPTIONS[code] || `Weather code ${code}`;
}

// Derives local weather warnings from current + daily forecast data
function deriveWarnings(current, daily) {
  const warnings = [];
  const gust = current.wind_gusts_10m || 0;
  const wind = current.wind_speed_10m || 0;
  const code = current.weather_code;

  if (code >= 95) warnings.push({ level: 'critical', text: 'Thunderstorm activity detected in the area. Seek shelter indoors.' });
  if (gust >= 118) warnings.push({ level: 'critical', text: `Extreme wind gusts (${Math.round(gust)} kph). Stay indoors and follow evacuation orders.` });
  else if (gust >= 89) warnings.push({ level: 'warning', text: `Very strong wind gusts (${Math.round(gust)} kph). Secure loose objects and avoid travel.` });
  else if (gust >= 62 || wind >= 62) warnings.push({ level: 'warning', text: `Strong winds (gusts up to ${Math.round(gust)} kph). Caution advised.` });

  const maxPrecip = daily && daily.precipitation_sum ? Math.max(...daily.precipitation_sum) : 0;
  if (maxPrecip >= 50) warnings.push({ level: 'critical', text: `Heavy rainfall expected (up to ${Math.round(maxPrecip)} mm). High flood risk in low-lying areas.` });
  else if (maxPrecip >= 15) warnings.push({ level: 'warning', text: `Moderate to heavy rainfall expected (up to ${Math.round(maxPrecip)} mm). Monitor flood advisories.` });

  if (warnings.length === 0) warnings.push({ level: 'info', text: 'No severe weather warnings at this time. Stay updated for changes.' });
  return warnings;
}

async function fetchFromProvider(lat, lng) {
  const url = 'https://api.open-meteo.com/v1/forecast';
  const res = await axios.get(url, {
    params: {
      latitude: lat,
      longitude: lng,
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
      timezone: 'auto',
      forecast_days: 3
    },
    timeout: 10000
  });
  return res.data;
}

// Returns current weather + warnings + 3-day forecast.
// Caches in MySQL (works offline-ish) and refreshes every CACHE_MINUTES.
async function getWeather(forceRefresh = false) {
  if (!forceRefresh) {
    const [rows] = await pool.query(
      `SELECT data FROM weather_cache
       WHERE fetched_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
       ORDER BY id DESC LIMIT 1`, [CACHE_MINUTES]);
    if (rows.length) {
      try { return JSON.parse(rows[0].data); } catch { /* fall through to refresh */ }
    }
  }

  const lat = Number(process.env.WEATHER_LAT || 17.5079);
  const lng = Number(process.env.WEATHER_LNG || 120.7598);
  const raw = await fetchFromProvider(lat, lng);
  const c = raw.current || {};
  const d = raw.daily || {};

  const result = {
    location: process.env.WEATHER_LOCATION || 'Municipality',
    fetched_at: new Date().toISOString(),
    current: {
      condition: describeCode(c.weather_code),
      weather_code: c.weather_code,
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kph: c.wind_speed_10m,
      gusts_kph: c.wind_gusts_10m,
      precipitation_mm: c.precipitation
    },
    warnings: deriveWarnings(c, d),
    forecast: (d.time || []).map((t, i) => ({
      date: t,
      condition: describeCode((d.weather_code || [])[i]),
      temp_max: (d.temperature_2m_max || [])[i],
      temp_min: (d.temperature_2m_min || [])[i],
      precipitation_mm: (d.precipitation_sum || [])[i]
    }))
  };

  try {
    await pool.query('INSERT INTO weather_cache (data) VALUES (?)', [JSON.stringify(result)]);
    await pool.query('DELETE FROM weather_cache WHERE id NOT IN (SELECT * FROM (SELECT id FROM weather_cache ORDER BY id DESC LIMIT 20) x)');
  } catch (err) {
    console.error('[weather] cache write failed:', err.message);
  }
  return result;
}

// Fallback when the provider is unreachable: serve the newest cached snapshot
async function getWeatherSafe(forceRefresh = false) {
  try {
    return { ...(await getWeather(forceRefresh)), offline: false };
  } catch (err) {
    const [rows] = await pool.query('SELECT data, fetched_at FROM weather_cache ORDER BY id DESC LIMIT 1');
    if (rows.length) {
      return { ...JSON.parse(rows[0].data), offline: true, cache_age: rows[0].fetched_at };
    }
    return {
      location: process.env.WEATHER_LOCATION || 'Municipality',
      offline: true,
      error: 'Weather service unavailable and no cached data.',
      warnings: [{ level: 'info', text: 'Weather data temporarily unavailable. Monitor PAGASA for official forecasts.' }]
    };
  }
}

module.exports = { getWeather: getWeatherSafe, deriveWarnings, describeCode };
