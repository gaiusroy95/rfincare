import axios from 'axios';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = resolve(__dirname, '../../.cache/market-overview.json');
const MEMORY_TTL_MS = Number(process.env.MARKET_OVERVIEW_CACHE_MS || 60_000);
const TROY_OZ_GRAMS = 31.1034768;

const http = axios.create({
  timeout: 20_000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json,text/plain,*/*',
  },
});

let memoryCache = null;
let memoryCacheAt = 0;
let inFlight = null;

function ensureCacheDir() {
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
}

function readDiskCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeDiskCache(payload) {
  try {
    ensureCacheDir();
    writeFileSync(CACHE_FILE, JSON.stringify(payload), 'utf8');
  } catch {
    /* ignore disk cache errors */
  }
}

function formatNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

function formatChangePct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return { change: '—', up: true, changePct: 0 };
  const rounded = Math.round(n * 100) / 100;
  const sign = rounded > 0 ? '+' : '';
  return {
    change: `${sign}${rounded.toFixed(2)}%`,
    up: rounded >= 0,
    changePct: rounded,
  };
}

function sparkFromCloses(closes, limit = 7) {
  const vals = (closes || []).filter((v) => Number.isFinite(Number(v))).map(Number);
  if (vals.length === 0) return [1, 1, 1, 1, 1, 1, 1];
  if (vals.length === 1) return [vals[0] * 0.998, vals[0]];
  return vals.slice(-limit);
}

async function fetchMoneycontrolIndex(symbol) {
  const encoded = encodeURIComponent(symbol);
  const { data } = await http.get(
    `https://priceapi.moneycontrol.com/pricefeed/notapplicable/inidicesindia/${encoded}`
  );
  const row = data?.data;
  if (!row?.pricecurrent) throw new Error(`Missing quote for ${symbol}`);
  const price = Number(String(row.pricecurrent).replace(/,/g, ''));
  const changePct = Number(row.pricepercentchange);
  return { price, changePct, name: row.HN || row.company || symbol };
}

async function fetchMoneycontrolHistory(symbol, days = 8) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86_400;
  const { data } = await http.get('https://priceapi.moneycontrol.com/techCharts/history', {
    params: { symbol, resolution: '1D', from, to },
  });
  if (data?.s !== 'ok' || !Array.isArray(data?.c)) return [];
  return data.c.map(Number).filter(Number.isFinite);
}

async function fetchUsdInrLive() {
  // Prefer lightweight CDN mirror; fall back to open.er-api
  try {
    const { data } = await http.get(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json'
    );
    const rate = Number(data?.usd?.inr);
    if (Number.isFinite(rate)) return { rate, updatedAt: data?.date || null };
  } catch {
    /* fall through */
  }
  const { data } = await http.get('https://open.er-api.com/v6/latest/USD');
  const rate = Number(data?.rates?.INR);
  if (!Number.isFinite(rate)) throw new Error('USD/INR unavailable');
  return { rate, updatedAt: data?.time_last_update_utc || null };
}

async function fetchGoldUsdPerOz() {
  const { data } = await http.get('https://api.gold-api.com/price/XAU');
  const price = Number(data?.price);
  if (!Number.isFinite(price)) throw new Error('Gold price unavailable');
  return { priceUsdOz: price, updatedAt: data?.updatedAt || null };
}

function goldInrPerGram(usdPerOz, usdInr) {
  return (usdPerOz / TROY_OZ_GRAMS) * usdInr;
}

function upsertSeriesHistory(history, value, keyDate = new Date().toISOString().slice(0, 10)) {
  const next = Array.isArray(history) ? [...history] : [];
  const last = next[next.length - 1];
  if (last?.date === keyDate) {
    next[next.length - 1] = { date: keyDate, value };
  } else {
    next.push({ date: keyDate, value });
  }
  return next.slice(-14);
}

function buildIndexRow({ id, name, price, changePct, spark, valueDigits = 2 }) {
  const meta = formatChangePct(changePct);
  return {
    id,
    name,
    value: formatNumber(price, valueDigits),
    rawValue: price,
    change: meta.change,
    changePct: meta.changePct,
    up: meta.up,
    spark: sparkFromCloses(spark),
  };
}

