const express      = require('express');
const cors         = require('cors');
const axios        = require('axios');
const crypto       = require('crypto');
const Redis        = require('ioredis');
const ytpl         = require('ytpl');
const fs           = require('fs');
const { exec, execFile } = require('child_process');
const { promisify }      = require('util');

const execAsync     = promisify(exec);
const execFileAsync = promisify(execFile);

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── yt-dlp binary (auto-downloads at startup into /tmp) ─────────────────
// yt-dlp is the only reliable YouTube audio extractor as of 2026.
// ytdl-core and Piped are both broken by YouTube bot detection.
// The binary is ~12MB and downloads once per container cold start.
const YTDLP_BIN  = '/tmp/yt-dlp';
let   ytdlpReady = false;

async function ensureYtdlp() {
  try {
    if (fs.existsSync(YTDLP_BIN)) fs.unlinkSync(YTDLP_BIN); // refresh on each cold start
    console.log('[yt-dlp] downloading binary...');
    await execAsync(
      'curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ' +
      YTDLP_BIN + ' && chmod +x ' + YTDLP_BIN,
      { timeout: 60000 }
    );
    ytdlpReady = true;
    console.log('[yt-dlp] ready at ' + YTDLP_BIN);
  } catch (e) {
    console.error('[yt-dlp] install failed: ' + e.message);
    ytdlpReady = false;
  }
}

ensureYtdlp(); // runs on server start, non-blocking

// ─── Redis ────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', function () { console.log('[Redis] Connected'); });
  redis.on('error',   function (e) { console.error('[Redis] Error: ' + e.message); });
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set('sc:token:' + token, JSON.stringify({
      clientId: entry.clientId, createdAt: entry.createdAt,
      lastUsed: entry.lastUsed, reqCount: entry.reqCount
    }));
  } catch (e) { console.error('[Redis] Save failed: ' + e.message); }
}

async function redisLoad(token) {
  if (!redis) return null;
  try { var d = await redis.get('sc:token:' + token); return d ? JSON.parse(d) : null; }
  catch (e) { return null; }
}

// ─── Token store ──────────────────────────────────────────────────────────
const TOKEN_CACHE       = new Map();
const IP_CREATES        = new Map();
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX          = 60;
const RATE_WINDOW_MS    = 60000;

function generateToken() { return crypto.randomBytes(14).toString('hex'); }

function getOrCreateIpBucket(ip) {
  var now = Date.now(), b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 86400000 }; IP_CREATES.set(ip, b); }
  return b;
}

async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  var saved = await redisLoad(token);
  if (!saved) return null;
  var entry = { clientId: saved.clientId, createdAt: saved.createdAt, lastUsed: saved.lastUsed, reqCount: saved.reqCount, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  return entry;
}

function checkRateLimit(entry) {
  var now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now); entry.lastUsed = now; entry.reqCount = (entry.reqCount || 0) + 1;
  return true;
}

async function tokenMiddleware(req, res, next) {
  var entry = await getTokenEntry(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Invalid token.' });
  if (!checkRateLimit(entry)) return res.status(429).json({ error: 'Rate limit exceeded.' });
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(req.params.token, entry);
  next();
}

function getBaseUrl(req) { return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'); }
function effectiveCid(e) { return (e && e.clientId) ? e.clientId : SHARED_CLIENT_ID; }

// ─── SoundCloud client_id ─────────────────────────────────────────────────
var SHARED_CLIENT_ID = null;
const TRACK_CACHE    = new Map();
const sleep = function (ms) { return new Promise(function (r) { return setTimeout(r, ms); }); };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ID_PATTERNS = [
  /client_id\s*[=:,]\s*["']([a-zA-Z0-9]{32})["']/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /client_id=([a-zA-Z0-9]{32})[&"'\s,)]/
];

function findId(text) {
  for (var i = 0; i < ID_PATTERNS.length; i++) { var m = text.match(ID_PATTERNS[i]); if (m) return m[1]; }
  return null;
}

function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function parseArtistTitle(track) {
  var raw  = cleanText(track && track.title);
  var meta = cleanText((track && track.publisher_metadata && (track.publisher_metadata.artist || track.publisher_metadata.writer_composer)) || '');
  var up   = cleanText(track && track.user && track.user.username);
  if (raw.indexOf(' - ') !== -1) {
    var parts = raw.split(' - '), L = cleanText(parts[0]), R = cleanText(parts.slice(1).join(' - '));
    if (L && R) return { artist: meta || L, title: R, rawTitle: raw, uploader: up };
  }
  return { artist: meta || up, title: raw, rawTitle: raw, uploader: up };
}

function rememberTrack(t) {
  if (!t || !t.id) return;
  var m = parseArtistTitle(t);
  TRACK_CACHE.set(String(t.id), { id: String(t.id), artist: m.artist, title: m.title, rawTitle: m.rawTitle, uploader: m.uploader });
}

function artworkUrl(raw, fb) { var s = raw || fb || ''; return s ? s.replace('-large', '-t500x500') : null; }
function scYear(x) { return (x.release_date || x.created_at || '').slice(0, 4) || null; }

// SNIP  = SoundCloud 30-second preview. BLOCK = region-blocked. Neither is playable in full.
// policy can also be absent (null/undefined) on some tracks returned from playlists —
// treat those as SNIP too since we can't confirm they're fully playable.
function isFullyPlayable(t) {
  if (!t) return false;
  if (t.streamable === false) return false;
  var p = t.policy;
  if (!p || p === 'SNIP' || p === 'BLOCK') return false;
  return true; // ALLOW or MONETIZE
}

async function getHtml(url) {
  try {
    var r = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Encoding': 'gzip, deflate' },
      timeout: 15000, decompress: true, responseType: 'text',
      validateStatus: function (s) { return s < 500; }
    });
    return r.data || '';
  } catch (e) { return null; }
}

