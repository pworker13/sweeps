import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { firefox } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BARCHART_URL = 'https://www.barchart.com/options/unusual-activity/stocks';

const WEBHOOK_LARGE  = process.env.WEBHOOK_LARGE  || '';
const WEBHOOK_GOLDEN = process.env.WEBHOOK_GOLDEN || '';

const DEBUG = Boolean(process.env.DEBUG && process.env.DEBUG !== '0' && process.env.DEBUG.toLowerCase() !== 'false');
const MIN_PREMIUM_LARGE   = Number(process.env.MIN_PREMIUM_LARGE ?? 200_000);
const MIN_PREMIUM_GOLDEN  = Number(process.env.MIN_PREMIUM_GOLDEN ?? 1_000_000);
const MAX_DTE_GOLDEN      = Number(process.env.MAX_DTE_GOLDEN ?? 14);
const MIN_VOL_OI          = Number(process.env.MIN_VOL_OI ?? 1.5);
const AGGRESSIVE_LAST_ASK = Number(process.env.AGGRESSIVE_LAST_TO_ASK ?? 0.95);

const STATE_FILE = path.join(__dirname, 'posted-state.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString().replace('T',' ').replace('Z','');
const log = (...a) => {
  if (!DEBUG) return;
  console.log(`[${now()}]`, ...a);
}

const num = (s) => {
  if (typeof s !== 'string') return Number.isFinite(s) ? s : NaN;
  const m = s.replace(/[^0-9.\-]/g, '');
  return m ? Number(m) : NaN;
};
const fmtUS = (d) => {
  const dt = new Date(d);
  const mm = String(dt.getMonth()+1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const yy = dt.getFullYear();
  return `${mm}/${dd}/${yy}`;
};
const daysToExpiry = (iso) => {
  try {
    const d = new Date(iso);
    const t0 = new Date(); t0.setHours(0,0,0,0);
    return Math.ceil((d - t0) / 86400000);
  } catch { return 9999; }
};

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
  catch { return { posted: {} }; }
}
async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function rowKey(r) {
  return `${r.Symbol}|${r.Type}|${r.Strike}|${r.ExpirationISO}|${r.Time}|${r.Last}|${r.Volume}`;
}
function isNearAsk(r) {
  return Number.isFinite(r.Ask) && Number.isFinite(r.Last) && r.Last >= AGGRESSIVE_LAST_ASK * r.Ask;
}
function isLargeSweepLike(r) {
  return r.Premium >= MIN_PREMIUM_LARGE && r.VolOI >= MIN_VOL_OI && isNearAsk(r);
}
function isGoldenSweepLike(r) {
  const dte = daysToExpiry(r.ExpirationISO);
  return r.Premium >= MIN_PREMIUM_GOLDEN && r.VolOI >= MIN_VOL_OI && isNearAsk(r) && dte <= MAX_DTE_GOLDEN && r.Moneyness === 'OTM';
}

function makeEmbed(r, tag) {
  const color = r.Type === 'Call' ? 0x2ecc71 : 0xe74c3c;
  return [{
    title: `${tag}: ${r.Symbol} ${r.Type} ${r.Strike} ${fmtUS(r.ExpirationISO)}`,
    color,
    fields: [
      { name: 'Premium ~$', value: r.Premium.toLocaleString(), inline: true },
      { name: 'Vol / OI', value: String(r.VolOI), inline: true },
      { name: 'Last / Bid-Ask', value: `${r.Last} / ${r.Bid}-${r.Ask}`, inline: true },
      { name: 'Moneyness', value: r.Moneyness, inline: true },
      { name: 'Trade Time', value: r.Time || '—', inline: true },
      { name: 'Link', value: `https://www.barchart.com/stocks/quotes/${r.Symbol}/options`, inline: false }
    ],
    footer: { text: 'Source: Barchart Unusual Options (free)' }
  }];
}
async function postDiscord(webhook, embeds) {
  if (!webhook) return;
  log('POST → Discord webhook', webhook.slice(0, 60) + '…');
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '', embeds })
  });
  log('Discord response', res.status, res.statusText);
}

