const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// ─── State ────────────────────────────────────────────────────────────────────
let SC_CLIENT_ID = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TRACK_CACHE = new Map();

function cleanupText(s = '') {
  return String(s)
    .replace(/\s+/g, ' ')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();
}

function stripFeatures(s = '') {
  return cleanupText(
    s
      .replace(/\\((feat|ft|featuring)[^)]+\\)/gi, '')
      .replace(/\\[(feat|ft|featuring)[^\\]]+\]/gi, '')
      .replace(/\b(feat|ft|featuring)\.?\s+[^-–|/]+/gi, '')
  );
}

function parseArtistTitle(track) {
  const rawTitle = cleanupText(track?.title || '');
  const metaArtist = cleanupText(
    track?.publisher_metadata?.artist ||
    track?.publisher_metadata?.writer_composer ||
    ''
  );
  const uploader = cleanupText(track?.user?.username || '');

  if (rawTitle.includes(' - ')) {
    const [left, ...rest] = rawTitle.split(' - ');
    const right = rest.join(' - ').trim();
    if (left && right) {
      return {
        artist: cleanupText(metaArtist || left),
        title: cleanupText(right),
        rawTitle,
        uploader
      };
    }
  }

  return {
    artist: cleanupText(metaArtist || uploader),
    title: rawTitle,
    rawTitle,
    uploader
  };
}

function rememberTrack(track) {
  const meta = parseArtistTitle(track);
  TRACK_CACHE.set(String(track.id), {
    id: String(track.id),
    artist: meta.artist,
    title: meta.title,
    rawTitle: meta.rawTitle,
    uploader: meta.uploader,
    artworkURL: track.artwork_url ? track.artwork_url.replace('-large', '-t500x500') : null
  });
}

// ─── Headers ──────────────────────────────────────────────────────────────────
// No 'br' — axios can't decompress brotli, returns undefined data
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

// ─── Page / Script fetchers ───────────────────────────────────────────────────
async function getPage(url) {
  try {
    const res = await axios.get(url, {
      headers: PAGE_HEADERS, timeout: 15000, decompress: true,
      responseType: 'text', validateStatus: s => s < 500,
    });
    const html = res.data || '';
    console.log(`[SC] ${url} → HTTP ${res.status} | ${html.length} bytes`);
    return html;
  } catch (err) { console.warn(`[SC] Page failed: ${err.message}`); return null; }
}

