const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// ─── State ────────────────────────────────────────────────────────────────────
let SC_CLIENT_ID = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Headers ──────────────────────────────────────────────────────────────────
// No 'br' — axios does NOT support brotli decompression (known bug).
// Without this, CDNs send brotli, axios can't decode it, data comes back undefined.
const PAGE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
};

// ─── client_id patterns ───────────────────────────────────────────────────────
const ID_PATTERNS = [
  /client_id\s*[=:,]\s*["']([a-zA-Z0-9]{32})["']/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /[,{(]client_id:"([a-zA-Z0-9]{32})"/,
  /client_id=([a-zA-Z0-9]{32})[&"'\s,)]/,
];

function findId(text) {
  for (const p of ID_PATTERNS) {
    const m = text.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ─── Page fetcher ─────────────────────────────────────────────────────────────
async function getPage(url) {
  try {
    const res = await axios.get(url, {
      headers:        PAGE_HEADERS,
      timeout:        15000,
      decompress:     true,
      responseType:   'text',           // ALWAYS returns a string, never undefined
      validateStatus: s => s < 500,     // Don't throw on 4xx — log it instead
    });
    const html = res.data || '';
    console.log(`[SC] ${url} → HTTP ${res.status} | ${html.length} bytes`);
    return html;
  } catch (err) {
    console.warn(`[SC] Page request failed: ${err.message}`);
    return null;
  }
}

// ─── Script fetcher ───────────────────────────────────────────────────────────
async function getScript(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent':      PAGE_HEADERS['User-Agent'],
        'Accept':          '*/*',
        'Accept-Encoding': 'gzip, deflate',
        'Referer':         'https://soundcloud.com/',
      },
      timeout:        12000,
      decompress:     true,
      responseType:   'text',           // THE critical fix — forces string output
      validateStatus: s => s < 500,
    });
    const text = res.data || '';
    console.log(`[SC] Script ${url.split('/').pop()} → HTTP ${res.status} | ${text.length} bytes`);
    // Skip anything suspiciously small (Cloudflare error pages, etc.)
    if (res.status !== 200 || text.length < 5000) {
      console.log(`[SC]   ↳ Skipping (${res.status !== 200 ? 'non-200' : 'too small < 5KB'})`);
      return null;
    }
    return text;
  } catch (err) {
    console.warn(`[SC] Script request failed: ${err.message}`);
    return null;
  }
}

