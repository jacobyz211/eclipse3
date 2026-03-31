const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');
const ytdl    = require('@distube/ytdl-core');
const ytpl    = require('ytpl');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── Redis ────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', function () { console.log('[Redis] Connected'); });
  redis.on('error',   function (e) { console.error('[Redis] Error: ' + e.message); });
}

async function redisSave(token, entry) {
  if (!redis) return;
  try { await redis.set('sc:token:' + token, JSON.stringify({ clientId: entry.clientId, createdAt: entry.createdAt, lastUsed: entry.lastUsed, reqCount: entry.reqCount })); }
  catch (e) { console.error('[Redis] Save failed: ' + e.message); }
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
const TRACK_CACHE = new Map();
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

async function getHtml(url) {
  try {
    var r = await axios.get(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Encoding': 'gzip, deflate' }, timeout: 15000, decompress: true, responseType: 'text', validateStatus: function (s) { return s < 500; } });
    return r.data || '';
  } catch (e) { return null; }
}

async function getJs(url) {
  try {
    var r = await axios.get(url, { headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://soundcloud.com/' }, timeout: 12000, decompress: true, responseType: 'text', validateStatus: function (s) { return s < 500; } });
    if (r.status !== 200 || (r.data || '').length < 5000) return null;
    return r.data;
  } catch (e) { return null; }
}

async function tryExtract() {
  for (var pu of ['https://soundcloud.com', 'https://soundcloud.com/discover']) {
    var html = await getHtml(pu);
    if (!html || html.length < 5000) continue;
    for (var m of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) { var id = findId(m[1]); if (id) return id; }
    var urls = Array.from(new Set([
      ...Array.from(html.matchAll(/https?:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9._-]+\.js/g)).map(function (x) { return x[0]; }),
      ...Array.from(html.matchAll(/src=["'](https?:\/\/[^"']*(?:sndcdn|soundcloud)[^"']*\.js[^"']*)["']/g)).map(function (x) { return x[1]; })
    ])).reverse().slice(0, 10);
    for (var u of urls) { var js = await getJs(u); if (!js) continue; var bid = findId(js); if (bid) return bid; }
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
    var r = await axios.get(url, { params: Object.assign({}, params || {}, { client_id: cid }), headers: { 'User-Agent': UA, 'Accept': 'application/json' }, timeout: 12000, decompress: true });
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

// ─── YouTube (replaces dead Piped) ────────────────────────────────────────
var YTDL_OPTS = {
  requestOptions: {
    headers: { 'User-Agent': UA }
  }
};

async function youtubeStreamUrl(videoId) {
  try {
    var info = await ytdl.getInfo('https://www.youtube.com/watch?v=' + videoId, YTDL_OPTS);
    var formats = ytdl.filterFormats(info.formats, 'audioonly');
    if (!formats.length) return null;
    var chosen = formats.find(function (f) { return f.container === 'mp4' || f.container === 'm4a'; })
              || formats.sort(function (a, b) { return (b.audioBitrate || 0) - (a.audioBitrate || 0); })[0];
    if (!chosen || !chosen.url) return null;
    return {
      url:       chosen.url,
      format:    (chosen.container === 'mp4' || chosen.container === 'm4a') ? 'm4a' : 'mp3',
      quality:   (chosen.audioBitrate || 128) + 'kbps',
      expiresAt: Math.floor(Date.now() / 1000) + 21600
    };
  } catch (e) {
    console.warn('[YT stream] ' + videoId + ': ' + e.message);
    return null;
  }
}

// Innertube search - no external package needed
async function youtubeSearchId(query) {
  try {
    var body = {
      context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' } },
      query: query,
      params: 'EgIQAQ=='
    };
    var res = await axios.post('https://www.youtube.com/youtubei/v1/search', body, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': '2.20240101.00.00' },
      timeout: 10000
    });
    var matches = JSON.stringify(res.data).match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    return matches ? matches[1] : null;
  } catch (e) {
    console.warn('[YT search] ' + e.message);
    return null;
  }
}

async function ytFallback(title, artist) {
  for (var q of [(artist ? artist + ' - ' : '') + title, title]) {
    var videoId = await youtubeSearchId(q);
    if (videoId) { var s = await youtubeStreamUrl(videoId); if (s) return s; }
  }
  return null;
}

// ─── YTM playlist import (via ytpl) ───────────────────────────────────────
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
    throw new Error('Could not fetch YouTube playlist: ' + e.message + '. Make sure the playlist is Public (not Unlisted or Private).');
  }
}

// ─── SC playlist import ───────────────────────────────────────────────────
async function importScPlaylist(cid, scUrl) {
  var res = await scGet(cid, 'https://api-v2.soundcloud.com/resolve', { url: scUrl });
  if (!res) throw new Error('Could not resolve SoundCloud URL');
  if (res.kind !== 'playlist') throw new Error('Not a playlist (kind: ' + res.kind + ')');
  var resolved = await resolveStubs(cid, res.tracks || [], res.artwork_url);
  return {
    id: String(res.id), title: res.title || 'Imported', artworkURL: artworkUrl(res.artwork_url),
    creator: (res.user && res.user.username) || null,
    tracks: resolved.map(function (t) {
      rememberTrack(t); var m = parseArtistTitle(t);
      return { id: String(t.id), title: m.title || t.title || 'Unknown', artist: m.artist || (res.user && res.user.username) || 'Unknown', duration: t.duration ? Math.floor(t.duration / 1000) : null, artworkURL: artworkUrl(t.artwork_url, res.artwork_url) };
    })
  };
}

// ─── URL helpers ──────────────────────────────────────────────────────────
function detectUrlType(url) {
  if (!url) return null;
  if (/soundcloud\.com\/.+\/sets\/.+/.test(url)) return 'sc_playlist';
  if (/(?:music\.youtube\.com|youtube\.com).*[?&]list=/.test(url)) return 'ytm_playlist';
  if (/music\.youtube\.com\/browse\/VL/.test(url)) return 'ytm_playlist';
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
  h += 'h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}';
  h += 'h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}';
  h += 'p.sub{font-size:14px;color:#777;margin-bottom:20px;line-height:1.6}';
  h += '.tip{background:#0d1f0d;border:1px solid #1a3a1a;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#5a9e5a;line-height:1.7}';
  h += '.tip b{color:#7cc97c}';
  h += '.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}';
  h += '.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#1a2218;color:#6db86d;border:1px solid #2d422a}';
  h += '.pill.o{background:#1f1500;color:#f50;border-color:#3a2500}';
  h += '.pill.b{background:#001a2e;color:#4a9eff;border-color:#003a6e}';
  h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:8px;margin-top:16px}';
  h += 'input{width:100%;background:#0f0f0f;border:1px solid #222;border-radius:10px;color:#e8e8e8;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}';
  h += 'input:focus{border-color:#f50}input::placeholder{color:#333}';
  h += '.hint{font-size:12px;color:#484848;margin-bottom:12px;line-height:1.7}';
  h += '.hint a{color:#f50;text-decoration:none}.hint code{background:#1a1a1a;padding:1px 5px;border-radius:4px;color:#888}';
  h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}';
  h += '.bo{background:#f50;color:#fff}.bo:hover{background:#d94a00}.bo:disabled{background:#252525;color:#444;cursor:not-allowed}';
  h += '.bg{background:#1a4a20;color:#e8e8e8;border:1px solid #2a6a30}.bg:hover{background:#245c2a}.bg:disabled{background:#252525;color:#444;cursor:not-allowed}';
  h += '.bd{background:#1a1a1a;color:#aaa;border:1px solid #222;font-size:13px;padding:10px}.bd:hover{background:#222;color:#fff}';
  h += '.box{display:none;background:#0f0f0f;border:1px solid #1e1e1e;border-radius:12px;padding:18px;margin-bottom:14px}';
  h += '.blbl{font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}';
  h += '.burl{font-size:12px;color:#f50;word-break:break-all;font-family:"SF Mono",monospace;margin-bottom:14px;line-height:1.5}';
  h += 'hr{border:none;border-top:1px solid #1a1a1a;margin:24px 0}';
  h += '.steps{display:flex;flex-direction:column;gap:12px}';
  h += '.step{display:flex;gap:12px;align-items:flex-start}';
  h += '.sn{background:#1a1a1a;border:1px solid #252525;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#666}';
  h += '.st{font-size:13px;color:#666;line-height:1.6}.st b{color:#aaa}';
  h += '.warn{background:#140f00;border:1px solid #2e2000;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#8a6a00;line-height:1.7}';
  h += '.badge{display:inline-block;background:#001a2e;color:#4a9eff;border:1px solid #003a6e;border-radius:20px;font-size:11px;font-weight:600;padding:3px 10px;margin-bottom:14px}';
  h += '.status{font-size:13px;color:#666;margin:8px 0;min-height:18px}.status.ok{color:#5a9e5a}.status.err{color:#c0392b}';
  h += '.preview{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:10px;padding:12px;max-height:200px;overflow-y:auto;margin-bottom:12px;display:none}';
  h += '.tr{display:flex;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid #181818;font-size:13px}';
  h += '.tr:last-child{border-bottom:none}.tn{color:#444;font-size:11px;min-width:22px;text-align:right}';
  h += '.ti{flex:1;min-width:0}.tt{color:#e8e8e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
  h += '.ta{color:#666;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
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
  h += '<div class="tip"><b>Save your URL</b> - copy it to Notes or a bookmark. If the server updates, paste it into the Refresh section below to keep all playlists working without generating a new link.</div>';
  h += '<p class="sub">Generate your personal addon URL. Independent rate limits and client ID per user.</p>';
  h += '<div class="pills"><span class="pill">Tracks, albums, artists</span><span class="pill">SC playlists</span><span class="pill o">YouTube fallback</span><span class="pill b">YTM import</span></div>';

  h += '<div class="lbl">SoundCloud Client ID <span style="color:#3a3a3a;font-weight:400;text-transform:none">(optional)</span></div>';
  h += '<input type="text" id="clientId" placeholder="Leave blank to use the shared auto-refreshed ID">';
  h += '<div class="hint">Want your own? Open <a href="https://soundcloud.com" target="_blank">soundcloud.com</a>, press F12 > Network > filter <code>api-v2</code> > copy the <code>client_id=</code> value.</div>';

  h += '<button class="bo" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="blbl">Your addon URL - paste this into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyGenBtn" onclick="copyGen()">Copy URL</button></div>';

  h += '<hr>';
  h += '<div class="lbl">Refresh existing URL</div>';
  h += '<input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">';
  h += '<div class="hint">The URL stays exactly the same - every saved playlist keeps working.</div>';
  h += '<button class="bg" id="refBtn" onclick="doRefresh()">Refresh Existing URL</button>';
  h += '<div class="box" id="refBox"><div class="blbl">Refreshed - same URL, still works in Eclipse</div><div class="burl" id="refUrl"></div><button class="bd" id="copyRefBtn" onclick="copyRef()">Copy URL</button></div>';

  h += '<hr>';
  h += '<div class="steps">';
  h += '<div class="step"><div class="sn">1</div><div class="st">Generate and copy your URL above</div></div>';
  h += '<div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> > Settings > Connections > Add Connection > Addon</div></div>';
  h += '<div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap Install</div></div>';
  h += '<div class="step"><div class="sn">4</div><div class="st">Use the <b>Playlist Importer</b> below to download any SC or YTM playlist as CSV, then import in Eclipse via Library > Import > CSV</div></div>';
  h += '</div>';
  h += '<div class="warn">Your URL is saved to Redis and survives server restarts. YouTube Music playlists must be set to Public to import.</div>';
  h += '</div>';

  h += '<div class="card">';
  h += '<span class="badge">Playlist Importer</span>';
  h += '<h2>Import SoundCloud or YouTube Music Playlist</h2>';
  h += '<p class="sub">Paste your addon URL and a playlist link. We fetch all tracks and download a CSV you can import in Eclipse via Library > Import > CSV.</p>';
  h += '<div class="lbl">Your Addon URL</div>';
  h += '<input type="text" id="impToken" placeholder="Paste your addon URL here (auto-fills after generating)">';
  h += '<div class="lbl">Playlist URL</div>';
  h += '<input type="text" id="impUrl" placeholder="soundcloud.com/artist/sets/name  or  music.youtube.com/playlist?list=PL...">';
  h += '<div class="hint">SoundCloud: soundcloud.com/*/sets/* &nbsp;|&nbsp; YouTube Music: music.youtube.com/playlist?list=... or music.youtube.com/browse/VL...</div>';
  h += '<div class="status" id="impStatus"></div>';
  h += '<div class="preview" id="impPreview"></div>';
  h += '<button class="bg" id="impBtn" onclick="doImport()">Fetch &amp; Download CSV</button>';
  h += '</div>';

  h += '<footer>Eclipse SoundCloud Addon v3.5.0 &bull; <a href="' + baseUrl + '/health" target="_blank" style="color:#333;text-decoration:none">' + baseUrl + '</a></footer>';

  h += '<script>';
  h += 'var _gu="",_ru="";';

  h += 'function generate(){';
  h += '  var btn=document.getElementById("genBtn");';
  h += '  var cid=document.getElementById("clientId").value.trim();';
  h += '  btn.disabled=true;btn.textContent="Generating...";';
  h += '  fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId:cid||null})})';
  h += '  .then(function(r){return r.json();})';
  h += '  .then(function(d){';
  h += '    if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}';
  h += '    _gu=d.manifestUrl;';
  h += '    document.getElementById("genUrl").textContent=_gu;';
  h += '    document.getElementById("genBox").style.display="block";';
  h += '    document.getElementById("impToken").value=_gu;';
  h += '    btn.disabled=false;btn.textContent="Regenerate URL";';
  h += '  })';
  h += '  .catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});';
  h += '}';

  h += 'function copyGen(){';
  h += '  if(!_gu)return;';
  h += '  navigator.clipboard.writeText(_gu).then(function(){';
  h += '    var b=document.getElementById("copyGenBtn");b.textContent="Copied!";';
  h += '    setTimeout(function(){b.textContent="Copy URL";},1500);';
  h += '  });';
  h += '}';

  h += 'function doRefresh(){';
  h += '  var btn=document.getElementById("refBtn");';
  h += '  var eu=document.getElementById("existingUrl").value.trim();';
  h += '  var cid=document.getElementById("clientId").value.trim();';
  h += '  if(!eu){alert("Paste your existing addon URL first.");return;}';
  h += '  btn.disabled=true;btn.textContent="Refreshing...";';
  h += '  fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu,clientId:cid||null})})';
  h += '  .then(function(r){return r.json();})';
  h += '  .then(function(d){';
  h += '    if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Refresh Existing URL";return;}';
  h += '    _ru=d.manifestUrl;';
  h += '    document.getElementById("refUrl").textContent=_ru;';
  h += '    document.getElementById("refBox").style.display="block";';
  h += '    document.getElementById("impToken").value=_ru;';
  h += '    btn.disabled=false;btn.textContent="Refresh Again";';
  h += '  })';
  h += '  .catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Refresh Existing URL";});';
  h += '}';

  h += 'function copyRef(){';
  h += '  if(!_ru)return;';
  h += '  navigator.clipboard.writeText(_ru).then(function(){';
  h += '    var b=document.getElementById("copyRefBtn");b.textContent="Copied!";';
  h += '    setTimeout(function(){b.textContent="Copy URL";},1500);';
  h += '  });';
  h += '}';

  h += 'function getTok(s){var m=s.match(/\\/u\\/([a-f0-9]{28})\\//);return m?m[1]:null;}';

  h += 'function hesc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}';

  h += 'function doImport(){';
  h += '  var btn=document.getElementById("impBtn");';
  h += '  var raw=document.getElementById("impToken").value.trim();';
  h += '  var purl=document.getElementById("impUrl").value.trim();';
  h += '  var st=document.getElementById("impStatus");';
  h += '  var pv=document.getElementById("impPreview");';
  h += '  if(!raw){st.className="status err";st.textContent="Paste your addon URL first.";return;}';
  h += '  if(!purl){st.className="status err";st.textContent="Paste a playlist URL.";return;}';
  h += '  var tok=getTok(raw);';
  h += '  if(!tok){st.className="status err";st.textContent="Could not find your token in the URL.";return;}';
  h += '  btn.disabled=true;btn.textContent="Fetching...";';
  h += '  st.className="status";st.textContent="Fetching tracks...";';
  h += '  pv.style.display="none";';
  h += '  fetch("/u/"+tok+"/import?url="+encodeURIComponent(purl))';
  h += '  .then(function(r){';
  h += '    if(!r.ok)return r.json().then(function(e){throw new Error(e.error||"Server error "+r.status);});';
  h += '    return r.json();';
  h += '  })';
  h += '  .then(function(data){';
  h += '    var tracks=data.tracks||[];';
  h += '    if(!tracks.length)throw new Error("No tracks found.");';
  h += '    var rows=tracks.slice(0,50).map(function(t,i){';
  h += '      return \'<div class="tr"><span class="tn">\'+(i+1)+\'</span><div class="ti"><div class="tt">\'+hesc(t.title)+\'</div><div class="ta">\'+hesc(t.artist)+\'</div></div></div>\';';
  h += '    }).join("");';
  h += '    if(tracks.length>50)rows+=\'<div class="tr" style="text-align:center;color:#555">+\'+(tracks.length-50)+\' more</div>\';';
  h += '    pv.innerHTML=rows;pv.style.display="block";';
  h += '    st.className="status ok";';
  h += '    st.textContent="Found "+tracks.length+" tracks in \\""+data.title+"\\"";';
  h += '    var lines=["Title,Artist,Album,Duration"];';
  h += '    tracks.forEach(function(t){';
  h += '      function ce(s){s=String(s||"");if(s.indexOf(",")!==-1||s.indexOf("\\"")!==-1){s=\'"\'+s.replace(/"/g,\'""\')+\'"\'}return s;}';
  h += '      lines.push(ce(t.title)+","+ce(t.artist)+","+ce(data.title||"")+","+ce(t.duration||""));';
  h += '    });';
  h += '    var blob=new Blob([lines.join("\\n")],{type:"text/csv"});';
  h += '    var a=document.createElement("a");';
  h += '    a.href=URL.createObjectURL(blob);';
  h += '    a.download=(data.title||"playlist").replace(/[^a-zA-Z0-9 _-]/g,"").trim()+".csv";';
  h += '    document.body.appendChild(a);a.click();document.body.removeChild(a);';
  h += '    btn.disabled=false;btn.textContent="Fetch & Download CSV";';
  h += '  })';
  h += '  .catch(function(e){';
  h += '    st.className="status err";st.textContent=e.message;';
  h += '    btn.disabled=false;btn.textContent="Fetch & Download CSV";';
  h += '  });';
  h += '}';

  h += '<\/script>';
  h += '</body></html>';
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
  if (cid && !/^[a-zA-Z0-9]{20,40}$/.test(cid)) return res.status(400).json({ error: 'Invalid client_id (20-40 alphanumeric chars).' });
  var token = generateToken();
  var entry = { clientId: cid || null, createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  res.json({ token: token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.post('/refresh', async function (req, res) {
  var raw   = (req.body && req.body.existingUrl) ? String(req.body.existingUrl).trim() : '';
  var cid   = (req.body && req.body.clientId)    ? String(req.body.clientId).trim()    : null;
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
    id: 'com.eclipse.soundcloud.' + req.params.token.slice(0, 8),
    name: 'SoundCloud', version: '3.5.0',
    description: 'SoundCloud + YouTube Music. Tracks, albums, artists, playlists, CSV import.',
    icon: 'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-orange-2xhdpi-a9dce059.png',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist']
  });
});

app.get('/u/:token/search', tokenMiddleware, async function (req, res) {
  var q = cleanText(req.query.q || '');
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  var cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id yet. Retry in a few seconds.', tracks: [] });
  try {
    var results = await Promise.all([
      scGet(cid, 'https://api-v2.soundcloud.com/search/tracks',    { q: q, limit: 15, offset: 0, linked_partitioning: 1 }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/playlists', { q: q, limit: 10, offset: 0 }).catch(function () { return null; }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/users',     { q: q, limit: 5,  offset: 0 }).catch(function () { return null; })
    ]);
    var allPl = (results[1] && results[1].collection) || [];
    res.json({
      tracks: ((results[0] && results[0].collection) || []).filter(function (t) { return t.streamable !== false; }).map(function (t) {
        rememberTrack(t); var m = parseArtistTitle(t);
        return { id: String(t.id), title: m.title || 'Unknown', artist: m.artist || 'Unknown', album: null, duration: t.duration ? Math.floor(t.duration / 1000) : null, artworkURL: artworkUrl(t.artwork_url), format: 'aac', isSnipped: t.policy === 'SNIP' };
      }),
      albums:    allPl.filter(function (p) { return  p.is_album; }).map(function (p) { return { id: String(p.id), title: p.title || 'Unknown', artist: (p.user && p.user.username) || 'Unknown', artworkURL: artworkUrl(p.artwork_url), trackCount: p.track_count || null, year: scYear(p) }; }),
      playlists: allPl.filter(function (p) { return !p.is_album; }).map(function (p) { return { id: String(p.id), title: p.title || 'Unknown', description: p.description || null, artworkURL: artworkUrl(p.artwork_url), creator: (p.user && p.user.username) || null, trackCount: p.track_count || null }; }),
      artists:   ((results[2] && results[2].collection) || []).map(function (u) { return { id: String(u.id), name: u.username || 'Unknown', artworkURL: artworkUrl(u.avatar_url), genres: u.genre ? [u.genre] : [] }; })
    });
  } catch (e) { res.status(500).json({ error: 'Search failed', tracks: [] }); }
});

app.get('/u/:token/stream/:id', tokenMiddleware, async function (req, res) {
  var cid = effectiveCid(req.tokenEntry), tid = req.params.id;

  // YTM track — stream directly
  if (tid.indexOf('ytm_') === 0) {
    var ys = await youtubeStreamUrl(tid.replace('ytm_', ''));
    return ys ? res.json(ys) : res.status(404).json({ error: 'Could not stream YTM track.' });
  }

  if (!cid) return res.status(503).json({ error: 'No client_id available.' });

  // Try SoundCloud first
  var track = null, cached = TRACK_CACHE.get(String(tid)) || null;
  try {
    try { track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/soundcloud:tracks:' + tid); }
    catch (e) { track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/' + tid); }
  } catch (e) { console.warn('[stream] track lookup failed'); }

  if (track) { rememberTrack(track); cached = TRACK_CACHE.get(String(tid)) || cached; }

  // Only stream from SC if not SNIP or BLOCK
  if (track && track.policy !== 'BLOCK' && track.policy !== 'SNIP') {
    try {
      var tc = (track.media && track.media.transcodings) || [];
      var ch = tc.find(function (t) { return t.format && t.format.protocol === 'progressive'; })
            || tc.find(function (t) { return t.format && t.format.protocol === 'hls' && t.format.mime_type && t.format.mime_type.indexOf('aac') !== -1; })
            || tc.find(function (t) { return t.format && t.format.protocol === 'hls'; })
            || tc[0];
      if (ch && ch.url) {
        var sd = await scGet(cid, ch.url);
        if (sd && sd.url) return res.json({ url: sd.url, format: (ch.format && ch.format.mime_type && ch.format.mime_type.indexOf('aac') !== -1) ? 'aac' : 'mp3', quality: '160kbps', expiresAt: Math.floor(Date.now() / 1000) + (ch.format && ch.format.protocol === 'progressive' ? 86400 : 3300) });
      }
    } catch (e) { console.warn('[stream] sc stream failed'); }
  }

  // Fall back to YouTube
  var meta = track ? parseArtistTitle(track) : cached;
  if (!meta || !meta.title) return res.status(404).json({ error: 'No stream and no fallback metadata.' });
  var yt = await ytFallback(meta.title, meta.artist || meta.uploader || '');
  if (yt) return res.json(yt);
  return res.status(404).json({ error: 'No stream for: ' + meta.title });
});

app.get('/u/:token/album/:id', tokenMiddleware, async function (req, res) {
  var cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id.' });
  try {
    var pl = await scGet(cid, 'https://api-v2.soundcloud.com/playlists/' + req.params.id);
    if (!pl) return res.status(404).json({ error: 'Album not found.' });
    var resolved = await resolveStubs(cid, pl.tracks || [], pl.artwork_url);
    res.json({ id: String(pl.id), title: pl.title || 'Unknown', artist: (pl.user && pl.user.username) || 'Unknown', artworkURL: artworkUrl(pl.artwork_url), year: scYear(pl), description: pl.description || null, trackCount: pl.track_count || resolved.length, tracks: resolved.map(function (t) { rememberTrack(t); var m = parseArtistTitle(t); return { id: String(t.id), title: m.title || t.title || 'Unknown', artist: m.artist || (pl.user && pl.user.username) || 'Unknown', duration: t.duration ? Math.floor(t.duration / 1000) : null, artworkURL: artworkUrl(t.artwork_url, pl.artwork_url) }; }) });
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
      topTracks: resolved.map(function (t) { rememberTrack(t); var m = parseArtistTitle(t); return { id: String(t.id), title: m.title || t.title || 'Unknown', artist: m.artist || user.username || 'Unknown', duration: t.duration ? Math.floor(t.duration / 1000) : null, artworkURL: artworkUrl(t.artwork_url) }; }),
      albums: ((results[2] && results[2].collection) || []).filter(function (p) { return p.is_album === true; }).map(function (p) { return { id: String(p.id), title: p.title || 'Unknown', artist: user.username || 'Unknown', artworkURL: artworkUrl(p.artwork_url), trackCount: p.track_count || null, year: scYear(p) }; })
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
    res.json({ id: String(pl.id), title: pl.title || 'Unknown', description: pl.description || null, artworkURL: artworkUrl(pl.artwork_url), creator: (pl.user && pl.user.username) || null, tracks: resolved.map(function (t) { rememberTrack(t); var m = parseArtistTitle(t); return { id: String(t.id), title: m.title || t.title || 'Unknown', artist: m.artist || 'Unknown', duration: t.duration ? Math.floor(t.duration / 1000) : null, artworkURL: artworkUrl(t.artwork_url, pl.artwork_url) }; }) });
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
  return res.status(400).json({ error: 'URL not recognised. Use soundcloud.com/*/sets/* or music.youtube.com/playlist?list=...' });
});

app.get('/health', function (_req, res) {
  res.json({ status: 'ok', sharedClientIdReady: !!SHARED_CLIENT_ID, redisConnected: !!(redis && redis.status === 'ready'), activeTokens: TOKEN_CACHE.size, timestamp: new Date().toISOString() });
});

app.listen(PORT, function () { console.log('Eclipse SoundCloud Addon v3.5.0 on port ' + PORT); });
