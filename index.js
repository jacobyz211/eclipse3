const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const Redis = require('ioredis');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── yt-dlp binary for YouTube fallback ───────────────────────────────────
const YTDLP_BIN = '/tmp/yt-dlp';
let ytdlpReady = false;

async function ensureYtdlp() {
  try {
    if (fs.existsSync(YTDLP_BIN)) fs.unlinkSync(YTDLP_BIN);
    console.log('[yt-dlp] downloading binary...');
    await execAsync(
      'curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ' +
        YTDLP_BIN +
        ' && chmod +x ' +
        YTDLP_BIN,
      { timeout: 60000 }
    );
    ytdlpReady = true;
    console.log('[yt-dlp] ready at ' + YTDLP_BIN);
  } catch (e) {
    console.error('[yt-dlp] install failed: ' + e.message);
    ytdlpReady = false;
  }
}
ensureYtdlp();

// ─── Redis ────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('error', e => console.error('[Redis]', e.message));
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set(
      'sc:token:' + token,
      JSON.stringify({
        clientId: entry.clientId,
        createdAt: entry.createdAt,
        lastUsed: entry.lastUsed,
        reqCount: entry.reqCount
      })
    );
  } catch (e) {
    console.error('[Redis] Save failed:', e.message);
  }
}

async function redisLoad(token) {
  if (!redis) return null;
  try {
    const d = await redis.get('sc:token:' + token);
    return d ? JSON.parse(d) : null;
  } catch (e) {
    return null;
  }
}

// ─── Token store / rate limiting ──────────────────────────────────────────
const TOKEN_CACHE = new Map();
const IP_CREATES = new Map();
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX = 60;
const RATE_WINDOW_MS = 60000;

function generateToken() {
  return crypto.randomBytes(14).toString('hex');
}

function getOrCreateIpBucket(ip) {
  const now = Date.now();
  let b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 86400000 };
    IP_CREATES.set(ip, b);
  }
  return b;
}

async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  const saved = await redisLoad(token);
  if (!saved) return null;
  const entry = {
    clientId: saved.clientId || null,
    createdAt: saved.createdAt,
    lastUsed: saved.lastUsed,
    reqCount: saved.reqCount,
    rateWin: []
  };
  TOKEN_CACHE.set(token, entry);
  return entry;
}

function checkRateLimit(entry) {
  const now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(t => now - t < RATE_WINDOW_MS);
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now);
  entry.lastUsed = now;
  entry.reqCount = (entry.reqCount || 0) + 1;
  return true;
}

async function tokenMiddleware(req, res, next) {
  const entry = await getTokenEntry(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Invalid token.' });
  if (!checkRateLimit(entry)) return res.status(429).json({ error: 'Rate limit exceeded.' });
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(req.params.token, entry);
  next();
}

function getBaseUrl(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
}

// ─── SoundCloud helpers ───────────────────────────────────────────────────
let SHARED_CLIENT_ID = null;
const TRACK_CACHE = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ID_PATTERNS = [
  /client_id\s*[=:,]\s*["']([a-zA-Z0-9]{32})["']/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /client_id=([a-zA-Z0-9]{32})[&"' \s,)]/
];

function findId(text) {
  for (const rx of ID_PATTERNS) {
    const m = text.match(rx);
    if (m) return m[1];
  }
  return null;
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function parseArtistTitle(track) {
  const raw = cleanText(track && track.title);
  const meta = cleanText(
    (track &&
      track.publisher_metadata &&
      (track.publisher_metadata.artist || track.publisher_metadata.writer_composer)) ||
      ''
  );
  const up = cleanText(track && track.user && track.user.username);
  if (raw.indexOf(' - ') !== -1) {
    const parts = raw.split(' - ');
    const L = cleanText(parts[0]);
    const R = cleanText(parts.slice(1).join(' - '));
    if (L && R) return { artist: meta || L, title: R, rawTitle: raw, uploader: up };
  }
  return { artist: meta || up, title: raw, rawTitle: raw, uploader: up };
}

function rememberTrack(t) {
  if (!t || !t.id) return;
  const m = parseArtistTitle(t);
  TRACK_CACHE.set(String(t.id), {
    id: String(t.id),
    artist: m.artist,
    title: m.title,
    rawTitle: m.rawTitle,
    uploader: m.uploader
  });
}

function artworkUrl(raw, fb) {
  const s = raw || fb || '';
  return s ? s.replace('-large', '-t500x500') : null;
}
function scYear(x) {
  return (x.release_date || x.created_at || '').slice(0, 4) || null;
}

function isFullyPlayable(t) {
  if (!t) return false;
  if (t.streamable === false) return false;
  const p = t.policy;
  if (!p || p === 'SNIP' || p === 'BLOCK') return false;
  return true;
}

async function getHtml(url) {
  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Encoding': 'gzip, deflate' },
      timeout: 15000,
      decompress: true,
      responseType: 'text',
      validateStatus: s => s < 500
    });
    return r.data || '';
  } catch (e) {
    return null;
  }
}

