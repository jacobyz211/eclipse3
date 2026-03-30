const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// ─── Client ID ────────────────────────────────────────────────────────────────
let SC_CLIENT_ID = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  // ⚠️ No 'br' — axios silently fails to decompress brotli, giving garbage output
  'Accept-Encoding': 'gzip, deflate',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const CLIENT_ID_PATTERNS = [
  /client_id\s*[=:,]\s*["']([a-zA-Z0-9]{32})["']/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /[,{]client_id:"([a-zA-Z0-9]{32})"/,
  /client_id=([a-zA-Z0-9]{32})[&"'\s,)]/,
];

function findId(text) {
  for (const p of CLIENT_ID_PATTERNS) {
    const m = text.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

async function tryExtract() {
  const pages = ['https://soundcloud.com', 'https://soundcloud.com/discover'];

  for (const pageUrl of pages) {
    let html;
    try {
      const res = await axios.get(pageUrl, {
        headers:    HEADERS,
        timeout:    15000,
        decompress: true,
      });
      html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      console.log(`[SC] ${pageUrl} → ${res.status} | ${html.length} bytes`);
    } catch (err) {
      console.warn(`[SC] Page failed: ${err.message}`);
      continue;
    }

    // ── Check inline <script> blocks first ────────────────────────────────
    for (const [, content] of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) {
      const id = findId(content);
      if (id) { console.log('[SC] ✓ Found in inline script'); return id; }
    }

    // ── Your original working approach: find a-v2.sndcdn.com bundle URLs ──
    // Scans the entire raw HTML — catches URLs in inline JS, not just <script src="">
    const bundleUrls = [
      ...new Set(
        [...html.matchAll(/https?:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9._-]+\.js/g)]
          .map(m => m[0])
      ),
    ];
    console.log(`[SC] Found ${bundleUrls.length} bundle URL(s) in HTML`);

    // Check in reverse order — app bundle (with client_id) is usually last
    for (const url of [...bundleUrls].reverse().slice(0, 8)) {
      try {
        const {  js } = await axios.get(url, {
          headers: {
            'User-Agent':      HEADERS['User-Agent'],
            'Accept-Encoding': 'gzip, deflate',
          },
          timeout:    12000,
          decompress: true,
        });
        const text = typeof js === 'string' ? js : JSON.stringify(js);
        console.log(`[SC] Checking ${url.split('/').pop()} — ${text.length} bytes`);
        const id = findId(text);
        if (id) { console.log(`[SC] ✓ Found in bundle`); return id; }
      } catch (err) {
        console.warn(`[SC] Bundle fetch failed: ${err.message}`);
      }
    }
  }
  return null;
}

async function fetchClientId() {
  // Priority 1: env var (set SC_CLIENT_ID in Render → Environment)
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

fetchClientId(); // start immediately on boot

// ─── SoundCloud API call (auto-retries if client_id expired) ─────────────────
async function scGet(url, params = {}, retried = false) {
  if (!SC_CLIENT_ID) throw new Error('client_id not available yet');
  try {
    const { data } = await axios.get(url, {
      params:  { ...params, client_id: SC_CLIENT_ID },
      headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      timeout: 12000,
      decompress: true,
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

// ─── Eclipse Addon Endpoints ──────────────────────────────────────────────────

app.get('/manifest.json', (_req, res) => {
  res.json({
    id:          'com.eclipse.soundcloud',
    name:        'SoundCloud',
    version:     '1.5.0',
    description: 'Search and stream music from SoundCloud',
    icon:        'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-orange-2xhdpi-a9dce059.png',
    resources:   ['search', 'stream'],
    types:       ['track'],
  });
});

// GET /search?q={query}
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
        title:      t.title                || 'Unknown Title',
        artist:     t.user?.username       || 'Unknown Artist',
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
    // Fetch track — try URN format (2025 API), fall back to numeric ID
    let track;
    try {
      track = await scGet(`https://api-v2.soundcloud.com/tracks/soundcloud:tracks:${trackId}`);
    } catch {
      track = await scGet(`https://api-v2.soundcloud.com/tracks/${trackId}`);
    }

    const transcodings = track?.media?.transcodings || [];
    // AAC HLS is the only format since Jan 2026 (MP3 progressive removed Dec 31, 2025)
    const chosen =
      transcodings.find(t => t.format?.protocol === 'hls' && t.format?.mime_type?.includes('aac')) ||
      transcodings.find(t => t.format?.protocol === 'hls') ||
      transcodings.find(t => t.format?.protocol === 'progressive') ||
      transcodings[0];

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
  res.json({ status: 'ok', clientIdReady: !!SC_CLIENT_ID, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`🎵 SoundCloud Eclipse Addon running on port ${PORT}`));