async function safe(label, fn, errors) {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${err?.message || err}`);
    return null;
  }
}

function mergeSpark(cachedSpark, price) {
  const base = Array.isArray(cachedSpark) ? cachedSpark.filter((v) => Number.isFinite(Number(v))) : [];
  if (!base.length) return [price];
  return sparkFromCloses([...base.slice(0, -1), Number(price)]);
}

async function fetchLiveOverview() {
  const disk = readDiskCache() || {};
  const errors = [];
  const indices = [];
  const prevById = Object.fromEntries(
    (disk?.lastPayload?.indices || []).map((row) => [row.id, row])
  );

  // Sequential quotes — parallel HTTPS to these hosts often times out on restricted networks.
  const nifty = await safe('nifty', () => fetchMoneycontrolIndex('in;NSX'), errors);
  const sensex = await safe('sensex', () => fetchMoneycontrolIndex('in;SEN'), errors);
  const usd = await safe('usd/inr', () => fetchUsdInrLive(), errors);
  const gold = await safe('gold', () => fetchGoldUsdPerOz(), errors);

  // Reuse cached sparklines; only fetch history when we have no usable spark yet.
  let niftyHist = Array.isArray(prevById.nifty50?.spark) ? prevById.nifty50.spark : [];
  let sensexHist = Array.isArray(prevById.sensex?.spark) ? prevById.sensex.spark : [];
  if (nifty && niftyHist.length < 3) {
    niftyHist = (await safe('nifty history', () => fetchMoneycontrolHistory('in;NSX'), errors)) || [];
  }
  if (sensex && sensexHist.length < 3) {
    sensexHist =
      (await safe('sensex history', () => fetchMoneycontrolHistory('in;SEN'), errors)) || [];
  }

  if (nifty) {
    indices.push(
      buildIndexRow({
        id: 'nifty50',
        name: 'NIFTY 50',
        price: nifty.price,
        changePct: nifty.changePct,
        spark: mergeSpark(niftyHist, nifty.price),
      })
    );
  }

  if (sensex) {
    indices.push(
      buildIndexRow({
        id: 'sensex',
        name: 'SENSEX',
        price: sensex.price,
        changePct: sensex.changePct,
        spark: mergeSpark(sensexHist, sensex.price),
      })
    );
  }

  const usdInr = usd?.rate ?? (Number.isFinite(Number(disk?.usdInr)) ? Number(disk.usdInr) : null);

  if (gold && Number.isFinite(usdInr)) {
    const goldPerGram = goldInrPerGram(gold.priceUsdOz, usdInr);
    const goldHistory = upsertSeriesHistory(disk.goldHistory, goldPerGram);
    const prev =
      goldHistory.length >= 2 ? goldHistory[goldHistory.length - 2].value : disk?.goldPrevClose;
    const changePct =
      Number.isFinite(Number(prev)) && Number(prev) > 0
        ? ((goldPerGram - Number(prev)) / Number(prev)) * 100
        : 0;
    const goldRow = buildIndexRow({
      id: 'gold24k',
      name: 'GOLD (24K)',
      price: goldPerGram,
      changePct,
      spark: goldHistory.map((h) => h.value),
      valueDigits: 0,
    });
    goldRow.value = `₹${formatNumber(goldPerGram, 0)}/g`;
    indices.push(goldRow);
    disk.goldHistory = goldHistory;
    disk.goldPrevClose = goldHistory.length >= 2 ? goldHistory[goldHistory.length - 2].value : prev;
    disk.goldUsdOz = gold.priceUsdOz;
  }

  if (Number.isFinite(usdInr)) {
    const usdHistory = upsertSeriesHistory(disk.usdHistory, usdInr);
    const prev =
      usdHistory.length >= 2 ? usdHistory[usdHistory.length - 2].value : disk?.usdInrPrev;
    const changePct =
      Number.isFinite(Number(prev)) && Number(prev) > 0
        ? ((usdInr - Number(prev)) / Number(prev)) * 100
        : 0;
    indices.push(
      buildIndexRow({
        id: 'usdinr',
        name: 'USD/INR',
        price: usdInr,
        changePct,
        spark: usdHistory.map((h) => h.value),
        valueDigits: 2,
      })
    );
    disk.usdInr = usdInr;
    disk.usdInrPrev = prev ?? usdInr;
    disk.usdHistory = usdHistory;
  }

  if (indices.length === 0) {
    throw new Error(`Market overview unavailable (${errors.join('; ') || 'no sources'})`);
  }

  const order = ['nifty50', 'sensex', 'gold24k', 'usdinr'];
  indices.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  const payload = {
    live: true,
    updatedAt: new Date().toISOString(),
    source: 'moneycontrol+gold-api+currency-api',
    indices,
    warnings: errors.length ? errors : undefined,
  };

  writeDiskCache({
    ...disk,
    lastPayload: payload,
    savedAt: payload.updatedAt,
  });

  return payload;
}

/**
 * Public market overview for dashboard widgets.
 * Cached in memory (~60s) and on disk as a stale fallback.
 * When cache is stale, returns disk data immediately and refreshes in the background.
 */
export async function getMarketOverview({ force = false } = {}) {
  const now = Date.now();
  if (!force && memoryCache && now - memoryCacheAt < MEMORY_TTL_MS) {
    return { ...memoryCache, cached: true };
  }

  const disk = readDiskCache();
  const hasDisk = Boolean(disk?.lastPayload?.indices?.length);

  if (!force && inFlight) {
    if (hasDisk) {
      return {
        ...disk.lastPayload,
        live: Boolean(disk.lastPayload.live),
        stale: true,
        cached: true,
        updatedAt: disk.savedAt || disk.lastPayload.updatedAt,
        refreshing: true,
      };
    }
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const live = await fetchLiveOverview();
      memoryCache = live;
      memoryCacheAt = Date.now();
      return { ...live, cached: false };
    } catch (err) {
      const fallback = readDiskCache();
      if (fallback?.lastPayload?.indices?.length) {
        return {
          ...fallback.lastPayload,
          live: false,
          stale: true,
          cached: true,
          updatedAt: fallback.savedAt || fallback.lastPayload.updatedAt,
          warning: err.message,
        };
      }
      throw err;
    } finally {
      inFlight = null;
    }
  })();

  // Serve last known quotes immediately while a refresh runs.
  if (!force && hasDisk) {
    return {
      ...disk.lastPayload,
      live: Boolean(disk.lastPayload.live),
      stale: true,
      cached: true,
      updatedAt: disk.savedAt || disk.lastPayload.updatedAt,
      refreshing: true,
    };
  }

  return inFlight;
}