async function getJs(url) {
  try {
    var r = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://soundcloud.com/' },
      timeout: 12000, decompress: true, responseType: 'text',
      validateStatus: function (s) { return s < 500; }
    });
    if (r.status !== 200 || (r.data || '').length < 5000) return null;
    return r.data;
  } catch (e) { return null; }
}

async function tryExtract() {
  for (var pu of ['https://soundcloud.com', 'https://soundcloud.com/discover']) {
    var html = await getHtml(pu);
    if (!html || html.length < 5000) continue;
    for (var m of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) {
      var id = findId(m[1]); if (id) return id;
    }
    var urls = Array.from(new Set([
      ...Array.from(html.matchAll(/https?:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9._-]+\.js/g)).map(function (x) { return x[0]; }),
      ...Array.from(html.matchAll(/src=["'](https?:\/\/[^"']*(?:sndcdn|soundcloud)[^"']*\.js[^"']*)["']/g)).map(function (x) { return x[1]; })
    ])).reverse().slice(0, 10);
    for (var u of urls) {
      var js = await getJs(u); if (!js) continue;
      var bid = findId(js); if (bid) return bid;
    }
  }
  return null;
}

async function fetchSharedClientId() {
  if (process.env.SC_CLIENT_ID) { SHARED_CLIENT_ID = process.env.SC_CLIENT_ID; console.log('client_id from env'); return; }
  var delays = [5000, 10000, 15000, 30000, 60000], attempt = 0;
  while (true) {
    attempt++;
    try {
      var id = await tryExtract();
      if (!id) throw new Error('not found');
      SHARED_CLIENT_ID = id;
      console.log('client_id obtained attempt ' + attempt);
      setTimeout(function () { SHARED_CLIENT_ID = null; fetchSharedClientId(); }, 6 * 60 * 60 * 1000);
      return;
    } catch (e) {
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
    }
  }
}

fetchSharedClientId();

async function scGet(cid, url, params, retried) {
  if (!cid) throw new Error('No client_id');
  try {
    var r = await axios.get(url, {
      params: Object.assign({}, params || {}, { client_id: cid }),
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      timeout: 12000, decompress: true
    });
    return r.data;
  } catch (e) {
    if (!retried && e.response && (e.response.status === 401 || e.response.status === 403)) {
      SHARED_CLIENT_ID = null; fetchSharedClientId(); await sleep(3000);
      return scGet(SHARED_CLIENT_ID, url, params, true);
    }
    throw e;
  }
}

async function resolveStubs(cid, tracks, fbArt) {
  var stubs = tracks.filter(function (t) { return !t.title; }).map(function (t) { return t.id; });
  var map = {};
  for (var i = 0; i < stubs.length; i += 50) {
    try {
      var data = await scGet(cid, 'https://api-v2.soundcloud.com/tracks', { ids: stubs.slice(i, i + 50).join(',') });
      var arr = Array.isArray(data) ? data : ((data && data.collection) || []);
      arr.forEach(function (t) { map[String(t.id)] = t; });
    } catch (e) { console.warn('[resolveStubs] failed: ' + e.message); }
  }
  return tracks.map(function (t) { return map[String(t.id)] || t; }).filter(function (t) { return !!t.title; });
}

// ─── yt-dlp helpers ───────────────────────────────────────────────────────
// Uses android_music player client which returns direct M4A URLs without
// needing JavaScript signature decryption. Works even without a JS runtime.

async function ytdlpRun(args) {
  // Re-download binary if /tmp was flushed
  if (!fs.existsSync(YTDLP_BIN)) {
    await ensureYtdlp();
    if (!ytdlpReady) return null;
  }
  try {
    var { stdout } = await execFileAsync(YTDLP_BIN, args, { timeout: 30000 });
    return (stdout || '').trim();
  } catch (e) {
    console.warn('[yt-dlp] ' + e.message.slice(0, 150));
    return null;
  }
}

function parseYtdlpUrl(stdout) {
  if (!stdout) return null;
  var lines = stdout.split('\n').filter(function (l) { return l.startsWith('http'); });
  return lines[0] || null;
}

function detectFmt(url) {
  if (!url) return 'm4a';
  return (url.indexOf('mime=audio%2Fmp4') !== -1 || url.indexOf('mime=audio/mp4') !== -1) ? 'm4a' : 'webm';
}

// Get a direct audio stream URL for a YouTube video ID
async function ytdlpStreamById(videoId) {
  var out = await ytdlpRun([
    '--get-url',
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
    '--no-playlist', '--no-warnings',
    '--extractor-args', 'youtube:player_client=android_music,android',
    'https://www.youtube.com/watch?v=' + videoId
  ]);
  var url = parseYtdlpUrl(out);
  if (!url) return null;
  return { url: url, format: detectFmt(url), quality: '128kbps', expiresAt: Math.floor(Date.now() / 1000) + 21600 };
}

// Search YouTube and get a direct audio URL in one yt-dlp call
async function ytdlpSearch(query) {
  var out = await ytdlpRun([
    '--get-url',
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
    '--no-playlist', '--no-warnings',
    '--extractor-args', 'youtube:player_client=android_music,android',
    'ytsearch1:' + query
  ]);
  var url = parseYtdlpUrl(out);
  if (!url) return null;
  return { url: url, format: detectFmt(url), quality: '128kbps', expiresAt: Math.floor(Date.now() / 1000) + 21600 };
}

async function ytFallback(title, artist) {
  var queries = [];
  if (artist) queries.push(artist + ' - ' + title);
  queries.push(title);
  if (artist) queries.push(artist + ' ' + title + ' audio');
  for (var q of queries) {
    var r = await ytdlpSearch(q);
    if (r) return r;
  }
  return null;
}

// ─── YTM playlist import ──────────────────────────────────────────────────
async function importYtmPlaylist(playlistId) {
  var cleanId = playlistId.replace(/^VL/, '');
  try {
    var pl = await ytpl(cleanId, { limit: Infinity });
    return {
      id:         'ytm_' + cleanId,
      title:      pl.title || 'YouTube Music Playlist',
      artworkURL: (pl.bestThumbnail && pl.bestThumbnail.url) || null,
      creator:    (pl.author && pl.author.name) || 'YouTube Music',
      tracks:     (pl.items || []).map(function (item) {
        return {
          id:         'ytm_' + item.id,
          title:      item.title || 'Unknown',
          artist:     (item.author && item.author.name) || 'Unknown',
          duration:   item.durationSec || null,
          artworkURL: (item.bestThumbnail && item.bestThumbnail.url) || null
        };
      })
    };
  } catch (e) {
    throw new Error('Could not fetch YouTube playlist: ' + e.message + '. Make sure it is Public.');
  }
}

// ─── SC short URL expander ───────────────────────────────────────────────
// on.soundcloud.com/XXXX and snd.sc/XXXX are redirect short links.
// The SC /resolve API does NOT accept them — we must follow the redirect first
// to get the canonical soundcloud.com URL before calling the API.
async function expandScShortUrl(url) {
  try {
    var r = await axios.get(url, {
      maxRedirects: 10,
      headers: { 'User-Agent': UA },
      timeout: 10000,
      validateStatus: function (s) { return s < 500; }
    });
    // axios stores the final URL after redirects here:
    var final = (r.request && r.request.res && r.request.res.responseUrl) || url;
    console.log('[expandScShortUrl] ' + url + ' -> ' + final);
    return final;
  } catch (e) {
    if (e.response && e.response.headers && e.response.headers.location) {
      return e.response.headers.location;
    }
    return url;
  }
}

// ─── SC playlist import ───────────────────────────────────────────────────
async function importScPlaylist(cid, scUrl) {
  // Expand on.soundcloud.com / snd.sc short links to full soundcloud.com URLs
  if (/on\.soundcloud\.com\//.test(scUrl) || /snd\.sc\//.test(scUrl)) {
    scUrl = await expandScShortUrl(scUrl);
  }
  var res = await scGet(cid, 'https://api-v2.soundcloud.com/resolve', { url: scUrl });
  if (!res) throw new Error('Could not resolve SoundCloud URL');
  if (res.kind !== 'playlist') throw new Error('Not a playlist (kind: ' + res.kind + ')');
  var resolved = await resolveStubs(cid, res.tracks || [], res.artwork_url);
  return {
    id: String(res.id), title: res.title || 'Imported', artworkURL: artworkUrl(res.artwork_url),
    creator: (res.user && res.user.username) || null,
    tracks: resolved.map(function (t) {
      rememberTrack(t); var m = parseArtistTitle(t);
      return {
        id: String(t.id), title: m.title || t.title || 'Unknown',
        artist: m.artist || (res.user && res.user.username) || 'Unknown',
        duration: t.duration ? Math.floor(t.duration / 1000) : null,
        artworkURL: artworkUrl(t.artwork_url, res.artwork_url)
      };
    })
  };
}

// ─── URL helpers ──────────────────────────────────────────────────────────
function detectUrlType(url) {
  if (!url) return null;
  if (/soundcloud\.com\/.+\/sets\/.+/.test(url))           return 'sc_playlist';
  if (/on\.soundcloud\.com\/.+/.test(url))                  return 'sc_playlist'; // short links
  if (/snd\.sc\/.+/.test(url))                               return 'sc_playlist'; // snd.sc short links
  if (/(?:music\.youtube\.com|youtube\.com).*[?&]list=/.test(url)) return 'ytm_playlist';
  if (/music\.youtube\.com\/browse\/VL/.test(url))         return 'ytm_playlist';
  return null;
}

function extractYtmId(url) {
  var browse = url.match(/\/browse\/VL([a-zA-Z0-9_-]+)/);
  if (browse) return browse[1];
  var m = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ─── Config page ──────────────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
  var h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>Eclipse - SoundCloud Addon</title>';
  h += '<style>';
  h += '*{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#0f0f0f;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.logo{margin-bottom:20px}';
  h += '.card{background:#161616;border:1px solid #232323;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5);margin-bottom:20px}';
  h += 'h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}';
  h += 'p.sub{font-size:14px;color:#777;margin-bottom:20px;line-height:1.6}';
  h += '.tip{background:#0d1f0d;border:1px solid #1a3a1a;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#5a9e5a;line-height:1.7}.tip b{color:#7cc97c}';
  h += '.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}';
  h += '.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#1a2218;color:#6db86d;border:1px solid #2d422a}';
  h += '.pill.o{background:#1f1500;color:#f50;border-color:#3a2500}.pill.b{background:#001a2e;color:#4a9eff;border-color:#003a6e}';
  h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:8px;margin-top:16px}';
  h += 'input{width:100%;background:#0f0f0f;border:1px solid #222;border-radius:10px;color:#e8e8e8;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}';
  h += 'input:focus{border-color:#f50}input::placeholder{color:#333}';
  h += '.hint{font-size:12px;color:#484848;margin-bottom:12px;line-height:1.7}.hint a{color:#f50;text-decoration:none}.hint code{background:#1a1a1a;padding:1px 5px;border-radius:4px;color:#888}';
  h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}';
  h += '.bo{background:#f50;color:#fff}.bo:hover{background:#d94a00}.bo:disabled{background:#252525;color:#444;cursor:not-allowed}';
  h += '.bg{background:#1a4a20;color:#e8e8e8;border:1px solid #2a6a30}.bg:hover{background:#245c2a}.bg:disabled{background:#252525;color:#444;cursor:not-allowed}';
  h += '.bd{background:#1a1a1a;color:#aaa;border:1px solid #222;font-size:13px;padding:10px}.bd:hover{background:#222;color:#fff}';
  h += '.box{display:none;background:#0f0f0f;border:1px solid #1e1e1e;border-radius:12px;padding:18px;margin-bottom:14px}';
  h += '.blbl{font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}';
  h += '.burl{font-size:12px;color:#f50;word-break:break-all;font-family:"SF Mono",monospace;margin-bottom:14px;line-height:1.5}';
  h += 'hr{border:none;border-top:1px solid #1a1a1a;margin:24px 0}';
  h += '.steps{display:flex;flex-direction:column;gap:12px}.step{display:flex;gap:12px;align-items:flex-start}';
  h += '.sn{background:#1a1a1a;border:1px solid #252525;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#666}';
  h += '.st{font-size:13px;color:#666;line-height:1.6}.st b{color:#aaa}';
  h += '.warn{background:#140f00;border:1px solid #2e2000;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#8a6a00;line-height:1.7}';
  h += '.badge{display:inline-block;background:#001a2e;color:#4a9eff;border:1px solid #003a6e;border-radius:20px;font-size:11px;font-weight:600;padding:3px 10px;margin-bottom:14px}';
  h += '.status{font-size:13px;color:#666;margin:8px 0;min-height:18px}.status.ok{color:#5a9e5a}.status.err{color:#c0392b}';
  h += '.preview{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:10px;padding:12px;max-height:200px;overflow-y:auto;margin-bottom:12px;display:none}';
  h += '.tr{display:flex;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid #181818;font-size:13px}.tr:last-child{border-bottom:none}';
  h += '.tn{color:#444;font-size:11px;min-width:22px;text-align:right}.ti{flex:1;min-width:0}';
  h += '.tt{color:#e8e8e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ta{color:#666;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
  h += 'footer{margin-top:32px;font-size:12px;color:#333;text-align:center;line-height:1.8}';
  h += '</style></head><body>';

  h += '<svg class="logo" width="52" height="52" viewBox="0 0 52 52" fill="none">';
  h += '<circle cx="26" cy="26" r="26" fill="#f50"/>';
  h += '<path d="M15 30c0-2.4 2-4.4 4.4-4.4s4.4 2 4.4 4.4" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>';
  h += '<path d="M10.5 30c0-4.9 4-8.9 8.9-8.9s8.9 4 8.9 8.9" stroke="#fff" stroke-width="2.5" stroke-linecap="round" opacity=".55"/>';
  h += '<rect x="30" y="21" width="3.5" height="17" rx="1.75" fill="#fff"/>';
  h += '<rect x="35.5" y="18" width="3.5" height="20" rx="1.75" fill="#fff"/>';
  h += '<rect x="41" y="23" width="3.5" height="15" rx="1.75" fill="#fff"/>';
  h += '</svg>';

  h += '<div class="card">';
  h += '<h1>SoundCloud for Eclipse</h1>';
  h += '<div class="tip"><b>Save your URL</b> — copy it to Notes or a bookmark. If the server restarts, paste it below to keep all playlists working.</div>';
  h += '<p class="sub">SNIP (30-second preview) tracks are filtered from all search and album results. YouTube fallback via yt-dlp.</p>';
  h += '<div class="pills"><span class="pill">Tracks, albums, artists</span><span class="pill">SC playlists</span><span class="pill o">yt-dlp fallback</span><span class="pill b">YTM import</span><span class="pill b">Offline download</span></div>';
  h += '<div class="lbl">SoundCloud Client ID <span style="color:#3a3a3a;font-weight:400;text-transform:none">(optional)</span></div>';
  h += '<input type="text" id="clientId" placeholder="Leave blank to use the shared auto-refreshed ID">';
  h += '<div class="hint">Want your own? Open <a href="https://soundcloud.com" target="_blank">soundcloud.com</a>, press F12 > Network > filter <code>api-v2</code> > copy <code>client_id=</code>.</div>';
  h += '<button class="bo" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="blbl">Your addon URL — paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyGenBtn" onclick="copyGen()">Copy URL</button></div>';
  h += '<hr><div class="lbl">Refresh existing URL</div>';
  h += '<input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">';
  h += '<div class="hint">Same URL, same playlists — nothing breaks.</div>';
  h += '<button class="bg" id="refBtn" onclick="doRefresh()">Refresh Existing URL</button>';
  h += '<div class="box" id="refBox"><div class="blbl">Refreshed — same URL, still works in Eclipse</div><div class="burl" id="refUrl"></div><button class="bd" id="copyRefBtn" onclick="copyRef()">Copy URL</button></div>';
  h += '<hr><div class="steps">';
  h += '<div class="step"><div class="sn">1</div><div class="st">Generate and copy your URL above</div></div>';
  h += '<div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> → Settings → Connections → Add Connection → Addon</div></div>';
  h += '<div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap Install</div></div>';
  h += '<div class="step"><div class="sn">4</div><div class="st">Use <b>Playlist Importer</b> below for CSV import into Eclipse Library</div></div>';
  h += '</div>';
  h += '<div class="warn">Your URL is saved to Redis and survives restarts. Never reinstall the addon after updates. YTM playlists must be Public.</div>';
  h += '</div>';

  h += '<div class="card">';
  h += '<span class="badge">Playlist Importer</span>';
  h += '<h2>Import SoundCloud or YouTube Music Playlist</h2>';
  h += '<p class="sub">Downloads a CSV you can import in Eclipse via Library → Import → CSV.</p>';
  h += '<div class="lbl">Your Addon URL</div>';
  h += '<input type="text" id="impToken" placeholder="Paste your addon URL (auto-fills after generating)">';
  h += '<div class="lbl">Playlist URL</div>';
  h += '<input type="text" id="impUrl" placeholder="soundcloud.com/artist/sets/name  or  on.soundcloud.com/XXXX  or  music.youtube.com/playlist?list=...">';
  h += '<div class="hint">SoundCloud: soundcloud.com/*/sets/* or on.soundcloud.com/... &nbsp;|&nbsp; YouTube Music: music.youtube.com/playlist?list=...</div>';
  h += '<div class="status" id="impStatus"></div><div class="preview" id="impPreview"></div>';
  h += '<button class="bg" id="impBtn" onclick="doImport()">Fetch &amp; Download CSV</button>';
  h += '</div>';
  h += '<footer>Eclipse SoundCloud Addon v3.8.0 &bull; <a href="' + baseUrl + '/health" target="_blank" style="color:#333;text-decoration:none">' + baseUrl + '</a></footer>';

  h += '<script>';
  h += 'var _gu="",_ru="";';
  h += 'function generate(){var btn=document.getElementById("genBtn"),cid=document.getElementById("clientId").value.trim();btn.disabled=true;btn.textContent="Generating...";fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId:cid||null})}).then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}_gu=d.manifestUrl;document.getElementById("genUrl").textContent=_gu;document.getElementById("genBox").style.display="block";document.getElementById("impToken").value=_gu;btn.disabled=false;btn.textContent="Regenerate URL";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});}';
  h += 'function copyGen(){if(!_gu)return;navigator.clipboard.writeText(_gu).then(function(){var b=document.getElementById("copyGenBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
  h += 'function doRefresh(){var btn=document.getElementById("refBtn"),eu=document.getElementById("existingUrl").value.trim(),cid=document.getElementById("clientId").value.trim();if(!eu){alert("Paste your existing addon URL first.");return;}btn.disabled=true;btn.textContent="Refreshing...";fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu,clientId:cid||null})}).then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Refresh Existing URL";return;}_ru=d.manifestUrl;document.getElementById("refUrl").textContent=_ru;document.getElementById("refBox").style.display="block";document.getElementById("impToken").value=_ru;btn.disabled=false;btn.textContent="Refresh Again";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Refresh Existing URL";});}';
  h += 'function copyRef(){if(!_ru)return;navigator.clipboard.writeText(_ru).then(function(){var b=document.getElementById("copyRefBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
  h += 'function getTok(s){var m=s.match(/\\/u\\/([a-f0-9]{28})\\//);return m?m[1]:null;}';
  h += 'function hesc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}';
  h += 'function doImport(){var btn=document.getElementById("impBtn"),raw=document.getElementById("impToken").value.trim(),purl=document.getElementById("impUrl").value.trim(),st=document.getElementById("impStatus"),pv=document.getElementById("impPreview");if(!raw){st.className="status err";st.textContent="Paste your addon URL first.";return;}if(!purl){st.className="status err";st.textContent="Paste a playlist URL.";return;}var tok=getTok(raw);if(!tok){st.className="status err";st.textContent="Could not find your token in the URL.";return;}btn.disabled=true;btn.textContent="Fetching...";st.className="status";st.textContent="Fetching tracks...";pv.style.display="none";fetch("/u/"+tok+"/import?url="+encodeURIComponent(purl)).then(function(r){if(!r.ok)return r.json().then(function(e){throw new Error(e.error||"Server error "+r.status);});return r.json();}).then(function(data){var tracks=data.tracks||[];if(!tracks.length)throw new Error("No tracks found.");var rows=tracks.slice(0,50).map(function(t,i){return\'<div class="tr"><span class="tn">\'+(i+1)+\'</span><div class="ti"><div class="tt">\'+hesc(t.title)+\'</div><div class="ta">\'+hesc(t.artist)+\'</div></div></div>\';}).join("");if(tracks.length>50)rows+=\'<div class="tr" style="text-align:center;color:#555">+\'+(tracks.length-50)+\' more</div>\';pv.innerHTML=rows;pv.style.display="block";st.className="status ok";st.textContent="Found "+tracks.length+" tracks in \\""+data.title+"\\"";var lines=["Title,Artist,Album,Duration"];tracks.forEach(function(t){function ce(s){s=String(s||"");if(s.indexOf(",")!==-1||s.indexOf("\\"")!==-1){s=\'"\'+s.replace(/"/g,\'""\')+\'"\'}return s;}lines.push(ce(t.title)+","+ce(t.artist)+","+ce(data.title||"")+","+ce(t.duration||""));});var blob=new Blob([lines.join("\\n")],{type:"text/csv"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(data.title||"playlist").replace(/[^a-zA-Z0-9 _-]/g,"").trim()+".csv";document.body.appendChild(a);a.click();document.body.removeChild(a);btn.disabled=false;btn.textContent="Fetch & Download CSV";}).catch(function(e){st.className="status err";st.textContent=e.message;btn.disabled=false;btn.textContent="Fetch & Download CSV";});}';
  h += '<\/script></body></html>';
  return h;
}

