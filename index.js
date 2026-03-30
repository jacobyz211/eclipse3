const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// ─── Axios with Cookie Jar ────────────────────────────────────────────────────
// A persistent cookie jar lets us act more like a real browser session.
const jar        = new CookieJar();
const httpClient = wrapper(axios.create({ jar, withCredentials: true }));

// ─── Client ID State ──────────────────────────────────────────────────────────
let cachedClientId  = null;
let fetchingPromise = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Headers ──────────────────────────────────────────────────────────────────
// CRITICAL: Do NOT include 'br' in Accept-Encoding.
// axios cannot reliably decompress brotli responses on Node.js, causing
// silent garbage output that never matches any regex.
const PAGE_HEADERS = {
  'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language':           'en-US,en;q=0.9',
  'Accept-Encoding':           'gzip, deflate',   // no 'br' — see above
  'Cache-Control':             'max-age=0',
  'Sec-Ch-Ua':                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile':          '?0',
  'Sec-Ch-Ua-Platform':        '"Windows"',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
  'Sec-Fetch-User':            '?1',
  'Upgrade-Insecure-Requests': '1',
  'DNT':                       '1',
  'Connection':                'keep-alive',
};

const SCRIPT_HEADERS = {
  'User-Agent':      PAGE_HEADERS['User-Agent'],
  'Accept':          '*/*',
  'Accept-Encoding': 'gzip, deflate',
  'Sec-Fetch-Dest':  'script',
  'Sec-Fetch-Mode':  'no-cors',
  'Sec-Fetch-Site':  'cross-site',
};

