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
const CLUSTER_MIN_PREMIUM = Number(process.env.CLUSTER_MIN_PREMIUM ?? 3_000_000);
const STRIKE_PCT_BAND     = Number(process.env.STRIKE_PCT_BAND ?? 5);
const DATE_BAND_DAYS      = Number(process.env.DATE_BAND_DAYS ?? 7);

// סף הקפיצה הנדרש לפרסום מחדש של cluster
const CLUSTER_PREMIUM_JUMP = Number(process.env.CLUSTER_PREMIUM_JUMP ?? 200_000);

const HISTORY_MINUTES = Number(process.env.HISTORY_MINUTES ?? 10);
const WINDOW_MS = HISTORY_MINUTES * 60_000;

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
  try {
    const j = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return { 
      posted: j.posted || {}, 
      recent: Array.isArray(j.recent) ? j.recent : [],
      clusterData: j.clusterData || {} // שומר premium + timestamp + hash של העסקאות
    };
  } catch {
    return { posted: {}, recent: [], clusterData: {} };
  }
}
async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify({
    posted: state.posted,
    recent: state.recent,
    clusterData: state.clusterData
  }, null, 2));
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
    title: `${tag}: ${r.Symbol} ${r.Type} ${r.Strike}$ ${fmtUS(r.ExpirationISO)}`,
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

function findPremiumClusters(groups, strikePct, dayBand, minPremium, state) {
  const arr = Array.from(groups.values());
  const n = arr.length;
  const parents = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parents[i] === i ? i : (parents[i] = find(parents[i])));
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parents[b] = a; };

  const strikes = arr.map(g => num(g.Strike));
  const dtes = arr.map(g => daysToExpiry(g.ExpirationISO));
  const pctBand = strikePct / 100;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const gi = arr[i], gj = arr[j];
      if (gi.Symbol !== gj.Symbol || gi.Type !== gj.Type) continue;
      const strikeDiffPct = Math.abs(strikes[i] - strikes[j]) / Math.min(strikes[i], strikes[j]);
      if (strikeDiffPct > pctBand) continue;
      if (Math.abs(dtes[i] - dtes[j]) > dayBand) continue;
      union(i, j);
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const g = arr[i];
    let c = byRoot.get(root);
    const strike = strikes[i];
    const exp = g.ExpirationISO;
    if (!c) {
      c = {
        symbol: g.Symbol,
        type: g.Type,
        strikeLo: strike,
        strikeHi: strike,
        expLo: exp,
        expHi: exp,
        premiumSum: 0,
        keys: [],
        rowKeys: [] // שמירת rowKeys לבדיקה אם יש עסקאות חדשות
      };
      byRoot.set(root, c);
    }
    c.strikeLo = Math.min(c.strikeLo, strike);
    c.strikeHi = Math.max(c.strikeHi, strike);
    const t = Date.parse(exp);
    if (Date.parse(c.expLo) > t) c.expLo = exp;
    if (Date.parse(c.expHi) < t) c.expHi = exp;
    c.premiumSum += g.premiumSum || 0;
    c.keys.push(g.key);
    // אוסף את כל ה-rowKeys של העסקאות בקלאסטר
    c.rowKeys.push(...g.rows.map(r => r.rowKey));
  }

  return Array.from(byRoot.values()).filter(c => c.premiumSum >= minPremium && c.keys.length > 1);
}