async function tryExtractClientId() {
  const html = await getHtml('https://soundcloud.com/');
  if (!html || html.length < 5000) return null;
  const direct = findId(html);
  if (direct) return direct;
  const assetRx = /<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/gi;
  let m;
  while ((m = assetRx.exec(html))) {
    try {
      const js = await axios.get(m[1], {
        headers: { 'User-Agent': UA, Accept: '*/*', Referer: 'https://soundcloud.com/' },
        timeout: 12000,
        responseType: 'text',
        validateStatus: s => s < 500
      });
      const id = findId(js.data || '');
      if (id) return id;
    } catch (e) {}
  }
  return null;
}

async function ensureClientId() {
  if (SHARED_CLIENT_ID) return SHARED_CLIENT_ID;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = await tryExtractClientId();
    if (id) {
      SHARED_CLIENT_ID = id;
      console.log('[SC] client_id:', id);
      return id;
    }
    await sleep(2000 + attempt * 1000);
  }
  throw new Error('Could not extract SoundCloud client_id');
}

function effectiveCid(entry) {
  return (entry && entry.clientId) || SHARED_CLIENT_ID;
}

// ─── YouTube fallback (only used in /stream for yt_ ids) ──────────────────
async function ytStreamUrl(videoId) {
  if (!ytdlpReady) await ensureYtdlp();
  if (!ytdlpReady) throw new Error('yt-dlp not available');
  const url = 'https://www.youtube.com/watch?v=' + videoId;
  const { stdout } = await execFileAsync(YTDLP_BIN, [
    '-f',
    'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '--print',
    'url',
    url
  ]);
  return String(stdout || '').trim();
}

// ─── Config page (token generator) ────────────────────────────────────────
function buildConfigPage(baseUrl) {
  let h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>SoundCloud Addon for Eclipse</title>';
  h += '<style>*{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#05060a;color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.card{background:#0c0f18;border:1px solid #181c2a;border-radius:18px;padding:32px;max-width:520px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.7);margin-bottom:20px}';
  h += 'h1{font-size:22px;font-weight:700;margin-bottom:8px;color:#fff}p.sub{font-size:14px;color:#9ba0b0;margin-bottom:20px;line-height:1.6}';
  h += 'button{cursor:pointer;border:none;border-radius:12px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:10px;margin-bottom:6px;transition:background .15s}';
  h += '.bo{background:#ff5500;color:#05060a}.bo:hover{background:#ff7b3a}.bo:disabled{background:#25293a;color:#5f667a;cursor:not-allowed}';
  h += '.box{display:none;background:#05060a;border:1px solid #1b2132;border-radius:12px;padding:16px;margin-top:14px}';
  h += '.blbl{font-size:10px;color:#6a7083;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}';
  h += '.burl{font-size:12px;color:#ffb88a;word-break:break-all;font-family:"SF Mono",ui-monospace,monospace;margin-bottom:12px;line-height:1.5}';
  h += '.bd{background:#141724;color:#c0c4d0;border:1px solid #25293a;font-size:13px;padding:9px}.bd:hover{background:#191d2c;color:#fff}';
  h += '.steps{display:flex;flex-direction:column;gap:10px;margin-top:12px}.step{display:flex;gap:10px;align-items:flex-start}';
  h += '.sn{background:#141724;border-radius:50%;width:22px;height:22px;min-width:22px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#8a90a8}';
  h += '.st{font-size:13px;color:#9ba0b0;line-height:1.6}.st b{color:#f5f5f7}';
  h += 'footer{margin-top:26px;font-size:12px;color:#555a6a;text-align:center;line-height:1.7}';
  h += '</style></head><body>';
  h += '<div class="card">';
  h += '<h1>SoundCloud for Eclipse</h1>';
  h += '<p class="sub">Search and play tracks from SoundCloud inside Eclipse. Each person gets their own token; no manual API keys required.</p>';
  h += '<button class="bo" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="blbl">Your addon URL — paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyBtn" onclick="copyUrl()">Copy URL</button></div>';
  h += '<div class="steps">';
  h += '<div class="step"><div class="sn">1</div><div class="st">Click <b>Generate My Addon URL</b></div></div>';
  h += '<div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> → Settings → Connections → Add Connection → Addon</div></div>';
  h += '<div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap <b>Install</b></div></div>';
  h += '</div>';
  h += '</div>';
  h += '<footer>SoundCloud Addon for Eclipse • Streams from SoundCloud (and YouTube fallback)</footer>';
  h += '<script>';
  h += 'var gu="";';
  h += 'function generate(){var btn=document.getElementById("genBtn"),gx=document.getElementById("genBox"),guEl=document.getElementById("genUrl");btn.disabled=true;btn.textContent="Generating...";fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}gu=d.manifestUrl;guEl.textContent=gu;gx.style.display="block";btn.disabled=false;btn.textContent="Regenerate URL";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});}';
  h += 'function copyUrl(){if(!gu)return;navigator.clipboard.writeText(gu).then(function(){var b=document.getElementById("copyBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
  h += '<\/script></body></html>';
  return h;
}