// ─── Pattern Matching ─────────────────────────────────────────────────────────
// Matches 20-36 char alphanumeric IDs (SoundCloud uses 32 chars currently)
const CLIENT_ID_RES = [
  /[,{(\s]client_id\s*[:=]\s*["']([a-zA-Z0-9]{20,36})["']/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{20,36})"/,
  /"client_id","([a-zA-Z0-9]{20,36})"/,
  /client_id=([a-zA-Z0-9]{20,36})[&"'\s,)]/,
  /clientId\s*[:=]\s*["']([a-zA-Z0-9]{20,36})["']/,
  /\?client_id=([a-zA-Z0-9]{20,36})/,
];

function findClientId(text) {
  for (const re of CLIENT_ID_RES) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────
async function fetchPage(url, extraHeaders = {}) {
  try {
    const res = await httpClient.get(url, {
      headers:        { ...PAGE_HEADERS, ...extraHeaders },
      timeout:        20000,
      maxRedirects:   5,
      validateStatus: s => s < 500,
      // Explicit decompress: true ensures axios uses its gzip handler
      decompress: true,
    });
    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    console.log(`[SC] ${url} → HTTP ${res.status} | ${html.length} bytes`);

    // Diagnostic: short responses usually mean a bot-check page
    if (html.length < 3000) {
      console.warn(`[SC] ⚠ Short response — possible bot-protection page`);
      console.warn(`[SC] Preview: ${html.slice(0, 400).replace(/\s+/g, ' ')}`);
    }
    return html;
  } catch (err) {
    console.warn(`[SC] ✗ ${url}: ${err.message}`);
    return null;
  }
}

async function fetchScript(url, referer) {
  try {
    const {  js } = await axios.get(url, {
      headers:    { ...SCRIPT_HEADERS, Referer: referer },
      timeout:    15000,
      decompress: true,
    });
    return typeof js === 'string' ? js : JSON.stringify(js);
  } catch {
    return null;
  }
}

// ─── Script Scanning ──────────────────────────────────────────────────────────
async function scanScriptsForClientId(html, origin) {
  // Collect all script src URLs — both absolute and relative
  const urls = new Set();
  for (const [, src] of html.matchAll(/src=["']([^"']+\.js[^"']{0,30})["']/g)) {
    const full = src.startsWith('http') ? src : `${origin}${src.startsWith('/') ? '' : '/'}${src}`;
    // Only check SoundCloud/sndcdn assets
    if (full.includes('sndcdn') || full.includes('soundcloud') || full.includes('/assets/')) {
      urls.add(full);
    }
  }

  const list = [...urls].reverse().slice(0, 10);
  console.log(`[SC] Checking ${list.length} script(s) from ${origin}`);

  for (const url of list) {
    const js = await fetchScript(url, origin + '/');
    if (!js) continue;
    const id = findClientId(js);
    if (id) {
      console.log(`[SC] ✓ client_id found in script: ${url}`);
      return id;
    }
  }
  return null;
}

// ─── Multi-Strategy Extraction ────────────────────────────────────────────────
async function extractClientId() {
  const strategies = [
    // ── Strategy A: Main site pages ──────────────────────────────────────────
    { url: 'https://soundcloud.com',             origin: 'https://soundcloud.com' },
    { url: 'https://soundcloud.com/discover',    origin: 'https://soundcloud.com' },
    { url: 'https://soundcloud.com/charts/top',  origin: 'https://soundcloud.com' },

    // ── Strategy B: Widget embed (different subdomain = different CF rules) ──
    {
      url:    'https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/forss/flickermood&show_artwork=true',
      origin: 'https://w.soundcloud.com',
      extra:  { Referer: 'https://soundcloud.com/', Origin: 'https://soundcloud.com' },
    },
    {
      url:    'https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/charliexcx/360',
      origin: 'https://w.soundcloud.com',
      extra:  { Referer: 'https://soundcloud.com/', Origin: 'https://soundcloud.com' },
    },

    // ── Strategy C: Mobile UA (different CF fingerprint) ─────────────────────
    {
      url:    'https://soundcloud.com',
      origin: 'https://soundcloud.com',
      extra:  {
        'User-Agent':       'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Sec-Ch-Ua-Mobile': '?1',
      },
    },
  ];

  // Warm up cookies first — mimics a real browser flow
  try {
    await httpClient.get('https://soundcloud.com/', { headers: PAGE_HEADERS, timeout: 10000 });
    console.log('[SC] Cookie warm-up done');
  } catch { /* non-fatal */ }

  for (const { url, origin, extra = {} } of strategies) {
    const html = await fetchPage(url, extra);
    if (!html) continue;

    // 1. Check raw HTML body
    const rawId = findClientId(html);
    if (rawId) { console.log('[SC] ✓ Found in raw HTML'); return rawId; }

    // 2. Check inline <script> tags
    for (const [, content] of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) {
      const id = findClientId(content);
      if (id) { console.log('[SC] ✓ Found in inline <script>'); return id; }
    }

    // 3. Scan external JS bundles
    const bundleId = await scanScriptsForClientId(html, origin);
    if (bundleId) return bundleId;
  }

  throw new Error('client_id not found across all strategies');
}

// ─── Client ID Manager ────────────────────────────────────────────────────────
async function getClientId() {
  if (cachedClientId) return cachedClientId;
  if (fetchingPromise) return fetchingPromise;

  fetchingPromise = (async () => {
    const MAX = 20;
    for (let i = 1; i <= MAX; i++) {
      try {
        console.log(`[client_id] Attempt ${i}/${MAX}…`);
        const id = await extractClientId();
        cachedClientId  = id;
        fetchingPromise = null;
        console.log(`[client_id] ✓ ${id}`);
        return id;
      } catch (err) {
        console.error(`[client_id] ✗ Attempt ${i}: ${err.message}`);
        if (i < MAX) {
          // Linear back-off capped at 2 minutes
          const delay = Math.min(10000 * i, 120000);
          console.log(`[client_id] Retrying in ${delay / 1000}s…`);
          await sleep(delay);
        }
      }
    }
    fetchingPromise = null;
    throw new Error('Exhausted all client_id attempts');
  })();

  return fetchingPromise;
}

function invalidateClientId() {
  console.log('[client_id] Cache invalidated');
  cachedClientId = null;
}

// Proactive refresh every 6 hours
setInterval(() => {
  invalidateClientId();
  getClientId().catch(e => console.error('[client_id] Scheduled refresh failed:', e.message));
}, 6 * 60 * 60 * 1000);

// Startup fetch
getClientId().catch(e => console.error('[client_id] Startup fetch failed:', e.message));

// ─── SoundCloud API Caller ────────────────────────────────────────────────────
async function scGet(url, params = {}, retried = false) {
  const id = await getClientId();
  try {
    const { data } = await axios.get(url, {
      params:  { ...params, client_id: id },
      headers: {
        'User-Agent':      PAGE_HEADERS['User-Agent'],
        'Accept':          'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      timeout:    12000,
      decompress: true,
    });
    return data;
  } catch (err) {
    if (!retried && (err.response?.status === 401 || err.response?.status === 403)) {
      console.warn('[API] 401/403 — invalidating client_id and retrying…');
      invalidateClientId();
      return scGet(url, params, true);
    }
    throw err;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/manifest.json', (_req, res) => {
  res.json({
    id:          'com.eclipse.soundcloud',
    name:        'SoundCloud',
    version:     '1.4.0',
    description: 'Search and stream music from SoundCloud',
    icon:        'https://a-v2.sndcdn.com/assets/images/sc-icons/favicon-2cadd14bdb.ico',
    resources:   ['search', 'stream'],
    types:       ['track'],
  });
});

// GET /search?q=…
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tracks: [] });

  try {
    const data = await scGet('https://api-v2.soundcloud.com/search/tracks', {
      q, limit: 20, offset: 0, linked_partitioning: 1,
    });

    const tracks = (data.collection || []).map(t => ({
      id:         String(t.id),
      title:      t.title                || 'Unknown Title',
      artist:     t.user?.username       || 'Unknown Artist',
      album:      null,
      duration:   t.duration ? Math.floor(t.duration / 1000) : null,
      artworkURL: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : null,
      format:     'aac',
    }));

    res.json({ tracks });
  } catch (err) {
    console.error('[/search]', err.message);
    res.status(500).json({ error: 'Search failed', tracks: [] });
  }
});

// GET /stream/:id
app.get('/stream/:id', async (req, res) => {
  const id = req.params.id;

  try {
    let track;
    try {
      // Prefer URN format (SoundCloud 2025 API migration)
      track = await scGet(`https://api-v2.soundcloud.com/tracks/soundcloud:tracks:${id}`);
    } catch {
      // Fall back to numeric ID
      track = await scGet(`https://api-v2.soundcloud.com/tracks/${id}`);
    }

    const transcodings = track?.media?.transcodings || [];

    // Preference order — AAC HLS is the only format since Jan 2026
    const prefs = [
      t => t.format?.protocol === 'hls'         && t.format?.mime_type?.includes('aac'),
      t => t.format?.protocol === 'hls'         && t.format?.mime_type?.includes('mpeg'),
      t => t.format?.protocol === 'progressive' && t.format?.mime_type?.includes('mpeg'),
      t => t.format?.protocol === 'progressive',
      t => !!t.url,
    ];

    let chosen = null;
    for (const test of prefs) {
      chosen = transcodings.find(test);
      if (chosen) break;
    }

    if (!chosen?.url) {
      return res.status(404).json({ error: 'No streamable transcoding found' });
    }

    const streamData = await scGet(chosen.url);
    if (!streamData?.url) {
      return res.status(404).json({ error: 'SoundCloud did not return a stream URL' });
    }

    res.json({
      url:     streamData.url,
      format:  chosen.format?.mime_type?.includes('aac') ? 'aac' : 'mp3',
      quality: '160kbps',
    });
  } catch (err) {
    console.error('[/stream]', err.message);
    res.status(500).json({ error: 'Stream resolution failed' });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    status:        'ok',
    clientIdReady: !!cachedClientId,
    timestamp:     new Date().toISOString(),
  });
});

app.listen(PORT, () => console.log(`SoundCloud Eclipse Addon on port ${PORT}`));