// ------------ FIXED: robust XHR capture with fallback -------------
async function fetchGridJson(page) {
  log('Navigating to', BARCHART_URL);
  await page.goto(BARCHART_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('DOM content loaded');

  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(90000);

  let capturedJson = null;
  const isCoreApi = (u) =>
    u.includes('/proxies/core-api') &&
    (u.includes('/v1/options/get') || u.includes('/v1/lists-snapshot/get'));

  page.on('response', async (resp) => {
    const u = resp.url();
    if (!isCoreApi(u)) return;
    try {
      const j = await resp.json();
      capturedJson = j;
      log('[core-api] captured EARLY via listener:', resp.status(), u);
      if (Array.isArray(j?.data)) log('[core-api] items:', j.data.length);
    } catch (e) {
      log('[core-api] listener JSON parse failed:', e.message);
    }
  });

  page.on('console', (msg) => log('[PAGE console]', msg.type(), msg.text()));
  page.on('requestfailed', (req) => log('[REQUEST FAILED]', req.method(), req.url(), req.failure()?.errorText));

  for (const sel of [
    '#onetrust-accept-btn-handler',
    'text=Accept All',
    'text=I Agree',
    'button[aria-label="Close"]',
    'button:has-text("×")'
  ]) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1200 })) {
        log('Clicking overlay:', sel);
        await loc.click();
      }
    } catch {}
  }

  const grid = page.locator('.bc-datatable');
  log('bc-datatable count =', await grid.count());
  if (await grid.first().isVisible().catch(() => false)) {
    await grid.first().scrollIntoViewIfNeeded().catch(()=>{});
    log('Scrolled grid into view');
  }

  if (!capturedJson) {
    log('Waiting up to 15s for core-api XHR…');
    try {
      const resp = await page.waitForResponse((r) => isCoreApi(r.url()), { timeout: 15000 });
      capturedJson = await resp.json();
      log('[core-api] captured via waitForResponse:', resp.status(), resp.url());
    } catch (e) {
      log('No core-api XHR during wait window:', e.message);
    }
  }

  if (!capturedJson) {
    log('FALLBACK: fetching core-api from page using data-api-config…');
    capturedJson = await page.evaluate(async () => {
      const el = document.querySelector('.bc-datatable');
      if (!el) return null;
      const cfgRaw = el.getAttribute('data-api-config');
      if (!cfgRaw) return null;
      const cfg = JSON.parse(cfgRaw);
      const api = cfg.api || {};
      const method = (api.method || 'options').toLowerCase();
      const endpoint = method === 'lists-snapshot' ? 'lists-snapshot/get' : 'options/get';
      const qs = new URLSearchParams();
      Object.keys(api).forEach((k) => { if (k !== 'method') qs.append(k, api[k]); });
      qs.append('page', '1'); qs.append('limit', '100'); qs.append('raw', '1');
      const url = `${location.origin}/proxies/core-api/v1/${endpoint}?${qs}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`fallback fetch ${res.status}`);
      return await res.json();
    }).catch((e) => {
      console.warn('fallback evaluate error:', e?.message);
      return null;
    });

    if (capturedJson) {
      log('[core-api] captured via FALLBACK; items:', Array.isArray(capturedJson?.data) ? capturedJson.data.length : 'n/a');
    } else {
      log('FALLBACK failed to retrieve JSON.');
    }
  }

  return capturedJson;
}
// ---------------------------------------------------------------

function normalizeRows(json) {
  const src = Array.isArray(json?.data) ? json.data : [];
  log('Normalizing rows: count =', src.length);
  const rows = src.map(o => {
    const sym = o.baseSymbol || o.symbol || '';
    const strike = num(String(o.strikePrice ?? ''));
    const last = num(String(o.lastPrice ?? ''));
    const bid = num(String(o.bidPrice ?? ''));
    const ask = num(String(o.askPrice ?? ''));
    const vol = num(String(o.volume ?? ''));
    const oi  = Math.max(1, num(String(o.openInterest ?? '')));
    const voloi = Number.isFinite(o.volumeOpenInterestRatio)
      ? Number(o.volumeOpenInterestRatio.toFixed(2))
      : Math.round((vol/oi)*100)/100;

    const t = (o.symbol || '').includes('P') && !(o.symbol || '').includes('C') ? 'Put'
            : (o.symbol || '').includes('C') ? 'Call'
            : (o.delta ?? 0) < 0 ? 'Put' : 'Call';

    const premium = Math.round((Number.isFinite(last)? last : 0) * 100 * (Number.isFinite(vol)? vol : 0));

    return {
      Symbol: sym,
      Type: t,
      Strike: String(strike),
      ExpirationISO: o.expirationDate,
      Bid: bid, Ask: ask, Last: last,
      Volume: Number.isFinite(vol) ? Math.trunc(vol) : 0,
      OI: Number.isFinite(oi) ? Math.trunc(oi) : 1,
      VolOI: Number.isFinite(voloi) ? voloi : 0,
      Premium: Number.isFinite(premium) ? premium : 0,
      Moneyness: o.moneyness || 'N/A',
      Time: o.tradeTime || ''
    };
  });
  log('Normalized rows ready:', rows.length);
  if (rows[0]) log('Sample row 0:', rows[0]);
  return rows;
}

async function main() {
  if (!WEBHOOK_LARGE && !WEBHOOK_GOLDEN) {
    log('ERROR: Configure WEBHOOK_LARGE / WEBHOOK_GOLDEN in .env');
    process.exit(1);
  }

  const state = await loadState();
  log('Loaded state entries:', Object.keys(state.posted).length);

  log('Launching Firefox (headed)…');
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0'
  });
  const page = await context.newPage();

  let json = null;
  try {
    json = await fetchGridJson(page);
  } catch (e) {
    log('fetchGridJson ERROR:', e.message);
  }

  // give you time to inspect the page
  try { await page.waitForTimeout(10_000); } catch {}
  await browser.close();
  log('Browser closed');

  if (!json?.data?.length) {
    log('No data returned (XHR not captured or payload empty).');
    return;
  }

  const rows = normalizeRows(json);
  const large  = rows.filter(isLargeSweepLike);
  const golden = rows.filter(isGoldenSweepLike);
  log(`Filter results → total:${rows.length} large:${large.length} golden:${golden.length}`);

  let posted = 0;
  for (const r of large.slice(0, 15)) {
    const key = rowKey(r);
    if (state.posted[key]) { log('Skip duplicate (large):', key); continue; }
    await postDiscord(WEBHOOK_LARGE, makeEmbed(r, 'Large Sweep-like'));
    state.posted[key] = Date.now(); posted++; await sleep(400);
  }
  for (const r of golden.slice(0, 15)) {
    const key = rowKey(r);
    if (state.posted[key]) { log('Skip duplicate (golden):', key); continue; }
    await postDiscord(WEBHOOK_GOLDEN, makeEmbed(r, 'GOLDEN Sweep-like'));
    state.posted[key] = Date.now(); posted++; await sleep(400);
  }

  const cutoff = Date.now() - 2 * 86400000;
  for (const [k, ts] of Object.entries(state.posted)) if (ts < cutoff) delete state.posted[k];
  await saveState(state);

  log(`DONE. Parsed:${rows.length} Posted:${posted}`);
}

main().catch(e => { log('FATAL', e); process.exit(1); });