// ─── Routes: config + token ───────────────────────────────────────────────
app.get('/', function (req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function (req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
  const bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP)
    return res.status(429).json({ error: 'Too many tokens today from this IP.' });

  const token = generateToken();
  const entry = { clientId: null, createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;

  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

// ─── Manifest ─────────────────────────────────────────────────────────────
app.get('/u/:token/manifest.json', tokenMiddleware, function (req, res) {
  res.json({
    id: 'com.eclipse.soundcloud.' + req.params.token.slice(0, 8),
    name: 'SoundCloud',
    version: '1.0.0',
    description: 'Streams tracks from SoundCloud into Eclipse.',
    icon: 'https://upload.wikimedia.org/wikipedia/commons/2/20/SoundCloud_logo.svg',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'artist', 'playlist', 'album']
  });
});

// ─── Search (tracks + artists) ────────────────────────────────────────────
app.get('/u/:token/search', tokenMiddleware, async function (req, res) {
  const q = cleanText(req.query.q);
  const entry = req.tokenEntry;

  if (!q) {
    return res.json({
      tracks: [],
      albums: [],
      artists: [],
      playlists: []
    });
  }

  try {
    await ensureClientId();
    const cid = effectiveCid(entry);

    // Tracks
    const trackResp = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
      params: {
        q,
        client_id: cid,
        limit: 24,
        offset: 0,
        linked_partitioning: 1
      },
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      timeout: 14000
    });
    const trackData = trackResp.data || {};
    const trackItems = Array.isArray(trackData.collection) ? trackData.collection : [];

    const tracks = trackItems
      .filter(t => isFullyPlayable(t))
      .map(t => {
        rememberTrack(t);
        const meta = parseArtistTitle(t);
        const art = artworkUrl(t.artwork_url, t.user && t.user.avatar_url);
        return {
          id: 'sc_tr_' + String(t.id),
          title: meta.title,
          artist: meta.artist,
          album: meta.artist,
          duration: t.duration ? Math.round(t.duration / 1000) : null,
          artworkURL: art,
          format: 'mp3'
        };
      });

    // Artists
    const userResp = await axios.get('https://api-v2.soundcloud.com/search/users', {
      params: {
        q,
        client_id: cid,
        limit: 12,
        offset: 0,
        linked_partitioning: 1
      },
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      timeout: 14000
    });
    const userData = userResp.data || {};
    const userItems = Array.isArray(userData.collection) ? userData.collection : [];

    const artists = userItems.map(u => ({
      id: 'sc_user_' + String(u.id),
      name: cleanText(u.username || u.permalink),
      artworkURL: artworkUrl(u.avatar_url, null),
      genres: []
    }));

    res.json({
      tracks: tracks.slice(0, 30),
      albums: [],
      artists: artists.slice(0, 10),
      playlists: []
    });
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({
      error: 'Search failed',
      tracks: [],
      albums: [],
      artists: [],
      playlists: []
    });
  }
});

// ─── Stream ───────────────────────────────────────────────────────────────
app.get('/u/:token/stream/:id', tokenMiddleware, async function (req, res) {
  const id = String(req.params.id || '');
  const entry = req.tokenEntry;

  try {
    // SoundCloud track
    if (id.startsWith('sc_tr_')) {
      await ensureClientId();
      const cid = effectiveCid(entry);
      const scId = id.replace('sc_tr_', '');
      const r = await axios.get('https://api-v2.soundcloud.com/tracks/' + encodeURIComponent(scId), {
        params: { client_id: cid },
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        timeout: 12000
      });
      const t = r.data || null;
      if (!t || !isFullyPlayable(t)) return res.status(404).json({ error: 'Track not playable' });
      const trans = (t.media && t.media.transcodings && t.media.transcodings[0]) || null;
      if (!trans || !trans.url) return res.status(404).json({ error: 'No streaming URL found' });

      const ts = await axios
        .get(trans.url, {
          params: { client_id: cid },
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          timeout: 12000
        })
        .then(r2 => (r2.data && r2.data.url) || null)
        .catch(() => null);

      if (!ts) return res.status(404).json({ error: 'Transcoding failed' });
      return res.json({ url: ts, format: 'mp3' });
    }

    // YouTube track (yt_ prefix)
    if (id.startsWith('yt_')) {
      const vid = id.replace('yt_', '');
      const url = await ytStreamUrl(vid);
      return res.json({ url, format: 'mp3' });
    }

    return res.status(404).json({ error: 'Unknown track id' });
  } catch (e) {
    console.error('[stream]', e.message);
    res.status(500).json({ error: 'Stream resolution failed' });
  }
});

