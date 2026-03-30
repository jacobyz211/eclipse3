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

// ─── Pattern Matching (same as before) ───────────────────────────────────────
const CLIENT_ID_RES = [
  /[,{(\s]client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /client_id=([a-zA-Z0-9]{32})[&"'\s,)]/,
  /clientId\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/,
  /\?client_id=([a-zA-Z0-9]{32})/,
  // broader fallback — 20-36 chars
  /[,{(\s]client_id\s*[:=]\s*["']([a-zA-Z0-9]{20,36})["']/,
];

function findClientId(text) {
  for (const re of CLIENT_ID_RES) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ─── Script Fetcher ───────────────────────────────────────────────────────────
async function fetchScript(url, referer) {
  try {
    const {  js, status } = await axios.get(url, {
      headers: {
        'User-Agent':      PAGE_HEADERS['User-Agent'],
        'Accept':          '*/*',
        'Accept-Encoding': 'gzip, deflate',
        'Referer':         referer,
        'Sec-Fetch-Dest':  'script',
        'Sec-Fetch-Mode':  'no-cors',
        'Sec-Fetch-Site':  'cross-site',
      },
      timeout:    15000,
      decompress: true,
      validateStatus: s => s < 500,
    });
    const text = typeof js === 'string' ? js : JSON.stringify(js);
    console.log(`[script] ${url.split('/').pop()} → ${status}, ${text.length} bytes`);
    return text;
  } catch (err) {
    console.warn(`[script] FAILED ${url.split('/').pop()}: ${err.message}`);
    return null;
  }
}

// ─── Extraction ───────────────────────────────────────────────────────────────
async function extractClientId() {
  // Warm-up to establish cookies
  try {
    await httpClient.get('https://soundcloud.com/', { headers: PAGE_HEADERS, timeout: 10000 });
    console.log('[SC] Cookie warm-up done');
  } catch { /* non-fatal */ }

  const pages = [
    { url: 'https://soundcloud.com',          origin: 'https://soundcloud.com' },
    { url: 'https://soundcloud.com/discover', origin: 'https://soundcloud.com' },
  ];

  for (const { url, origin } of pages) {
    const html = await fetchPage(url);
    if (!html) continue;

    // ── Step 1: Check raw HTML and inline <script> blocks ─────────────────────
    const rawId = findClientId(html);
    if (rawId) { console.log('[SC] ✓ Found in raw HTML'); return rawId; }

    for (const [, content] of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) {
      const id = findClientId(content);
      if (id) { console.log('[SC] ✓ Found in inline <script>'); return id; }
    }

    // ── Step 2: THE KEY FIX — find CDN bundle URLs anywhere in the HTML ───────
    // SoundCloud's webpack bootstrap embeds bundle URLs as string literals
    // inside inline JS, NOT as <script src=""> attributes.
    // e.g.: __webpack_require__.u=()=>"https://a-v2.sndcdn.com/assets/app-abc.js"
    const cdnUrls = [
      ...new Set([
        // Absolute a-v2.sndcdn.com asset URLs anywhere in the HTML text
        ...[...html.matchAll(/https?:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9._-]+\.js/g)]
          .map(m => m[0]),
        // Any sndcdn.com .js URL
        ...[...html.matchAll(/https?:\/\/[a-z0-9-]+\.sndcdn\.com\/[a-zA-Z0-9._\/-]+\.js/g)]
          .map(m => m[0]),
        // Also grab <script src="..."> attributes as a secondary source
        ...[...html.matchAll(/src=["'](https?:\/\/[^"']*\.js[^"']{0,20})["']/g)]
          .map(m => m[1])
          .filter(u => u.includes('sndcdn') || u.includes('/assets/')),
      ])
    ];

    console.log(`[SC] Found ${cdnUrls.length} CDN bundle URL(s) in HTML:`);
    cdnUrls.forEach(u => console.log(`  → ${u.split('/').pop()}`));

    // Check in reverse — the app bundle (containing client_id) is always last
    for (const scriptUrl of [...cdnUrls].reverse()) {
      const js = await fetchScript(scriptUrl, origin + '/');
      if (!js) continue;
      const id = findClientId(js);
      if (id) { console.log(`[SC] ✓ Found client_id in bundle`); return id; }
    }
  }

  throw new Error('client_id not found across all strategies');
}

// ─── Client ID Manager ────────────────────────────────────────────────────────
async function getClientId() {
  // ── Priority 1: Manual override via Render environment variable ───────────
  // Set SC_CLIENT_ID in Render's Environment tab for instant reliability.
  // Find it: open soundcloud.com → DevTools → Network → any api-v2.soundcloud.com
  // request → copy the client_id query parameter.
  if (process.env.SC_CLIENT_ID) {
    return process.env.SC_CLIENT_ID;
  }

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