async function main() {
  if (!WEBHOOK_LARGE && !WEBHOOK_GOLDEN) {
    log('ERROR: Configure WEBHOOK_LARGE / WEBHOOK_GOLDEN in .env');
    process.exit(1);
  }

  const state = await loadState();
  log('Loaded state entries:', Object.keys(state.posted).length);
  log('Loaded cluster data:', Object.keys(state.clusterData).length);

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

  try { await page.waitForTimeout(10_000); } catch {}
  await browser.close();
  log('Browser closed');

  if (!json?.data?.length) {
    log('No data returned (XHR not captured or payload empty).');
    return;
  }

  const rows = normalizeRows(json);
  const nowTs = Date.now();
  state.recent = Array.isArray(state.recent) ? state.recent.filter(r => r.ts > nowTs - WINDOW_MS) : [];
  for (const r of rows) state.recent.push({ ...r, rowKey: rowKey(r), ts: nowTs });

  const large  = rows.filter(isLargeSweepLike);
  log(`Filter results → total:${rows.length} large:${large.length}`);

  let posted = 0;
  for (const r of large.slice(0, 15)) {
    const key = rowKey(r);
    if (state.posted[key]) { log('Skip duplicate (large):', key); continue; }
    await postDiscord(WEBHOOK_LARGE, makeEmbed(r, 'Large Sweep'));
    state.posted[key] = Date.now(); posted++; await sleep(400);
  }

  const groups = new Map();
  for (const r of state.recent) {
    const k = `${r.Symbol}|${r.Type}|${r.Strike}|${r.ExpirationISO}`;
    let g = groups.get(k);
    if (!g) {
      g = { key: k, Symbol: r.Symbol, Type: r.Type, Strike: r.Strike, ExpirationISO: r.ExpirationISO,
            volumeSum: 0, oiSum: 0, premiumSum: 0, earliest: Infinity, latest: 0, rows: [] };
      groups.set(k, g);
    }
    g.volumeSum += r.Volume;
    g.oiSum += r.OI;
    g.premiumSum += r.Premium;
    const t = Date.parse(r.Time) || 0;
    if (t && t < g.earliest) g.earliest = t;
    if (t && t > g.latest) g.latest = t;
    g.rows.push(r);
  }

  for (const g of groups.values()) {
    const voloi = g.volumeSum / g.oiSum;
    const ref = g.rows.reduce((a, b) => (b.ts > a.ts ? b : a), g.rows[0]);
    const cand = {
      Symbol: g.Symbol,
      Type: g.Type,
      Strike: g.Strike,
      ExpirationISO: g.ExpirationISO,
      Volume: g.volumeSum,
      OI: g.oiSum,
      Premium: g.premiumSum,
      VolOI: Number.isFinite(voloi) ? Math.round(voloi * 100) / 100 : 0,
      Bid: ref.Bid,
      Ask: ref.Ask,
      Last: ref.Last,
      Moneyness: ref.Moneyness,
      Time: ref.Time
    };
    if (!isGoldenSweepLike(cand)) continue;
    if (state.posted[g.key]) { log('Skip duplicate (golden group):', g.key); continue; }
    await postDiscord(WEBHOOK_GOLDEN, makeEmbed(cand, 'GOLDEN Sweep'));
    state.posted[g.key] = Date.now();
    for (const r of g.rows) if (r.rowKey) state.posted[r.rowKey] = Date.now();
    posted++; await sleep(400);
  }

  const clusters = findPremiumClusters(groups, STRIKE_PCT_BAND, DATE_BAND_DAYS, CLUSTER_MIN_PREMIUM, state);
  for (const c of clusters) {
    const cKey = `${c.symbol}|${c.type}|${c.strikeLo}-${c.strikeHi}|${c.expLo}-${c.expHi}`;
    
    const lastData = state.clusterData[cKey];
    let shouldPost = false;
    let reasonLog = '';
    
    if (!lastData) {
      // cluster חדש - פרסם
      shouldPost = true;
      reasonLog = 'new cluster';
    } else {
      // בדיקה אם יש עסקאות חדשות שלא היו בפרסום האחרון
      const lastRowKeysSet = new Set(lastData.rowKeys || []);
      const newTrades = c.rowKeys.filter(rk => !lastRowKeysSet.has(rk));
      
      if (newTrades.length === 0) {
        // אין עסקאות חדשות - לא לפרסם
        shouldPost = false;
        reasonLog = `no new trades (${c.rowKeys.length} existing trades)`;
      } else {
        // יש עסקאות חדשות - בדיקה אם הפרמיה קפצה מספיק
        const premiumJump = c.premiumSum - lastData.premium;
        
        if (premiumJump >= CLUSTER_PREMIUM_JUMP) {
          shouldPost = true;
          reasonLog = `premium jump ${premiumJump.toLocaleString()} with ${newTrades.length} new trades`;
        } else {
          shouldPost = false;
          reasonLog = `insufficient jump ${premiumJump.toLocaleString()} (${newTrades.length} new trades)`;
        }
      }
    }
    
    if (!shouldPost) {
      log(`Skip cluster ${cKey}: ${reasonLog}`);
      continue;
    }
    
    // פרסום
    const embed = [{
      title: `Premium Cluster: ${c.symbol} ${c.type}`,
      color: c.type === 'Call' ? 0x2ecc71 : 0xe74c3c,
      fields: [
        { name: 'Strikes', value: `${c.strikeLo}-${c.strikeHi}`, inline: true },
        { name: 'Expirations', value: `${fmtUS(c.expLo)} - ${fmtUS(c.expHi)}`, inline: true },
        { name: 'Premium Sum ~$', value: c.premiumSum.toLocaleString(), inline: true },
        { name: 'Link', value: `https://www.barchart.com/stocks/quotes/${c.symbol}/options`, inline: false }
      ],
      footer: { text: 'Source: Barchart Unusual Options (free)' }
    }];
    
    await postDiscord(WEBHOOK_GOLDEN, embed);
    state.posted[cKey] = Date.now();
    
    // שמירת הנתונים של הפרסום
    state.clusterData[cKey] = {
      premium: c.premiumSum,
      timestamp: Date.now(),
      rowKeys: c.rowKeys
    };
    
    log(`Posted cluster ${cKey}: ${reasonLog}`);
    posted++; await sleep(400);
  }

  const cutoff = Date.now() - 2 * 86400000;
  for (const [k, ts] of Object.entries(state.posted)) if (ts < cutoff) delete state.posted[k];
  
  // ניקוי נתוני clusters ישנים (יותר מ-7 ימים)
  const dataCutoff = Date.now() - 7 * 86400000;
  for (const [k, data] of Object.entries(state.clusterData)) {
    if (data.timestamp < dataCutoff) {
      delete state.clusterData[k];
    }
  }
  
  await saveState(state);

  log(`DONE. Parsed:${rows.length} Posted:${posted}`);
}

main().catch(e => { log('FATAL', e); process.exit(1); });