// ─── Extraction ───────────────────────────────────────────────────────────────
async function tryExtract() {
  const pages = ['https://soundcloud.com', 'https://soundcloud.com/discover'];

  for (const pageUrl of pages) {
    const html = await getPage(pageUrl);
    if (!html || html.length < 5000) continue;

    // 1. Inline <script> blocks (fast, no extra request)
    for (const [, content] of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) {
      const id = findId(content);
      if (id) { console.log('[SC] ✓ Found client_id in inline <script>'); return id; }
    }

    // 2. Scan raw HTML text for a-v2.sndcdn.com bundle URLs
    //    SoundCloud's webpack embeds these as string literals in inline JS —
    //    they do NOT always appear as <script src=""> attributes.
    const bundleUrls = [
      ...new Set(
        [...html.matchAll(/https?:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9._-]+\.js/g)]
          .map(m => m[0])
      ),
    ];

    // Also grab any <script src=""> that points to sndcdn or soundcloud assets
    const srcUrls = [...html.matchAll(/src=["'](https?:\/\/[^"']*(?:sndcdn|soundcloud)[^"']*\.js[^"']*)["']/g)]
      .map(m => m[1]);

    const allUrls = [...new Set([...bundleUrls, ...srcUrls])];
    console.log(`[SC] Found ${allUrls.length} bundle URL(s) to check in ${pageUrl}`);

    // Check in reverse — app bundle (containing client_id) is usually the last/largest
    for (const url of [...allUrls].reverse().slice(0, 10)) {
      const js = await getScript(url);
      if (!js) continue;
      const id = findId(js);
      if (id) { console.log(`[SC] ✓ Found client_id in bundle: ${url.split('/').pop()}`); return id; }
      console.log(`[SC]   ↳ No client_id pattern matched`);
    }
  }

  return null;
}

// ─── Fetch loop ───────────────────────────────────────────────────────────────
async function fetchClientId() {
  // Priority 1: env var — set SC_CLIENT_ID in Render → Environment for instant fix.
  // How to find it: open soundcloud.com in browser → DevTools → Network →
  // click any api-v2.soundcloud.com request → copy client_id from the URL.
  if (process.env.SC_CLIENT_ID) {
    SC_CLIENT_ID = process.env.SC_CLIENT_ID;
    console.log('✅ client_id loaded from SC_CLIENT_ID env var');
    return;
  }

  const delays = [5000, 10000, 15000, 30000, 60000];
  let attempt = 0;

  while (true) {
    attempt++;
    console.log(`🔍 [Attempt ${attempt}] Fetching SoundCloud client_id…`);
    try {
      const id = await tryExtract();
      if (!id) throw new Error('client_id not found in any bundle');
      SC_CLIENT_ID = id;
      console.log(`✅ client_id: ${id}`);
      // Refresh every 6 hours
      setTimeout(() => { SC_CLIENT_ID = null; fetchClientId(); }, 6 * 60 * 60 * 1000);
      return;
    } catch (err) {
      const delay = delays[Math.min(attempt - 1, delays.length - 1)];
      console.warn(`⚠️  Attempt ${attempt} failed: ${err.message}. Retrying in ${delay / 1000}s…`);
      await sleep(delay);
    }
  }
}

fetchClientId(); // runs immediately on boot, retries forever

// ─── SoundCloud API helper ────────────────────────────────────────────────────
async function scGet(url, params = {}, retried = false) {
  if (!SC_CLIENT_ID) throw new Error('client_id not available yet');
  try {
    const { data } = await axios.get(url, {
      params:       { ...params, client_id: SC_CLIENT_ID },
      headers:      { 'User-Agent': PAGE_HEADERS['User-Agent'], Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      timeout:      12000,
      decompress:   true,
      responseType: 'json',
    });
    return data;
  } catch (err) {
    if (!retried && (err.response?.status === 401 || err.response?.status === 403)) {
      console.warn('[API] 401/403 — refreshing client_id and retrying');
      SC_CLIENT_ID = null;
      fetchClientId();
      await sleep(3000);
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
    version:     '1.6.0',
    description: 'Search and stream music from SoundCloud',
    icon:        'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-orange-2xhdpi-a9dce059.png',
    resources:   ['search', 'stream'],
    types:       ['track'],
  });
});

// GET /search?q=…
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tracks: [] });

  if (!SC_CLIENT_ID) {
    return res.status(503).json({
      error:  'client_id not ready yet — still fetching. Retry in a few seconds.',
      tracks: [],
    });
  }

  try {
    const data = await scGet('https://api-v2.soundcloud.com/search/tracks', {
      q, limit: 20, offset: 0, linked_partitioning: 1,
    });

    res.json({
      tracks: (data.collection || []).map(t => ({
        id:         String(t.id),
        title:      t.title             || 'Unknown Title',
        artist:     t.user?.username    || 'Unknown Artist',
        album:      null,
        duration:   t.duration ? Math.floor(t.duration / 1000) : null,
        artworkURL: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : null,
        format:     'aac',
      })),
    });
  } catch (err) {
    console.error('[/search]', err.message);
    res.status(500).json({ error: 'Search failed', tracks: [] });
  }
});

// GET /stream/:id
app.get('/stream/:id', async (req, res) => {
  if (!SC_CLIENT_ID) {
    return res.status(503).json({ error: 'client_id not ready yet — retry in a few seconds' });
  }

  const trackId = req.params.id;

  try {
    // Try URN format first (SoundCloud 2025 API standard), fall back to numeric
    let track;
    try {
      track = await scGet(`https://api-v2.soundcloud.com/tracks/soundcloud:tracks:${trackId}`);
    } catch {
      track = await scGet(`https://api-v2.soundcloud.com/tracks/${trackId}`);
    }

    const transcodings = track?.media?.transcodings || [];

    // AAC HLS is the only format since Jan 2026 (MP3 progressive removed Dec 31 2025)
    const chosen =
      transcodings.find(t => t.format?.protocol === 'hls' && t.format?.mime_type?.includes('aac'))  ||
      transcodings.find(t => t.format?.protocol === 'hls' && t.format?.mime_type?.includes('mpeg')) ||
      transcodings.find(t => t.format?.protocol === 'progressive')                                  ||
      transcodings[0];

    if (!chosen?.url) {
      return res.status(404).json({ error: 'No streamable transcoding found for this track' });
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
  res.json({ status: 'ok', clientIdReady: !!SC_CLIENT_ID, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`🎵 SoundCloud Eclipse Addon on port ${PORT}`));