async function getScript(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': PAGE_HEADERS['User-Agent'], 'Accept': '*/*', 'Accept-Encoding': 'gzip, deflate', 'Referer': 'https://soundcloud.com/' },
      timeout: 12000, decompress: true, responseType: 'text', validateStatus: s => s < 500,
    });
    const text = res.data || '';
    console.log(`[SC] Script ${url.split('/').pop()} → ${res.status} | ${text.length} bytes`);
    if (res.status !== 200 || text.length < 5000) return null;
    return text;
  } catch (err) { console.warn(`[SC] Script failed: ${err.message}`); return null; }
}

// ─── client_id extraction ─────────────────────────────────────────────────────
async function tryExtract() {
  for (const pageUrl of ['https://soundcloud.com', 'https://soundcloud.com/discover']) {
    const html = await getPage(pageUrl);
    if (!html || html.length < 5000) continue;

    for (const [, c] of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) {
      const id = findId(c);
      if (id) { console.log('[SC] ✓ client_id in inline script'); return id; }
    }

    const bundleUrls = [...new Set(
      [...html.matchAll(/https?:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9._-]+\.js/g)].map(m => m[0])
    )];
    const srcUrls = [...html.matchAll(/src=["'](https?:\/\/[^"']*(?:sndcdn|soundcloud)[^"']*\.js[^"']*)["']/g)].map(m => m[1]);
    const all = [...new Set([...bundleUrls, ...srcUrls])];
    console.log(`[SC] Found ${all.length} bundle(s)`);

    for (const url of [...all].reverse().slice(0, 10)) {
      const js = await getScript(url);
      if (!js) continue;
      const id = findId(js);
      if (id) { console.log(`[SC] ✓ client_id in bundle`); return id; }
    }
  }
  return null;
}

async function fetchClientId() {
  if (process.env.SC_CLIENT_ID) {
    SC_CLIENT_ID = process.env.SC_CLIENT_ID;
    console.log('✅ client_id from env var');
    return;
  }
  const delays = [5000, 10000, 15000, 30000, 60000];
  let attempt = 0;
  while (true) {
    attempt++;
    console.log(`🔍 [Attempt ${attempt}] Fetching client_id…`);
    try {
      const id = await tryExtract();
      if (!id) throw new Error('Not found');
      SC_CLIENT_ID = id;
      console.log(`✅ client_id: ${id}`);
      setTimeout(() => { SC_CLIENT_ID = null; fetchClientId(); }, 6 * 60 * 60 * 1000);
      return;
    } catch (err) {
      const delay = delays[Math.min(attempt - 1, delays.length - 1)];
      console.warn(`⚠️  Attempt ${attempt} failed: ${err.message}. Retry in ${delay/1000}s…`);
      await sleep(delay);
    }
  }
}

fetchClientId();

// ─── SoundCloud API caller ────────────────────────────────────────────────────
async function scGet(url, params = {}, retried = false) {
  if (!SC_CLIENT_ID) throw new Error('client_id not ready');
  try {
    const { data } = await axios.get(url, {
      params: { ...params, client_id: SC_CLIENT_ID },
      headers: { 'User-Agent': PAGE_HEADERS['User-Agent'], Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      timeout: 12000, decompress: true,
    });
    return data;
  } catch (err) {
    if (!retried && (err.response?.status === 401 || err.response?.status === 403)) {
      SC_CLIENT_ID = null; fetchClientId(); await sleep(3000);
      return scGet(url, params, true);
    }
    throw err;
  }
}

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://piped-api.garudalinux.org',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.in.projectsegfau.lt',
];

async function pipedGet(path, params = {}) {
  for (const base of PIPED_INSTANCES) {
    try {
      const { data } = await axios.get(`${base}${path}`, {
        params,
        headers: { 'User-Agent': PAGE_HEADERS['User-Agent'] },
        timeout: 10000,
      });
      if (data) return data;
    } catch {}
  }
  return null;
}

function extractVideoIdFromAny(item) {
  if (!item) return null;

  if (typeof item.id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(item.id)) {
    return item.id;
  }

  if (typeof item.videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(item.videoId)) {
    return item.videoId;
  }

  const url = item.url || item.videoUrl || '';
  const m = String(url).match(/(?:v=|\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function scoreCandidate(item, query) {
  const hay = cleanupText(`${item?.title || item?.name || ''} ${item?.uploaderName || item?.uploader || ''}`).toLowerCase();
  const needles = cleanupText(query).toLowerCase().split(' ').filter(Boolean);
  return needles.reduce((n, token) => n + (hay.includes(token) ? 1 : 0), 0);
}

async function pipedSearchOnce(query, filter) {
  const data = await pipedGet('/search', filter ? { q: query, filter } : { q: query });
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  if (!items.length) return null;

  const ranked = items
    .map(item => ({ item, id: extractVideoIdFromAny(item), score: scoreCandidate(item, query) }))
    .filter(x => x.id)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.id || null;
}

async function youtubeSearch(title, artist) {
  const cleanTitle = cleanupText(title);
  const cleanArtist = cleanupText(artist);

  const queries = [
    `${cleanArtist} ${cleanTitle}`,
    `${cleanTitle} ${cleanArtist}`,
    `${stripFeatures(cleanTitle)} ${cleanArtist}`,
    `${cleanArtist} ${stripFeatures(cleanTitle)}`,
    cleanTitle,
    stripFeatures(cleanTitle),
    `${cleanArtist} ${cleanTitle} audio`,
  ].map(cleanupText).filter(Boolean);

  for (const q of [...new Set(queries)]) {
    console.log(`[YT] Search query: "${q}"`);

    const id1 = await pipedSearchOnce(q, 'music_songs');
    if (id1) return id1;

    const id2 = await pipedSearchOnce(q, 'videos');
    if (id2) return id2;

    const id3 = await pipedSearchOnce(q);
    if (id3) return id3;
  }

  return null;
}

async function youtubeStreamUrl(videoId) {
  const data = await pipedGet(`/streams/${videoId}`);
  if (!data) return null;

  const streams = Array.isArray(data.audioStreams) ? data.audioStreams : [];
  if (!streams.length) return null;

  const direct = streams.filter(s => s?.url && /^https?:\/\//i.test(s.url));

  const chosen =
    direct.find(s => (s.mimeType || '').includes('audio/mp4')) ||
    direct.find(s => (s.format || '').toUpperCase() === 'M4A') ||
    direct.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

  if (!chosen?.url) return null;

  return {
    url: chosen.url,
    format: 'm4a',
    quality: `${Math.round((chosen.bitrate || 128000) / 1000)}kbps`,
  };
}

async function youtubeFallback(title, artist) {
  const videoId = await youtubeSearch(title, artist);
  if (!videoId) {
    console.log('[YT] No video found');
    return null;
  }

  console.log(`[YT] Found videoId: ${videoId}`);
  return youtubeStreamUrl(videoId);
}


// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/manifest.json', (_req, res) => {
  res.json({
    id:          'com.eclipse.soundcloud',
    name:        'SoundCloud',
    version:     '2.0.0',
    description: 'Search SoundCloud. Plays everything — falls back to YouTube for restricted tracks.',
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
    return res.status(503).json({ error: 'client_id not ready yet — retry in a few seconds.', tracks: [] });
  }

  try {
    const data = await scGet('https://api-v2.soundcloud.com/search/tracks', {
      q, limit: 20, offset: 0, linked_partitioning: 1,
    });

const tracks = (data.collection || [])
  .filter(t => t.streamable !== false)
  .map(t => {
    rememberTrack(t);
    const meta = parseArtistTitle(t);

    return {
      id:         String(t.id),
      title:      meta.title || 'Unknown Title',
      artist:     meta.artist || 'Unknown Artist',
      album:      null,
      duration:   t.duration ? Math.floor(t.duration / 1000) : null,
      artworkURL: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : null,
      format:     'aac',
    };
  });
));

    res.json({ tracks });
  } catch (err) {
    console.error('[/search]', err.message);
    res.status(500).json({ error: 'Search failed', tracks: [] });
  }
});

// GET /stream/:id
app.get('/stream/:id', async (req, res) => {
  if (!SC_CLIENT_ID) {
    return res.status(503).json({ error: 'client_id not ready — retry in a few seconds' });
  }

  const trackId = req.params.id;
  let track = null;
  let cached = TRACK_CACHE.get(String(trackId)) || null;

  try {
    try {
      track = await scGet(`https://api-v2.soundcloud.com/tracks/soundcloud:tracks:${trackId}`);
    } catch {
      track = await scGet(`https://api-v2.soundcloud.com/tracks/${trackId}`);
    }
  } catch (err) {
    console.warn(`[/stream] Track lookup failed: ${err.message}`);
  }

  if (track) {
    rememberTrack(track);
    cached = TRACK_CACHE.get(String(trackId)) || cached;
  }

  // 1) Try SoundCloud first if we have a track object
  if (track && track.policy !== 'BLOCK') {
    try {
      const transcodings = track?.media?.transcodings || [];
      const chosen =
        transcodings.find(t => t.format?.protocol === 'hls' && t.format?.mime_type?.includes('aac')) ||
        transcodings.find(t => t.format?.protocol === 'hls') ||
        transcodings.find(t => t.format?.protocol === 'progressive') ||
        transcodings[0];

      if (chosen?.url) {
        const streamData = await scGet(chosen.url);
        if (streamData?.url) {
          console.log(`[/stream] ✓ SoundCloud stream for ${trackId}`);
          return res.json({
            url: streamData.url,
            format: chosen.format?.mime_type?.includes('aac') ? 'aac' : 'mp3',
            quality: '160kbps',
          });
        }
      }
    } catch (err) {
      console.warn(`[/stream] SoundCloud stream failed: ${err.message}`);
    }
  }

  // 2) Fallback to YouTube using cached or live metadata
  const meta = track ? parseArtistTitle(track) : cached;

  if (!meta?.title) {
    return res.status(404).json({ error: 'No SoundCloud stream and no metadata for YouTube fallback' });
  }

  const yt = await youtubeFallback(meta.title, meta.artist || meta.uploader || '');
  if (yt) {
    console.log(`[/stream] ✓ YouTube fallback for "${meta.artist} - ${meta.title}"`);
    return res.json(yt);
  }

  return res.status(404).json({
    error: `No playable SoundCloud stream and no YouTube fallback for "${meta.artist || ''} ${meta.title}"`.trim()
  });
});