// ─── Routes ───────────────────────────────────────────────────────────────
app.get('/', function (req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function (req, res) {
  var ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  var bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) return res.status(429).json({ error: 'Too many tokens today from this IP.' });
  var cid = (req.body && req.body.clientId) ? String(req.body.clientId).trim() : null;
  if (cid && !/^[a-zA-Z0-9]{20,40}$/.test(cid)) return res.status(400).json({ error: 'Invalid client_id.' });
  var token = generateToken();
  var entry = { clientId: cid || null, createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  res.json({ token: token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.post('/refresh', async function (req, res) {
  var raw = (req.body && req.body.existingUrl) ? String(req.body.existingUrl).trim() : '';
  var cid = (req.body && req.body.clientId)    ? String(req.body.clientId).trim()    : null;
  var token = raw, m = raw.match(/\/u\/([a-f0-9]{28})\//);
  if (m) token = m[1];
  if (!token || !/^[a-f0-9]{28}$/.test(token)) return res.status(400).json({ error: 'Paste your full addon URL.' });
  var entry = await getTokenEntry(token);
  if (!entry) return res.status(404).json({ error: 'URL not found. Generate a new one.' });
  if (cid) {
    if (!/^[a-zA-Z0-9]{20,40}$/.test(cid)) return res.status(400).json({ error: 'Invalid client_id.' });
    entry.clientId = cid; TOKEN_CACHE.set(token, entry); await redisSave(token, entry);
  }
  res.json({ token: token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json', refreshed: true });
});

app.get('/u/:token/manifest.json', tokenMiddleware, function (req, res) {
  res.json({
    id:          'com.eclipse.soundcloud.' + req.params.token.slice(0, 8),
    name:        'SoundCloud',
    version:     '3.8.0',
    description: 'SoundCloud + yt-dlp fallback. SNIP previews filtered. Full tracks only.',
    icon:        'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-orange-2xhdpi-a9dce059.png',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist']
  });
});

app.get('/u/:token/search', tokenMiddleware, async function (req, res) {
  var q = cleanText(req.query.q || '');
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  var cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id yet. Retry in a few seconds.', tracks: [] });
  try {
    var results = await Promise.all([
      scGet(cid, 'https://api-v2.soundcloud.com/search/tracks',    { q: q, limit: 20, offset: 0, linked_partitioning: 1 }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/playlists', { q: q, limit: 10, offset: 0 }).catch(function () { return null; }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/users',     { q: q, limit: 5,  offset: 0 }).catch(function () { return null; })
    ]);
    var allPl = (results[1] && results[1].collection) || [];
    res.json({
      tracks: ((results[0] && results[0].collection) || [])
        .filter(isFullyPlayable)
        .map(function (t) {
          rememberTrack(t);
          var m = parseArtistTitle(t);
          return {
            id: String(t.id), title: m.title || 'Unknown', artist: m.artist || 'Unknown',
            album: null, duration: t.duration ? Math.floor(t.duration / 1000) : null,
            artworkURL: artworkUrl(t.artwork_url), format: 'aac'
          };
        }),
      albums:    allPl.filter(function (p) { return  p.is_album; }).map(function (p) { return { id: String(p.id), title: p.title || 'Unknown', artist: (p.user && p.user.username) || 'Unknown', artworkURL: artworkUrl(p.artwork_url), trackCount: p.track_count || null, year: scYear(p) }; }),
      playlists: allPl.filter(function (p) { return !p.is_album; }).map(function (p) { return { id: String(p.id), title: p.title || 'Unknown', description: p.description || null, artworkURL: artworkUrl(p.artwork_url), creator: (p.user && p.user.username) || null, trackCount: p.track_count || null }; }),
      artists:   ((results[2] && results[2].collection) || []).map(function (u) { return { id: String(u.id), name: u.username || 'Unknown', artworkURL: artworkUrl(u.avatar_url), genres: u.genre ? [u.genre] : [] }; })
    });
  } catch (e) { res.status(500).json({ error: 'Search failed', tracks: [] }); }
});

app.get('/u/:token/stream/:id', tokenMiddleware, async function (req, res) {
  var cid = effectiveCid(req.tokenEntry), tid = req.params.id;

  // YTM track — stream via yt-dlp directly
  if (tid.indexOf('ytm_') === 0) {
    var ys = await ytdlpStreamById(tid.replace('ytm_', ''));
    return ys ? res.json(ys) : res.status(404).json({ error: 'Could not stream YTM track.' });
  }

  if (!cid) return res.status(503).json({ error: 'No client_id available.' });

  var track = null, cached = TRACK_CACHE.get(String(tid)) || null;
  try {
    try { track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/soundcloud:tracks:' + tid); }
    catch (e) { track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/' + tid); }
  } catch (e) { console.warn('[stream] track lookup failed'); }

  if (track) { rememberTrack(track); cached = TRACK_CACHE.get(String(tid)) || cached; }

  // Only attempt SC progressive stream for fully playable tracks.
  // SNIP/BLOCK/unknown policy all skip straight to yt-dlp.
  if (track && isFullyPlayable(track)) {
    try {
      var tc = (track.media && track.media.transcodings) || [];
      var prog = tc.find(function (t) { return t.format && t.format.protocol === 'progressive'; });
      if (prog && prog.url) {
        var sd = await scGet(cid, prog.url);
        if (sd && sd.url) {
          var fmt = (prog.format && prog.format.mime_type && prog.format.mime_type.indexOf('aac') !== -1) ? 'aac' : 'mp3';
          return res.json({ url: sd.url, format: fmt, quality: '160kbps', expiresAt: Math.floor(Date.now() / 1000) + 86400 });
        }
      }
    } catch (e) { console.warn('[stream] sc progressive failed'); }
  }

  // yt-dlp fallback — most reliable YouTube extractor as of 2026
  var meta = track ? parseArtistTitle(track) : cached;
  if (!meta || !meta.title) return res.status(404).json({ error: 'No stream and no metadata for fallback.' });
  var yt = await ytFallback(meta.title, meta.artist || meta.uploader || '');
  if (yt) return res.json(yt);
  return res.status(404).json({ error: 'No stream found for: ' + meta.title });
});

app.get('/u/:token/album/:id', tokenMiddleware, async function (req, res) {
  var cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id.' });
  try {
    var pl = await scGet(cid, 'https://api-v2.soundcloud.com/playlists/' + req.params.id);
    if (!pl) return res.status(404).json({ error: 'Album not found.' });
    var resolved = await resolveStubs(cid, pl.tracks || [], pl.artwork_url);
    res.json({
      id: String(pl.id), title: pl.title || 'Unknown', artist: (pl.user && pl.user.username) || 'Unknown',
      artworkURL: artworkUrl(pl.artwork_url), year: scYear(pl), description: pl.description || null,
      trackCount: pl.track_count || resolved.length,
      tracks: resolved.filter(isFullyPlayable).map(function (t) {
        rememberTrack(t); var m = parseArtistTitle(t);
        return { id: String(t.id), title: m.title || t.title || 'Unknown', artist: m.artist || (pl.user && pl.user.username) || 'Unknown', duration: t.duration ? Math.floor(t.duration / 1000) : null, artworkURL: artworkUrl(t.artwork_url, pl.artwork_url) };
      })
    });
  } catch (e) { res.status(500).json({ error: 'Album fetch failed.' }); }
});

app.get('/u/:token/artist/:id', tokenMiddleware, async function (req, res) {
  var cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id.' });
  try {
    var results = await Promise.all([
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id),
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id + '/tracks',    { limit: 10, linked_partitioning: 1 }).catch(function () { return null; }),
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id + '/playlists', { limit: 20, linked_partitioning: 1 }).catch(function () { return null; })
    ]);
    var user = results[0];
    if (!user) return res.status(404).json({ error: 'Artist not found.' });
    var resolved = await resolveStubs(cid, (results[1] && results[1].collection) || [], null);
    res.json({
      id: String(user.id), name: user.username || 'Unknown', artworkURL: artworkUrl(user.avatar_url),
      bio: user.description || null, genres: user.genre ? [user.genre] : [],
      topTracks: resolved.filter(isFullyPlayable).map(function (t) {
        rememberTrack(t); var m = parseArtistTitle(t);
        return { id: String(t.id), title: m.title || t.title || 'Unknown', artist: m.artist || user.username || 'Unknown', duration: t.duration ? Math.floor(t.duration / 1000) : null, artworkURL: artworkUrl(t.artwork_url) };
      }),
      albums: ((results[2] && results[2].collection) || []).filter(function (p) { return p.is_album === true; }).map(function (p) {
        return { id: String(p.id), title: p.title || 'Unknown', artist: user.username || 'Unknown', artworkURL: artworkUrl(p.artwork_url), trackCount: p.track_count || null, year: scYear(p) };
      })
    });
  } catch (e) { console.error('[artist] ' + e.message); res.status(500).json({ error: 'Artist fetch failed.' }); }
});

app.get('/u/:token/playlist/:id', tokenMiddleware, async function (req, res) {
  var cid = effectiveCid(req.tokenEntry), rawId = req.params.id;
  if (rawId.indexOf('ytm_') === 0) {
    try { return res.json(await importYtmPlaylist(rawId.replace('ytm_', ''))); }
    catch (e) { return res.status(500).json({ error: 'YTM playlist failed: ' + e.message }); }
  }
  if (!cid) return res.status(503).json({ error: 'No client_id.' });
  try {
    var pl = await scGet(cid, 'https://api-v2.soundcloud.com/playlists/' + rawId);
    if (!pl) return res.status(404).json({ error: 'Playlist not found.' });
    var resolved = await resolveStubs(cid, pl.tracks || [], pl.artwork_url);
    res.json({
      id: String(pl.id), title: pl.title || 'Unknown', description: pl.description || null,
      artworkURL: artworkUrl(pl.artwork_url), creator: (pl.user && pl.user.username) || null,
      tracks: resolved.map(function (t) {
        rememberTrack(t); var m = parseArtistTitle(t);
        return { id: String(t.id), title: m.title || t.title || 'Unknown', artist: m.artist || 'Unknown', duration: t.duration ? Math.floor(t.duration / 1000) : null, artworkURL: artworkUrl(t.artwork_url, pl.artwork_url) };
      })
    });
  } catch (e) { res.status(500).json({ error: 'Playlist fetch failed.' }); }
});

app.get('/u/:token/import', tokenMiddleware, async function (req, res) {
  var cid = effectiveCid(req.tokenEntry), inputUrl = cleanText(req.query.url || '');
  if (!inputUrl) return res.status(400).json({ error: 'Pass ?url= with a playlist URL.' });
  var type = detectUrlType(inputUrl);
  if (type === 'sc_playlist') {
    if (!cid) return res.status(503).json({ error: 'No SoundCloud client_id yet.' });
    try { return res.json(await importScPlaylist(cid, inputUrl)); }
    catch (e) { return res.status(500).json({ error: 'SoundCloud import failed: ' + e.message }); }
  }
  if (type === 'ytm_playlist') {
    var ytmId = extractYtmId(inputUrl);
    if (!ytmId) return res.status(400).json({ error: 'Could not extract playlist ID from URL.' });
    try { return res.json(await importYtmPlaylist(ytmId)); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  return res.status(400).json({ error: 'URL not recognised. Use soundcloud.com/*/sets/*, on.soundcloud.com/..., or music.youtube.com/playlist?list=...' });
});

app.get('/health', function (_req, res) {
  res.json({
    status: 'ok', version: '3.8.0',
    sharedClientIdReady: !!SHARED_CLIENT_ID,
    redisConnected: !!(redis && redis.status === 'ready'),
    ytdlpReady: ytdlpReady,
    activeTokens: TOKEN_CACHE.size,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, function () { console.log('Eclipse SoundCloud Addon v3.8.0 on port ' + PORT); });
