const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── Redis ────────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false, lazyConnect: false });
  redis.on('connect', function() { console.log('[Redis] Connected'); });
  redis.on('error',   function(e) { console.error('[Redis] Error: ' + e.message); });
} else {
  console.warn('[Redis] No REDIS_URL set — tokens will not survive restarts.');
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set('sc:token:' + token, JSON.stringify({ clientId: entry.clientId, createdAt: entry.createdAt, lastUsed: entry.lastUsed, reqCount: entry.reqCount }));
  } catch (e) { console.error('[Redis] Save failed: ' + e.message); }
}

async function redisLoad(token) {
  if (!redis) return null;
  try {
    var data = await redis.get('sc:token:' + token);
    return data ? JSON.parse(data) : null;
  } catch (e) { console.error('[Redis] Load failed: ' + e.message); return null; }
}

// ─── Token store ──────────────────────────────────────────────────────────────
const TOKEN_CACHE = new Map();
const IP_CREATES  = new Map();

const MAX_TOKENS_PER_IP = 10;
const RATE_MAX          = 60;
const RATE_WINDOW_MS    = 60000;

function generateToken() { return crypto.randomBytes(14).toString('hex'); }

function getOrCreateIpBucket(ip) {
  var now    = Date.now();
  var bucket = IP_CREATES.get(ip);
  if (!bucket || now > bucket.resetAt) { bucket = { count: 0, resetAt: now + 86400000 }; IP_CREATES.set(ip, bucket); }
  return bucket;
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
  entry.rateWin = (entry.rateWin || []).filter(function(t) { return now - t < RATE_WINDOW_MS; });
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now);
  entry.lastUsed = now;
  entry.reqCount = (entry.reqCount || 0) + 1;
  return true;
}

async function tokenMiddleware(req, res, next) {
  var token = req.params.token;
  var entry = await getTokenEntry(token);
  if (!entry) return res.status(404).json({ error: 'Invalid or expired token. Generate a new one at ' + getBaseUrl(req) });
  if (!checkRateLimit(entry)) return res.status(429).json({ error: 'Rate limit exceeded (60 req/min).' });
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(token, entry);
  next();
}

function getBaseUrl(req) { var proto = req.headers['x-forwarded-proto'] || req.protocol; return proto + '://' + req.get('host'); }
function effectiveClientId(entry) { return (entry && entry.clientId) ? entry.clientId : SHARED_CLIENT_ID; }

// ─── SoundCloud helpers ───────────────────────────────────────────────────────
let SHARED_CLIENT_ID = null;
const TRACK_CACHE    = new Map();
const sleep = function(ms) { return new Promise(function(r) { return setTimeout(r, ms); }); };

const PAGE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate'
};

const ID_PATTERNS = [
  /client_id\s*[=:,]\s*["']([a-zA-Z0-9]{32})["']/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /client_id=([a-zA-Z0-9]{32})[&"'\s,)]/
];

function findId(text) {
  var i, m;
  for (i = 0; i < ID_PATTERNS.length; i++) { m = text.match(ID_PATTERNS[i]); if (m && m[1]) return m[1]; }
  return null;
}

function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function stripFeatures(s) {
  return cleanText(String(s || '').replace(/\s*\\((feat|ft|featuring)[^)]+\\)/gi, '').replace(/\s*(feat|ft|featuring)\.?\s+[^-|/]+/gi, ''));
}

function parseArtistTitle(track) {
  var rawTitle   = cleanText(track && track.title);
  var metaArtist = cleanText((track && track.publisher_metadata && (track.publisher_metadata.artist || track.publisher_metadata.writer_composer)) || '');
  var uploader   = cleanText(track && track.user && track.user.username);
  var parts, left, right;
  if (rawTitle.indexOf(' - ') !== -1) {
    parts = rawTitle.split(' - '); left = cleanText(parts[0]); right = cleanText(parts.slice(1).join(' - '));
    if (left && right) return { artist: metaArtist || left, title: right, rawTitle: rawTitle, uploader: uploader };
  }
  return { artist: metaArtist || uploader, title: rawTitle, rawTitle: rawTitle, uploader: uploader };
}

