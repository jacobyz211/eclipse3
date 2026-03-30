const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// ─── Client ID State ──────────────────────────────────────────────────────────

let cachedClientId  = null;
let fetchingPromise = null;

const SC_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Client ID Extraction ─────────────────────────────────────────────────────

async function extractClientId() {
  const pages = [
    'https://soundcloud.com',
    'https://soundcloud.com/discover',
    'https://soundcloud.com/charts/top',
  ];

  for (const pageUrl of pages) {
    try {
      const {  html } = await axios.get(pageUrl, { headers: SC_HEADERS, timeout: 15000 });

      // Collect all sndcdn JS bundle URLs from the page
      const scriptUrls = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
        .map((m) => m[1]);

      // Scan in reverse — the app bundle (last script) holds the client_id
      for (const scriptUrl of [...scriptUrls].reverse()) {
        try {
          const {  js } = await axios.get(scriptUrl, { timeout: 10000 });
          const PATTERNS = [
            /client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/,
            /clientId\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/,
            /"client_id","([a-zA-Z0-9]{32})"/,
            /,client_id:"([a-zA-Z0-9]{32})"/,
            /\?client_id=([a-zA-Z0-9]{32})/,
          ];
          for (const p of PATTERNS) {
            const m = js.match(p);
            if (m) return m[1];
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  throw new Error('client_id not found in any SoundCloud page/script');
}

// ─── Client ID Manager (with retry + deduplication) ──────────────────────────

async function getClientId() {
  if (cachedClientId) return cachedClientId;

  // All concurrent callers share a single fetch promise
  if (fetchingPromise) return fetchingPromise;

  fetchingPromise = (async () => {
    const MAX = 10;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        console.log(`[client_id] Attempt ${attempt}/${MAX}…`);
        const id = await extractClientId();
        cachedClientId  = id;
        fetchingPromise = null;
        console.log(`[client_id] ✓ ${id}`);
        return id;
      } catch (err) {
        console.error(`[client_id] Attempt ${attempt} failed: ${err.message}`);
        if (attempt < MAX) {
          // Exponential back-off: 2s, 3s, 4.5s … capped at 60s
          const delay = Math.min(2000 * Math.pow(1.5, attempt - 1), 60000);
          console.log(`[client_id] Retrying in ${Math.round(delay / 1000)}s…`);
          await sleep(delay);
        }
      }
    }
    fetchingPromise = null;
    throw new Error('Exhausted all attempts to fetch SoundCloud client_id');
  })();

  return fetchingPromise;
}

function invalidateClientId() {
  console.log('[client_id] Invalidating cache');
  cachedClientId = null;
}

// Proactively refresh every 6 hours so the token never goes stale mid-use
setInterval(() => {
  invalidateClientId();
  getClientId().catch((e) => console.error('[client_id] Scheduled refresh failed:', e.message));
}, 6 * 60 * 60 * 1000);

// Warm up immediately on start
getClientId().catch((e) => console.error('[client_id] Startup fetch failed:', e.message));

// ─── SoundCloud API Helper ────────────────────────────────────────────────────

async function scGet(url, params = {}, retried = false) {
  const id  = await getClientId();
  const cfg = {
    params:  { ...params, client_id: id },
    headers: { ...SC_HEADERS, Accept: 'application/json' },
    timeout: 12000,
  };

  try {
    const res = await axios.get(url, cfg);
    return res.data;
  } catch (err) {
    // 401/403 almost always means an expired client_id — refresh & retry once
    if (!retried && (err.response?.status === 401 || err.response?.status === 403)) {
      console.warn('[API] 401/403 — refreshing client_id and retrying…');
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
    version:     '1.2.0',
    description: 'Search and stream music from SoundCloud',
    icon:        'https://a-v2.sndcdn.com/assets/images/sc-icons/favicon-2cadd14bdb.ico',
    resources:   ['search', 'stream'],
    types:       ['track'],
  });
});

// GET /search?q=…
app.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ tracks: [] });

  try {
    const data = await scGet('https://api-v2.soundcloud.com/search/tracks', {
      q:                   query,
      limit:               20,
      offset:              0,
      linked_partitioning: 1,
    });

    const tracks = (data.collection || []).map((t) => ({
      id:         String(t.id),
      title:      t.title      || 'Unknown Title',
      artist:     t.user?.username || 'Unknown Artist',
      album:      null,
      duration:   t.duration   ? Math.floor(t.duration / 1000) : null,
      // Upgrade artwork from 100px to 500px
      artworkURL: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : null,
      format:     'aac',
    }));

    res.json({ tracks });
  } catch (err) {
    console.error('[Search] Error:', err.message);
    res.status(500).json({ error: 'Search failed', tracks: [] });
  }
});

// GET /stream/:id
app.get('/stream/:id', async (req, res) => {
  const trackId = req.params.id;

  try {
    // SoundCloud's 2025 migration recommends URN format for track lookups
    const track        = await scGet(`https://api-v2.soundcloud.com/tracks/soundcloud:tracks:${trackId}`);
    const transcodings = track?.media?.transcodings || [];

    if (!transcodings.length) {
      // Fallback: try numeric ID path (older tracks)
      const fallback = await scGet(`https://api-v2.soundcloud.com/tracks/${trackId}`);
      transcodings.push(...(fallback?.media?.transcodings || []));
    }

    // Preference order — AAC HLS is the only format available as of Jan 2026
    const PREFS = [
      (t) => t.format?.protocol === 'hls'         && t.format?.mime_type?.includes('aac'),
      (t) => t.format?.protocol === 'hls'         && t.format?.mime_type?.includes('mpeg'),
      (t) => t.format?.protocol === 'progressive' && t.format?.mime_type?.includes('mpeg'),
      (t) => t.format?.protocol === 'progressive',
      (t) => !!t.url,
    ];

    let chosen = null;
    for (const test of PREFS) {
      chosen = transcodings.find(test);
      if (chosen) break;
    }

    if (!chosen?.url) {
      return res.status(404).json({ error: 'No streamable transcoding found for this track' });
    }

    // Resolve the transcoding URL to get the actual CDN stream URL
    const streamData = await scGet(chosen.url);
    const streamUrl  = streamData?.url;

    if (!streamUrl) {
      return res.status(404).json({ error: 'SoundCloud did not return a stream URL' });
    }

    res.json({
      url:     streamUrl,
      format:  chosen.format?.mime_type?.includes('aac') ? 'aac' : 'mp3',
      quality: '160kbps',
    });
  } catch (err) {
    console.error('[Stream] Error:', err.message);
    res.status(500).json({ error: 'Stream resolution failed' });
  }
});

// Health check (Render uses this to verify the service is up)
app.get('/health', (_req, res) => {
  res.json({
    status:       'ok',
    clientIdReady: !!cachedClientId,
    timestamp:    new Date().toISOString(),
  });
});

app.listen(PORT, () => console.log(`SoundCloud Eclipse Addon on port ${PORT}`));