// ─── Artist details (topTracks + albums) ──────────────────────────────────
app.get('/u/:token/artist/:id', tokenMiddleware, async function (req, res) {
  const rawId = req.params.id;
  const entry = req.tokenEntry;

  try {
    const userId = rawId.replace(/^sc_user_/, '');
    if (!userId) return res.status(400).json({ error: 'Invalid artist id.' });

    await ensureClientId();
    const cid = effectiveCid(entry);

    // Artist profile
    const userResp = await axios.get(
      'https://api-v2.soundcloud.com/users/' + encodeURIComponent(userId),
      {
        params: { client_id: cid },
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        timeout: 12000
      }
    );
    const user = userResp.data || {};
    const artistName = cleanText(user.username || user.permalink || 'Artist');
    const artworkURL = artworkUrl(user.avatar_url, null);
    const bio = cleanText(user.description || '');
    const genres = [];

    // Artist tracks -> topTracks
    const tracksResp = await axios.get(
      'https://api-v2.soundcloud.com/users/' + encodeURIComponent(userId) + '/tracks',
      {
        params: {
          client_id: cid,
          limit: 50,
          linked_partitioning: 1
        },
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        timeout: 14000
      }
    );
    const rawTracks = Array.isArray(tracksResp.data)
      ? tracksResp.data
      : (tracksResp.data && tracksResp.data.collection) || [];

    const scored = rawTracks
      .filter(t => isFullyPlayable(t) && t.kind === 'track')
      .map(t => {
        rememberTrack(t);
        const plays = Number(t.playback_count || 0);
        const likes = Number(t.likes_count || t.favoritings_count || 0);
        const reposts = Number(t.reposts_count || 0);
        const score = plays + likes * 3 + reposts * 5;

        const meta = parseArtistTitle(t);
        const art = artworkUrl(t.artwork_url, user.avatar_url);

        return {
          _score: score,
          id: 'sc_tr_' + String(t.id),
          title: meta.title,
          artist: meta.artist || artistName,
          duration: t.duration ? Math.round(t.duration / 1000) : null,
          artworkURL: art,
          streamURL: null,
          format: 'mp3'
        };
      })
      .sort((a, b) => (b._score || 0) - (a._score || 0));

    const topTracks = scored.slice(0, 12).map(t => {
      const { _score, ...rest } = t;
      return rest;
    });

    // Albums from playlists
    let albums = [];
    try {
      const setsResp = await axios.get(
        'https://api-v2.soundcloud.com/users/' + encodeURIComponent(userId) + '/playlists',
        {
          params: {
            client_id: cid,
            limit: 20,
            linked_partitioning: 1
          },
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          timeout: 14000
        }
      );
      const sets = Array.isArray(setsResp.data)
        ? setsResp.data
        : (setsResp.data && setsResp.data.collection) || [];
      albums = sets.map(pl => {
        const art = artworkUrl(pl.artwork_url, user.avatar_url);
        return {
          id: 'sc_pl_' + String(pl.id),
          title: cleanText(pl.title || 'Playlist'),
          artist: artistName,
          artworkURL: art,
          trackCount: Array.isArray(pl.tracks) ? pl.tracks.length : null,
          year: scYear(pl)
        };
      });
    } catch (e) {
      console.warn('[artist playlists]', e.message);
    }

    res.json({
      id: rawId,
      name: artistName,
      artworkURL,
      bio: bio || null,
      genres,
      topTracks,
      albums
    });
  } catch (e) {
    console.error('[artist]', e.message);
    res.status(500).json({ error: 'Artist fetch failed.' });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────
app.get('/health', function (req, res) {
  res.json({
    status: 'ok',
    version: '1.0.0',
    redisConnected: !!(redis && redis.status === 'ready'),
    activeTokens: TOKEN_CACHE.size,
    cachedTracks: TRACK_CACHE.size,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log('SoundCloud Addon listening on port ' + PORT);
});