function rememberTrack(track) {
  if (!track || !track.id) return;
  var meta = parseArtistTitle(track);
  TRACK_CACHE.set(String(track.id), { id: String(track.id), artist: meta.artist, title: meta.title, rawTitle: meta.rawTitle, uploader: meta.uploader });
}

function artworkUrl(raw, fallback) {
  var src = raw || fallback || '';
  return src ? src.replace('-large', '-t500x500') : null;
}

function scYear(item) {
  if (item.release_date) return String(item.release_date).slice(0, 4);
  if (item.created_at)   return String(item.created_at).slice(0, 4);
  return null;
}

async function getPage(url) {
  try {
    var res = await axios.get(url, { headers: PAGE_HEADERS, timeout: 15000, decompress: true, responseType: 'text', validateStatus: function(s) { return s < 500; } });
    var html = res.data || ''; console.log('[SC] ' + url + ' => HTTP ' + res.status + ' | ' + html.length + ' bytes'); return html;
  } catch (err) { console.warn('[SC] Page failed: ' + err.message); return null; }
}

async function getScript(url) {
  try {
    var res = await axios.get(url, { headers: { 'User-Agent': PAGE_HEADERS['User-Agent'], 'Accept': '*/*', 'Accept-Encoding': 'gzip, deflate', 'Referer': 'https://soundcloud.com/' }, timeout: 12000, decompress: true, responseType: 'text', validateStatus: function(s) { return s < 500; } });
    var text = res.data || ''; console.log('[SC] Script ' + url.split('/').pop() + ' => ' + res.status + ' | ' + text.length + ' bytes');
    if (res.status !== 200 || text.length < 5000) return null; return text;
  } catch (err) { console.warn('[SC] Script failed: ' + err.message); return null; }
}

async function tryExtract() {
  var pages = ['https://soundcloud.com', 'https://soundcloud.com/discover'];
  var i, pageUrl, html, inlineMatches, match, id, bundleUrls, srcUrls, all, url, js;
  for (i = 0; i < pages.length; i++) {
    pageUrl = pages[i]; html = await getPage(pageUrl);
    if (!html || html.length < 5000) continue;
    inlineMatches = html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g);
    for (match of inlineMatches) { id = findId(match[1]); if (id) { console.log('[SC] client_id in inline script'); return id; } }
    bundleUrls = Array.from(new Set(Array.from(html.matchAll(/https?:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9._-]+\.js/g)).map(function(m) { return m[0]; })));
    srcUrls    = Array.from(html.matchAll(/src=["'](https?:\/\/[^"']*(?:sndcdn|soundcloud)[^"']*\.js[^"']*)["']/g)).map(function(m) { return m[1]; });
    all        = Array.from(new Set(bundleUrls.concat(srcUrls))).reverse().slice(0, 10);
    console.log('[SC] Found ' + all.length + ' bundle(s) in ' + pageUrl);
    for (url of all) { js = await getScript(url); if (!js) continue; id = findId(js); if (id) { console.log('[SC] client_id found in bundle'); return id; } }
  }
  return null;
}

async function fetchSharedClientId() {
  if (process.env.SC_CLIENT_ID) { SHARED_CLIENT_ID = process.env.SC_CLIENT_ID; console.log('Shared client_id from env var'); return; }
  var delays = [5000, 10000, 15000, 30000, 60000]; var attempt = 0; var id, delay;
  while (true) {
    attempt++; console.log('[Attempt ' + attempt + '] Fetching shared client_id...');
    try { id = await tryExtract(); if (!id) throw new Error('Not found'); SHARED_CLIENT_ID = id; console.log('Shared client_id: ' + id); setTimeout(function() { SHARED_CLIENT_ID = null; fetchSharedClientId(); }, 6 * 60 * 60 * 1000); return; }
    catch (err) { delay = delays[Math.min(attempt - 1, delays.length - 1)]; console.warn('Attempt ' + attempt + ' failed. Retry in ' + (delay / 1000) + 's'); await sleep(delay); }
  }
}

fetchSharedClientId();

async function scGet(clientId, url, params, retried) {
  params = params || {}; retried = retried || false;
  if (!clientId) throw new Error('No client_id');
  try {
    var res = await axios.get(url, { params: Object.assign({}, params, { client_id: clientId }), headers: { 'User-Agent': PAGE_HEADERS['User-Agent'], 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate' }, timeout: 12000, decompress: true });
    return res.data;
  } catch (err) {
    if (!retried && err.response && (err.response.status === 401 || err.response.status === 403) && !params._userClientId) {
      console.warn('[API] 401/403 on shared id - refreshing'); SHARED_CLIENT_ID = null; fetchSharedClientId(); await sleep(3000); return scGet(SHARED_CLIENT_ID, url, params, true);
    }
    throw err;
  }
}

// ─── YouTube / Piped ──────────────────────────────────────────────────────────
var PIPED_INSTANCES = ['https://pipedapi.kavin.rocks','https://piped-api.garudalinux.org','https://api.piped.projectsegfau.lt','https://pipedapi.in.projectsegfau.lt'];

async function pipedGet(path, params) {
  params = params || {}; var i, res;
  for (i = 0; i < PIPED_INSTANCES.length; i++) {
    try { res = await axios.get(PIPED_INSTANCES[i] + path, { params: params, headers: { 'User-Agent': PAGE_HEADERS['User-Agent'] }, timeout: 10000 }); if (res.data) return res.data; }
    catch (err) { console.warn('[Piped] ' + PIPED_INSTANCES[i] + ' failed: ' + err.message); }
  }
  return null;
}

function extractYouTubeId(item) {
  var url = String(item.url || item.videoUrl || ''); var m = url.match(/(?:v=|\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/); return m ? m[1] : null;
}

async function youtubeSearch(query) {
  var data = await pipedGet('/search', { q: query, filter: 'music_songs' });
  if (!data || !Array.isArray(data.items) || !data.items.length) data = await pipedGet('/search', { q: query, filter: 'all' });
  if (!data || !Array.isArray(data.items)) return null;
  var items = data.items.filter(function(x) { return extractYouTubeId(x); });
  return items.length ? items[0] : null;
}

async function youtubeStreamUrl(videoId) {
  var data = await pipedGet('/streams/' + videoId); if (!data) return null;
  var streams = Array.isArray(data.audioStreams) ? data.audioStreams : []; if (!streams.length) return null;
  var direct  = streams.filter(function(s) { return s && s.url && /^https?:\/\//i.test(s.url); });
  var chosen  = direct.find(function(s) { return (s.mimeType || '').indexOf('audio/mp4') !== -1; }) || direct.find(function(s) { return String(s.format || '').toUpperCase() === 'M4A'; }) || direct.sort(function(a, b) { return (b.bitrate || 0) - (a.bitrate || 0); })[0];
  if (!chosen || !chosen.url) return null;
  return { url: chosen.url, format: 'm4a', quality: Math.round((chosen.bitrate || 128000) / 1000) + 'kbps', expiresAt: Math.floor(Date.now() / 1000) + 21600 };
}

async function youtubeFallback(title, artist) {
  var query   = (artist ? artist + ' - ' : '') + title;
  var item    = await youtubeSearch(query);
  if (!item) { item = await youtubeSearch(title); }
  var videoId = item ? extractYouTubeId(item) : null;
  if (!videoId) return null;
  console.log('[YT] videoId: ' + videoId); return youtubeStreamUrl(videoId);
}

// ─── Config page ──────────────────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eclipse \u2022 SoundCloud Addon</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0f0f0f;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}.logo{margin-bottom:20px}.card{background:#161616;border:1px solid #232323;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5)}h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}p.sub{font-size:14px;color:#777;margin-bottom:26px;line-height:1.6}.save-tip{background:#0d1f0d;border:1px solid #1a3a1a;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#5a9e5a;line-height:1.7}.save-tip strong{color:#7cc97c}.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:28px}.pill{background:#1a2218;color:#6db86d;border:1px solid #2d422a;border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px}.pill.orange{background:#1f1500;color:#f50;border-color:#3a2500}.label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:8px}input[type=text]{width:100%;background:#0f0f0f;border:1px solid #222;border-radius:10px;color:#e8e8e8;font-size:14px;padding:12px 14px;margin-bottom:8px;outline:none;transition:border-color .15s}input[type=text]:focus{border-color:#f50}input[type=text]::placeholder{color:#333}.hint{font-size:12px;color:#484848;margin-bottom:28px;line-height:1.7}.hint code{background:#1a1a1a;padding:1px 5px;border-radius:4px;color:#888}.hint a{color:#f50;text-decoration:none}button.primary{width:100%;background:#f50;border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:700;padding:14px;cursor:pointer;transition:background .15s;margin-bottom:18px}button.primary:hover{background:#d94a00}button.primary:disabled{background:#252525;color:#444;cursor:not-allowed}.result{display:none;background:#0f0f0f;border:1px solid #1e1e1e;border-radius:12px;padding:18px;margin-bottom:18px}.rlabel{font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}.rurl{font-size:12px;color:#f50;word-break:break-all;font-family:"SF Mono",monospace;margin-bottom:14px;line-height:1.5}button.copy{width:100%;background:#1a1a1a;border:1px solid #222;border-radius:8px;color:#aaa;font-size:13px;font-weight:600;padding:10px;cursor:pointer;transition:all .15s}button.copy:hover{background:#202020;color:#fff}.divider{border:none;border-top:1px solid #1a1a1a;margin:28px 0}.steps{display:flex;flex-direction:column;gap:14px}.step{display:flex;gap:14px;align-items:flex-start}.step-n{background:#1a1a1a;border:1px solid #252525;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#666}.step-t{font-size:13px;color:#666;line-height:1.6}.step-t strong{color:#aaa}.warn{background:#140f00;border:1px solid #2e2000;border-radius:10px;padding:14px 16px;margin-top:24px;font-size:12px;color:#8a6a00;line-height:1.7}footer{margin-top:36px;font-size:12px;color:#333;text-align:center;line-height:1.8}</style></head><body><svg class="logo" width="52" height="52" viewBox="0 0 52 52" fill="none"><circle cx="26" cy="26" r="26" fill="#f50"/><path d="M15 30c0-2.4 2-4.4 4.4-4.4s4.4 2 4.4 4.4" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="M10.5 30c0-4.9 4-8.9 8.9-8.9s8.9 4 8.9 8.9" stroke="#fff" stroke-width="2.5" stroke-linecap="round" opacity=".55"/><rect x="30" y="21" width="3.5" height="17" rx="1.75" fill="#fff"/><rect x="35.5" y="18" width="3.5" height="20" rx="1.75" fill="#fff"/><rect x="41" y="23" width="3.5" height="15" rx="1.75" fill="#fff"/></svg><div class="card"><h1>SoundCloud for Eclipse</h1><div class="save-tip">\ud83d\udcbe <strong>Save your URL somewhere safe</strong> \u2014 copy it to Notes, a bookmark, or anywhere you can find it later. If the server ever updates, paste it into the \u201cRefresh\u201d section below to keep all your playlists working without generating a new link.</div><p class="sub">Generate your personal addon URL. Your URL is isolated from every other user \u2014 independent rate limits, independent client ID.</p><div class="pills"><span class="pill">\u2713 Unique per user</span><span class="pill">\u2713 Persists across restarts</span><span class="pill orange">\u2713 YouTube fallback</span></div><div class="label">Your SoundCloud Client ID <span style="color:#3a3a3a;font-weight:400;text-transform:none">(optional but recommended)</span></div><input type="text" id="clientId" placeholder="Leave blank to use the shared auto-refreshed ID"><div class="hint">Want your own? Open <a href="https://soundcloud.com" target="_blank">soundcloud.com</a>, press F12 &rarr; Network tab &rarr; filter by <code>api-v2</code> &rarr; copy the <code>client_id=</code> value from any request.</div><button class="primary" id="genBtn" onclick="generate()">Generate My Addon URL</button><div class="result" id="result"><div class="rlabel">Your addon URL \u2014 paste this into Eclipse</div><div class="rurl" id="rurl"></div><button class="copy" onclick="copyUrl()">\u29c3 Copy URL</button></div><hr class="divider"><div class="label">Already have a URL? Refresh it \u2014 keeps playlists working</div><input type="text" id="existingUrl" placeholder="Paste your existing addon URL here"><div class="hint">Paste your old URL and hit Refresh \u2014 the URL stays <strong style="color:#aaa">exactly the same</strong> so every saved playlist track keeps working. Optionally update your Client ID above first.</div><button class="primary" id="refBtn" onclick="doRefresh()" style="background:#0d2a14;border:1px solid #1a4a20">\u21bb Refresh Existing URL</button><div class="result" id="refResult"><div class="rlabel">Refreshed \u2014 same URL, still works in Eclipse</div><div class="rurl" id="rrurl"></div><button class="copy" onclick="copyRefUrl()">\u29c3 Copy URL</button></div><hr class="divider"><div class="steps"><div class="step"><div class="step-n">1</div><div class="step-t">Generate and copy your URL above</div></div><div class="step"><div class="step-n">2</div><div class="step-t">Open <strong>Eclipse Music</strong> \u2192 Library \u2192 Cloud \u2192 Add Connection \u2192 Addon</div></div><div class="step"><div class="step-n">3</div><div class="step-t">Paste your URL and tap Install</div></div><div class="step"><div class="step-n">4</div><div class="step-t"><strong>SoundCloud</strong> appears in your search dropdown. Tracks, albums, artists, and playlists all searchable</div></div></div><div class="warn">\u26a0\ufe0f Your URL is saved permanently to Redis \u2014 it survives server restarts. Bookmark this page if you need to regenerate.</div></div><footer>Eclipse SoundCloud Addon &bull; <a href="' + baseUrl + '/health" target="_blank" style="color:#333;text-decoration:none">' + baseUrl + '</a></footer><script>var gurl="";var rurl2="";function generate(){var btn=document.getElementById("genBtn");var cid=document.getElementById("clientId").value.trim();btn.disabled=true;btn.textContent="Generating...";fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId:cid||null})}).then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}gurl=d.manifestUrl;document.getElementById("rurl").textContent=gurl;document.getElementById("result").style.display="block";btn.textContent="Regenerate URL";btn.disabled=false;}).catch(function(e){alert("Request failed: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});}function copyUrl(){if(!gurl)return;navigator.clipboard.writeText(gurl).then(function(){var b=document.querySelector(".copy");b.textContent="Copied!";setTimeout(function(){b.textContent="\u29c3 Copy URL";},1500);});}function doRefresh(){var btn=document.getElementById("refBtn");var eu=document.getElementById("existingUrl").value.trim();var cid=document.getElementById("clientId").value.trim();if(!eu){alert("Paste your existing addon URL first.");return;}btn.disabled=true;btn.textContent="Refreshing...";fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu,clientId:cid||null})}).then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="\u21bb Refresh Existing URL";return;}rurl2=d.manifestUrl;document.getElementById("rrurl").textContent=rurl2;document.getElementById("refResult").style.display="block";btn.textContent="\u21bb Refresh Again";btn.disabled=false;}).catch(function(e){alert("Request failed: "+e.message);btn.disabled=false;btn.textContent="\u21bb Refresh Existing URL";});}function copyRefUrl(){if(!rurl2)return;navigator.clipboard.writeText(rurl2).then(function(){var b=document.getElementById("refResult").querySelector(".copy");b.textContent="Copied!";setTimeout(function(){b.textContent="\u29c3 Copy URL";},1500);});}document.getElementById("clientId").addEventListener("keydown",function(e){if(e.key==="Enter")generate();});<\/script></body></html>';
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/refresh', async function(req, res) {
  var raw      = (req.body && req.body.existingUrl) ? String(req.body.existingUrl).trim() : '';
  var clientId = (req.body && req.body.clientId)    ? String(req.body.clientId).trim()    : null;
  var token    = raw;
  var m        = raw.match(/\/u\/([a-f0-9]{28})\//);
  if (m) token = m[1];
  if (!token || !/^[a-f0-9]{28}$/.test(token)) {
    return res.status(400).json({ error: 'Paste your full addon URL (ending in /manifest.json).' });
  }
  var entry = await getTokenEntry(token);
  if (!entry) return res.status(404).json({ error: 'URL not found. It may belong to a different server. Generate a new one.' });
  if (clientId) {
    if (!/^[a-zA-Z0-9]{20,40}$/.test(clientId)) {
      return res.status(400).json({ error: 'Invalid client_id format (20-40 alphanumeric chars).' });
    }
    entry.clientId = clientId;
    TOKEN_CACHE.set(token, entry);
    await redisSave(token, entry);
    console.log('[TOKEN] Refreshed clientId: ' + token.slice(0, 8) + '...');
  } else {
    console.log('[TOKEN] Refreshed (no clientId change): ' + token.slice(0, 8) + '...');
  }
  var manifestUrl = getBaseUrl(req) + '/u/' + token + '/manifest.json';
  res.json({ token: token, manifestUrl: manifestUrl, refreshed: true });
});

app.get('/u/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id:          'com.eclipse.soundcloud.' + req.params.token.slice(0, 8),
    name:        'SoundCloud',
    version:     '3.2.0',
    description: 'SoundCloud search — tracks, albums, artists, and playlists with YouTube fallback.',
    icon:        'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-orange-2xhdpi-a9dce059.png',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist']
  });
});

app.get('/u/:token/search', tokenMiddleware, async function(req, res) {
  var q   = cleanText(req.query.q || '');
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  var cid = effectiveClientId(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id available yet. Retry in a few seconds.', tracks: [] });

  try {
    var results = await Promise.all([
      scGet(cid, 'https://api-v2.soundcloud.com/search/tracks',    { q: q, limit: 15, offset: 0, linked_partitioning: 1 }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/playlists', { q: q, limit: 10, offset: 0 }).catch(function() { return null; }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/users',     { q: q, limit: 5,  offset: 0 }).catch(function() { return null; })
    ]);

    var tracksData    = results[0];
    var playlistsData = results[1];
    var usersData     = results[2];

    var tracks = ((tracksData && tracksData.collection) || [])
      .filter(function(t) { return t.streamable !== false; })
      .map(function(t) {
        rememberTrack(t);
        var meta = parseArtistTitle(t);
        return {
          id:         String(t.id),
          title:      meta.title  || 'Unknown Title',
          artist:     meta.artist || 'Unknown Artist',
          album:      null,
          duration:   t.duration ? Math.floor(t.duration / 1000) : null,
          artworkURL: artworkUrl(t.artwork_url),
          format:     'aac',
          isSnipped:  t.policy === 'SNIP'
        };
      });

    var allPlaylists = (playlistsData && playlistsData.collection) || [];

    var albums = allPlaylists
      .filter(function(p) { return p.is_album === true; })
      .map(function(p) {
        return {
          id:         String(p.id),
          title:      p.title || 'Unknown Album',
          artist:     (p.user && p.user.username) || 'Unknown',
          artworkURL: artworkUrl(p.artwork_url),
          trackCount: p.track_count || null,
          year:       scYear(p)
        };
      });

    var playlists = allPlaylists
      .filter(function(p) { return p.is_album !== true; })
      .map(function(p) {
        return {
          id:         String(p.id),
          title:      p.title || 'Unknown Playlist',
          description: p.description || null,
          artworkURL: artworkUrl(p.artwork_url),
          creator:    (p.user && p.user.username) || null,
          trackCount: p.track_count || null
        };
      });

    var artists = ((usersData && usersData.collection) || []).map(function(u) {
      return {
        id:         String(u.id),
        name:       u.username || 'Unknown',
        artworkURL: artworkUrl(u.avatar_url),
        genres:     u.genre ? [u.genre] : []
      };
    });

    res.json({ tracks: tracks, albums: albums, artists: artists, playlists: playlists });
  } catch (err) {
    console.error('[/search] ' + err.message);
    res.status(500).json({ error: 'Search failed', tracks: [] });
  }
});

app.get('/u/:token/stream/:id', tokenMiddleware, async function(req, res) {
  var cid = effectiveClientId(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id available. Retry in a few seconds.' });

  var trackId = req.params.id;
  var track   = null;
  var cached  = TRACK_CACHE.get(String(trackId)) || null;

  try {
    try { track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/soundcloud:tracks:' + trackId); }
    catch (e) { track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/' + trackId); }
  } catch (err) { console.warn('[/stream] Track lookup failed: ' + err.message); }

  if (track) { rememberTrack(track); cached = TRACK_CACHE.get(String(trackId)) || cached; }

  if (track && track.policy !== 'BLOCK' && track.policy !== 'SNIP') {
    try {
      var transcodings = (track.media && track.media.transcodings) || [];
      var chosen =
        transcodings.find(function(t) { return t.format && t.format.protocol === 'progressive'; }) ||
        transcodings.find(function(t) { return t.format && t.format.protocol === 'hls' && t.format.mime_type && t.format.mime_type.indexOf('aac') !== -1; }) ||
        transcodings.find(function(t) { return t.format && t.format.protocol === 'hls'; }) ||
        transcodings[0];
      if (chosen && chosen.url) {
        var streamData = await scGet(cid, chosen.url);
        if (streamData && streamData.url) {
          var isProg = chosen.format && chosen.format.protocol === 'progressive';
          console.log('[/stream] SoundCloud OK (' + (isProg ? 'progressive' : 'hls') + ') track ' + trackId);
          return res.json({ url: streamData.url, format: (chosen.format && chosen.format.mime_type && chosen.format.mime_type.indexOf('aac') !== -1) ? 'aac' : 'mp3', quality: '160kbps', expiresAt: Math.floor(Date.now() / 1000) + (isProg ? 86400 : 3300) });
        }
      }
    } catch (err) { console.warn('[/stream] SoundCloud stream failed: ' + err.message); }
  }

  var meta = track ? parseArtistTitle(track) : cached;
  if (!meta || !meta.title) return res.status(404).json({ error: 'No stream and no fallback metadata.' });

  var yt = await youtubeFallback(meta.title, meta.artist || meta.uploader || '');
  if (yt) { console.log('[/stream] YouTube fallback OK for "' + meta.title + '"'); return res.json(yt); }

  return res.status(404).json({ error: 'No stream from SoundCloud or YouTube for: ' + (meta.artist ? meta.artist + ' - ' : '') + meta.title });
});

// ─── Album detail ─────────────────────────────────────────────────────────────
app.get('/u/:token/album/:id', tokenMiddleware, async function(req, res) {
  var cid = effectiveClientId(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id available.' });

  try {
    var playlist = await scGet(cid, 'https://api-v2.soundcloud.com/playlists/' + req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Album not found.' });

    var tracks = (playlist.tracks || []).map(function(t) {
      rememberTrack(t);
      var meta = parseArtistTitle(t);
      return {
        id:         String(t.id),
        title:      meta.title  || t.title || 'Unknown',
        artist:     meta.artist || (playlist.user && playlist.user.username) || 'Unknown',
        duration:   t.duration ? Math.floor(t.duration / 1000) : null,
        artworkURL: artworkUrl(t.artwork_url, playlist.artwork_url)
      };
    });

    res.json({
      id:          String(playlist.id),
      title:       playlist.title || 'Unknown Album',
      artist:      (playlist.user && playlist.user.username) || 'Unknown',
      artworkURL:  artworkUrl(playlist.artwork_url),
      year:        scYear(playlist),
      description: playlist.description || null,
      trackCount:  playlist.track_count || tracks.length,
      tracks:      tracks
    });
  } catch (err) {
    console.error('[/album] ' + err.message);
    res.status(500).json({ error: 'Album fetch failed.' });
  }
});

// ─── Artist detail ────────────────────────────────────────────────────────────
app.get('/u/:token/artist/:id', tokenMiddleware, async function(req, res) {
  var cid = effectiveClientId(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id available.' });

  try {
    var results = await Promise.all([
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id),
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id + '/tracks', { limit: 10 }).catch(function() { return null; }),
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id + '/albums',  { limit: 10 }).catch(function() { return null; })
    ]);

    var user       = results[0];
    var tracksData = results[1];
    var albumsData = results[2];

    if (!user) return res.status(404).json({ error: 'Artist not found.' });

    var topTracks = ((tracksData && tracksData.collection) || []).map(function(t) {
      rememberTrack(t);
      var meta = parseArtistTitle(t);
      return {
        id:         String(t.id),
        title:      meta.title  || t.title || 'Unknown',
        artist:     meta.artist || user.username || 'Unknown',
        duration:   t.duration ? Math.floor(t.duration / 1000) : null,
        artworkURL: artworkUrl(t.artwork_url)
      };
    });

    var albums = ((albumsData && albumsData.collection) || []).map(function(p) {
      return {
        id:         String(p.id),
        title:      p.title || 'Unknown',
        artist:     user.username || 'Unknown',
        artworkURL: artworkUrl(p.artwork_url),
        trackCount: p.track_count || null,
        year:       scYear(p)
      };
    });

    res.json({
      id:         String(user.id),
      name:       user.username || 'Unknown',
      artworkURL: artworkUrl(user.avatar_url),
      bio:        user.description || null,
      genres:     user.genre ? [user.genre] : [],
      topTracks:  topTracks,
      albums:     albums
    });
  } catch (err) {
    console.error('[/artist] ' + err.message);
    res.status(500).json({ error: 'Artist fetch failed.' });
  }
});

// ─── Playlist detail ──────────────────────────────────────────────────────────
app.get('/u/:token/playlist/:id', tokenMiddleware, async function(req, res) {
  var cid = effectiveClientId(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id available.' });

  try {
    var playlist = await scGet(cid, 'https://api-v2.soundcloud.com/playlists/' + req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });

    var tracks = (playlist.tracks || []).map(function(t) {
      rememberTrack(t);
      var meta = parseArtistTitle(t);
      return {
        id:         String(t.id),
        title:      meta.title  || t.title || 'Unknown',
        artist:     meta.artist || 'Unknown',
        duration:   t.duration ? Math.floor(t.duration / 1000) : null,
        artworkURL: artworkUrl(t.artwork_url, playlist.artwork_url)
      };
    });

    res.json({
      id:          String(playlist.id),
      title:       playlist.title || 'Unknown Playlist',
      description: playlist.description || null,
      artworkURL:  artworkUrl(playlist.artwork_url),
      creator:     (playlist.user && playlist.user.username) || null,
      tracks:      tracks
    });
  } catch (err) {
    console.error('[/playlist] ' + err.message);
    res.status(500).json({ error: 'Playlist fetch failed.' });
  }
});

app.get('/', function(req, res) {
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function(req, res) {
  var ip     = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  var bucket = getOrCreateIpBucket(ip.split(',')[0].trim());

  if (bucket.count >= MAX_TOKENS_PER_IP) {
    return res.status(429).json({ error: 'Too many tokens created from this IP today. Try again tomorrow.' });
  }

  var clientId = (req.body && req.body.clientId) ? String(req.body.clientId).trim() : null;
  if (clientId && !/^[a-zA-Z0-9]{20,40}$/.test(clientId)) {
    return res.status(400).json({ error: 'Invalid client_id format (must be 20-40 alphanumeric characters).' });
  }

  var token = generateToken();
  var entry = { clientId: clientId || null, createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;

  var manifestUrl = getBaseUrl(req) + '/u/' + token + '/manifest.json';
  console.log('[TOKEN] Created. IP: ' + ip + ' | customId: ' + !!clientId + ' | total cached: ' + TOKEN_CACHE.size);
  res.json({ token: token, manifestUrl: manifestUrl });
});

app.get('/health', function(_req, res) {
  res.json({ status: 'ok', sharedClientIdReady: !!SHARED_CLIENT_ID, redisConnected: !!(redis && redis.status === 'ready'), activeTokens: TOKEN_CACHE.size, timestamp: new Date().toISOString() });
});

app.listen(PORT, function() {
  console.log('Eclipse SoundCloud Addon on port ' + PORT);
});
