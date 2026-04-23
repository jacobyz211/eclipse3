// Eclipse SoundCloud + HiFi Addon — Cloudflare Workers (Hono)
// Converted from Express/Node.js — all Node APIs replaced with Web APIs
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();
app.use('*', cors());

// ─── Constants ───────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_HIFI_INSTANCES = [
  'https://hifi-api-pj08.onrender.com',
  'https://ohio-1.monochrome.tf',
  'https://frankfurt-1.monochrome.tf',
  'https://vogel.qqdl.site',
  'https://tidal-api.binimum.org',
  'https://eu-central.monochrome.tf',
  'https://us-west.monochrome.tf',
  'https://hifi.geeked.wtf',
  'https://monochrome-api.samidy.com',
  'https://hifi-two.spotisaver.net',
  'https://wolf.qqdl.site',
  'https://katze.qqdl.site',
  'https://hund.qqdl.site',
  'https://api.monochrome.tf',
];

// ─── In-memory caches (per isolate) ─────────────────────────────────────────
const TOKEN_CACHE = new Map();  // token -> entry
const TRACK_CACHE = new Map();  // scId  -> meta
const IP_CREATES  = new Map();  // ip    -> { count, resetAt }

const MAX_TOKENS_PER_IP = 10;
const RATE_MAX          = 60;
const RATE_WINDOW_MS    = 60000;

let SHARED_CLIENT_ID = null;
let SC_FETCH_PENDING = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function encodeBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  try { return atob(b64); } catch { return '{}'; }
}

function generateToken() {
  const arr = new Uint8Array(14);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function artworkUrl(raw, fb) {
  const s = raw || fb || '';
  return s ? s.replace('-large', '-t500x500') : null;
}

function scYear(x) {
  return (x.release_date || x.created_at || '').slice(0, 4) || null;
}

function parseArtistTitle(track) {
  const raw  = cleanText(track && track.title);
  const meta = cleanText(
    (track && track.publisher_metadata &&
     (track.publisher_metadata.artist || track.publisher_metadata.writer_composer)) || ''
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
    id:       String(t.id),
    artist:   m.artist,
    title:    m.title,
    rawTitle: m.rawTitle,
    uploader: m.uploader
  });
}

function getBaseUrl(c) {
  const proto = c.req.header('x-forwarded-proto') || 'https';
  return proto + '://' + c.req.header('host');
}

function effectiveCid(entry, env) {
  return (entry && entry.clientId) ? entry.clientId : (env.SC_CLIENT_ID || SHARED_CLIENT_ID);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Upstash Redis (HTTP — works in CF Workers) ───────────────────────────────
// Set REDIS_URL + REDIS_TOKEN env vars to enable persistence.
// REDIS_URL should be your Upstash REST URL: https://xxx.upstash.io
async function redisCmd(env, ...args) {
  if (!env.REDIS_URL || !env.REDIS_TOKEN) return null;
  try {
    const r = await fetch(env.REDIS_URL + '/' + args.map(encodeURIComponent).join('/'), {
      headers: { Authorization: 'Bearer ' + env.REDIS_TOKEN }
    });
    const j = await r.json();
    return j.result !== undefined ? j.result : null;
  } catch { return null; }
}

async function redisGet(env, key) {
  return redisCmd(env, 'GET', key);
}

async function redisSet(env, key, value, ex) {
  if (ex) return redisCmd(env, 'SET', key, value, 'EX', String(ex));
  return redisCmd(env, 'SET', key, value);
}

async function redisDel(env, key) {
  return redisCmd(env, 'DEL', key);
}

// ─── Token store ─────────────────────────────────────────────────────────────
async function redisSave(env, token, entry) {
  await redisSet(env, 'sc:token:' + token, JSON.stringify({
    clientId:  entry.clientId,
    createdAt: entry.createdAt,
    lastUsed:  entry.lastUsed,
    reqCount:  entry.reqCount
  }));
}

async function getTokenEntry(env, token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  // Try Redis first
  const saved = await redisGet(env, 'sc:token:' + token);
  if (saved) {
    try {
      const d = JSON.parse(saved);
      const entry = { ...d, rateWin: [] };
      TOKEN_CACHE.set(token, entry);
      return entry;
    } catch { }
  }
  // Workers are stateless — TOKEN_CACHE is lost between isolates.
  // Without Redis, any well-formed token is trusted (no persistent store available).
  // Token format: 28 hex chars generated by crypto.getRandomValues
  if (/^[a-f0-9]{28}$/.test(token)) {
    const fresh = { clientId: null, createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
    TOKEN_CACHE.set(token, fresh);
    return fresh;
  }
  return null;
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

function getOrCreateIpBucket(ip) {
  const now = Date.now();
  let b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 86400000 };
    IP_CREATES.set(ip, b);
  }
  return b;
}

// ─── tokenMiddleware as a helper (Hono doesn't use next() style middleware per-route easily) ──
async function withToken(c, fn) {
  const token = c.req.param('token');
  const entry = await getTokenEntry(c.env, token);
  if (!entry) return c.json({ error: 'Invalid token.' }, 404);
  if (!checkRateLimit(entry)) return c.json({ error: 'Rate limit exceeded.' }, 429);
  if (entry.reqCount % 20 === 0) redisSave(c.env, token, entry).catch(() => {});
  return fn(entry);
}

// ─── HTTP fetch helper (replaces axios) ──────────────────────────────────────
async function httpGet(url, params, headers, timeout) {
  const u = new URL(url);
  if (params) Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout || 15000);
  try {
    const r = await fetch(u.toString(), {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', ...(headers || {}) },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function httpGetText(url, headers, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout || 15000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', ...(headers || {}) },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    return r.ok ? r.text() : null;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

async function httpPost(url, body, headers, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout || 15000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...(headers || {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── HiFi client ─────────────────────────────────────────────────────────────
async function hifiGet(env, path, params) {
  const instances = env.HIFI_INSTANCES
    ? env.HIFI_INSTANCES.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_HIFI_INSTANCES;
  const errors = [];
  for (const inst of instances) {
    try {
      const data = await httpGet(inst + path, params || {});
      if (data) return data;
    } catch (e) {
      errors.push(inst + ': ' + e.message);
    }
  }
  throw new Error('All HiFi instances failed: ' + errors.slice(-2).join(' | '));
}

async function hifiGetSafe(env, path, params) {
  try { return await hifiGet(env, path, params); } catch { return null; }
}

async function hifiFindBestTrack(env, meta, albumName) {
  if (!meta || !meta.title) return null;
  const baseTitle  = meta.title;
  const baseArtist = meta.artist || meta.uploader || '';
  const queries    = [];
  if (baseArtist) {
    queries.push(baseArtist + ' ' + baseTitle);
    queries.push(baseTitle + ' ' + baseArtist);
  }
  queries.push(baseTitle);
  if (albumName) queries.push(baseTitle + ' ' + albumName);

  const norm = str => String(str || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const wantTitle  = norm(baseTitle);
  const wantArtist = norm(baseArtist);

  for (const q of queries) {
    try {
      const sData = await hifiGetSafe(env, '/search/', { s: q, limit: 5, offset: 0 });
      if (!sData) continue;
      let items = [];
      if (sData.data && Array.isArray(sData.data.items)) items = sData.data.items;
      else if (Array.isArray(sData.items))               items = sData.items;
      else if (Array.isArray(sData.data))                items = sData.data;
      if (!items.length) continue;

      const ranked = items.slice().sort((a, b) => {
        const score = (item) => {
          const t = norm(item.title);
          const ar = norm((item.artist && item.artist.name) || (item.artists && item.artists[0] && item.artists[0].name) || '');
          let s = 0;
          if (t === wantTitle) s += 5;
          if (wantArtist && ar === wantArtist) s += 5;
          if (wantTitle && t.includes(wantTitle)) s += 2;
          if (wantArtist && ar.includes(wantArtist)) s += 2;
          return s;
        };
        return score(b) - score(a);
      });

      const best = ranked[0];
      if (!best) continue;
      const bestTitle  = norm(best.title);
      const bestArtist = norm((best.artist && best.artist.name) || (best.artists && best.artists[0] && best.artists[0].name) || '');
      const titleGood  = wantTitle && (bestTitle === wantTitle || bestTitle.includes(wantTitle));
      const artistGood = !wantArtist || (bestArtist && (bestArtist === wantArtist || bestArtist.includes(wantArtist)));
      if (wantArtist ? (titleGood && artistGood) : bestTitle === wantTitle) return best;
    } catch { }
  }
  return null;
}

// ─── SoundCloud client_id ─────────────────────────────────────────────────────
const ID_PATTERNS = [
  /client_id\s*[=:,]\s*["']([a-zA-Z0-9]{32})["']/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /client_id=([a-zA-Z0-9]{32})[&"'\s,)]/
];

function findId(text) {
  for (const p of ID_PATTERNS) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

async function tryExtract() {
  for (const pu of ['https://soundcloud.com', 'https://soundcloud.com/discover']) {
    const html = await httpGetText(pu);
    if (!html || html.length < 5000) continue;
    for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      const id = findId(m[1] || '');
      if (id) return id;
    }
    const urls = Array.from(new Set([
      ...Array.from(html.matchAll(/https?:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9.\-]+\.js/g)).map(x => x[0]),
      ...Array.from(html.matchAll(/src="([^"]+\.js)"/g)).map(x => x[1])
    ])).reverse().slice(0, 10);
    for (const u of urls) {
      const js = await httpGetText(u);
      if (!js) continue;
      const bid = findId(js);
      if (bid) return bid;
    }
  }
  return null;
}

async function fetchSharedClientId(env) {
  if (env.SC_CLIENT_ID) { SHARED_CLIENT_ID = env.SC_CLIENT_ID; return; }
  if (SC_FETCH_PENDING) return;
  SC_FETCH_PENDING = true;

  // Try Redis first
  const cached = await redisGet(env, 'sc:shared_client_id');
  if (cached) { SHARED_CLIENT_ID = cached; SC_FETCH_PENDING = false; return; }

  const delays = [5000, 10000, 15000, 30000, 60000];
  let attempt = 0;
  while (attempt < 5) {
    attempt++;
    try {
      const id = await tryExtract();
      if (!id) throw new Error('not found');
      SHARED_CLIENT_ID = id;
      SC_FETCH_PENDING = false;
      await redisSet(env, 'sc:shared_client_id', id, 18000);
      return;
    } catch {
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
    }
  }
  SC_FETCH_PENDING = false;
}

async function scGet(cid, url, params, retried) {
  if (!cid) throw new Error('No client_id');
  const data = await httpGet(url, { ...params, client_id: cid });
  return data;
}

async function resolveStubs(cid, tracks, fbArt) {
  const stubs = tracks.filter(t => !t.title).map(t => t.id);
  const map   = {};
  for (let i = 0; i < stubs.length; i += 50) {
    try {
      const data = await scGet(cid, 'https://api-v2.soundcloud.com/tracks', { ids: stubs.slice(i, i + 50).join(',') });
      const arr = Array.isArray(data) ? data : data.collection ? data.collection : [];
      arr.forEach(t => { map[String(t.id)] = t; });
    } catch { }
  }
  return tracks.map(t => map[String(t.id)] || t).filter(t => !!t.title);
}

// ─── YTM playlist import ──────────────────────────────────────────────────────
async function importYtmPlaylist(playlistId) {
  const cleanId  = playlistId.replace(/^VL/, '');
  const browseId = 'VL' + cleanId;
  const YT_KEY    = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-KOUN-VSxU';
  const YT_CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00' };
  const YT_HEADERS = {
    'User-Agent':   UA,
    'Content-Type': 'application/json',
    'Accept':       'application/json',
    'Origin':       'https://music.youtube.com',
    'Referer':      'https://music.youtube.com/'
  };

  function extractItems(data) {
    const items = [];
    let continuation = null;
    function walk(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(walk); return; }
      if (obj.musicResponsiveListItemRenderer) {
        const r     = obj.musicResponsiveListItemRenderer;
        const cols  = r.flexColumns || [];
        const title = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || null;
        const artist = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || 'Unknown';
        let duration = null;
        const dRun = (r.fixedColumns || [])[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text;
        if (dRun) {
          const parts = dRun.split(':').map(Number);
          if (parts.length === 2) duration = parts[0] * 60 + parts[1];
          if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        const videoId = r.playlistItemData?.videoId ||
          r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId || null;
        const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
        const thumb  = thumbs?.length ? thumbs[thumbs.length - 1].url : null;
        if (title && videoId) items.push({ id: 'ytm-' + videoId, title, artist, duration, artworkURL: thumb });
        return;
      }
      if (obj.continuationItemRenderer) {
        const token = obj.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || null;
        if (token) continuation = token;
        return;
      }
      for (const key of Object.keys(obj)) walk(obj[key]);
    }
    walk(data);
    return { items, continuation };
  }

  function extractMeta(data) {
    let title = 'YouTube Music Playlist', creator = 'YouTube Music', artwork = null;
    function walk(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(walk); return; }
      const hdr = obj.musicImmersiveHeaderRenderer || obj.musicDetailHeaderRenderer ||
        obj.musicEditablePlaylistDetailHeaderRenderer?.header?.musicImmersiveHeaderRenderer ||
        obj.musicEditablePlaylistDetailHeaderRenderer?.header?.musicDetailHeaderRenderer;
      if (hdr) {
        if (hdr.title?.runs?.[0]?.text)   title   = hdr.title.runs[0].text;
        if (hdr.subtitle?.runs)           creator = hdr.subtitle.runs.map(r => r.text || '').join('');
        const tn = hdr.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
        if (tn?.length) artwork = tn[tn.length - 1].url;
        return;
      }
      for (const key of Object.keys(obj)) walk(obj[key]);
    }
    walk(data);
    return { title, creator, artwork };
  }

  const initRes = await httpPost(
    'https://music.youtube.com/youtubei/v1/browse?key=' + YT_KEY,
    { browseId, context: { client: YT_CLIENT } },
    YT_HEADERS
  );
  const meta   = extractMeta(initRes);
  const first  = extractItems(initRes);
  const tracks = [...first.items];
  let cont     = first.continuation;
  let guard    = 200;
  while (cont && guard-- > 0) {
    try {
      const pageRes = await httpPost(
        'https://music.youtube.com/youtubei/v1/browse?key=' + YT_KEY,
        { continuation: cont, context: { client: YT_CLIENT } },
        YT_HEADERS
      );
      const page = extractItems(pageRes);
      tracks.push(...page.items);
      cont = page.continuation || null;
    } catch { break; }
  }
  if (!tracks.length) throw new Error('No tracks found. Make sure the playlist is Public.');
  return { id: 'ytm-' + cleanId, title: meta.title, artworkURL: meta.artwork, creator: meta.creator, tracks };
}

// ─── SC playlist import ───────────────────────────────────────────────────────
function detectUrlType(url) {
  if (!url) return null;
  if (/soundcloud\.com\/.*\/sets\//.test(url)) return 'scplaylist';
  if (/on\.soundcloud\.com\//.test(url))        return 'scplaylist-short';
  if (/snd\.sc\//.test(url))                    return 'scplaylist-short';
  if (/music\.youtube\.com|youtube\.com.*\?list=/.test(url)) return 'ytmplaylist';
  if (/music\.youtube\.com\/browse\/VL/.test(url))            return 'ytmplaylist';
  return null;
}

function extractYtmId(url) {
  const browse = url.match(/browse\/VL([a-zA-Z0-9_-]+)/);
  if (browse) return browse[1];
  const m = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function expandScShortUrl(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA } });
    return r.url || url;
  } catch { return url; }
}

async function importScPlaylist(cid, scUrl) {
  if (/on\.soundcloud\.com/.test(scUrl) || /snd\.sc/.test(scUrl)) {
    scUrl = await expandScShortUrl(scUrl);
  }
  const res = await scGet(cid, 'https://api-v2.soundcloud.com/resolve', { url: scUrl });
  if (!res) throw new Error('Could not resolve SoundCloud URL');
  if (res.kind !== 'playlist') throw new Error('Not a playlist (kind=' + res.kind + ')');
  const resolved = await resolveStubs(cid, res.tracks || [], res.artwork_url);
  return {
    id:         String(res.id),
    title:      res.title || 'Imported',
    artworkURL: artworkUrl(res.artwork_url),
    creator:    (res.user && res.user.username) || null,
    tracks:     resolved.map(t => {
      rememberTrack(t);
      const m = parseArtistTitle(t);
      return {
        id:         String(t.id),
        title:      m.title || t.title || 'Unknown',
        artist:     m.artist || (res.user && res.user.username) || 'Unknown',
        duration:   t.duration ? Math.floor(t.duration / 1000) : null,
        artworkURL: artworkUrl(t.artwork_url, res.artwork_url)
      };
    })
  };
}

// ─── Config page ──────────────────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
  let h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>SoundCloud + HiFi Addon</title>';
  h += '<style>*{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#0f0f0f;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.card{background:#161616;border:1px solid #232323;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5);margin-bottom:20px}';
  h += 'h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}';
  h += 'p.sub{font-size:14px;color:#777;margin-bottom:20px;line-height:1.6}';
  h += '.tip{background:#0d1f0d;border:1px solid #1a3a1a;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#5a9e5a;line-height:1.7}.tip b{color:#7cc97c}';
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
  h += '.status{font-size:13px;color:#666;margin:8px 0;min-height:18px}.status.ok{color:#5a9e5a}.status.err{color:#c0392b}';
  h += '.preview{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:10px;padding:12px;max-height:200px;overflow-y:auto;margin-bottom:12px;display:none}';
  h += '.tr{display:flex;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid #181818;font-size:13px}.tr:last-child{border-bottom:none}';
  h += '.tn{color:#444;font-size:11px;min-width:22px;text-align:right}.ti{flex:1;min-width:0}.tt{color:#e8e8e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ta{color:#666;font-size:11px}';
  h += 'footer{margin-top:32px;font-size:12px;color:#333;text-align:center;line-height:1.8}</style></head><body>';
  h += '<svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="margin-bottom:20px"><circle cx="26" cy="26" r="26" fill="#f50"/><path d="M15 30c0-2.4 2-4.4 4.4-4.4s4.4 2 4.4 4.4" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="M10.5 30c0-4.9 4-8.9 8.9-8.9s8.9 4 8.9 8.9" stroke="#fff" stroke-width="2.5" stroke-linecap="round" opacity=".55"/><rect x="30" y="21" width="3.5" height="17" rx="1.75" fill="#fff"/><rect x="35.5" y="18" width="3.5" height="20" rx="1.75" fill="#fff"/><rect x="41" y="23" width="3.5" height="15" rx="1.75" fill="#fff"/></svg>';
  h += '<div class="card"><h1>SoundCloud for Eclipse</h1>';
  h += '<div class="tip"><b>Save your URL.</b> Copy it to Notes or a bookmark. If the server restarts, paste it below to keep all playlists working.</div>';
  h += '<p class="sub">All SoundCloud tracks show in search. Streams prefer HiFi (monochrome.tf) and fall back to SoundCloud if needed.</p>';
  h += '<div class="lbl">SoundCloud Client ID <span style="color:#3a3a3a;font-weight:400;text-transform:none">(optional)</span></div>';
  h += '<input type="text" id="clientId" placeholder="Leave blank to use the shared auto-refreshed ID">';
  h += '<div class="hint">Want your own? Open <a href="https://soundcloud.com" target="_blank">soundcloud.com</a>, press <code>F12</code> → Network, filter <code>api-v2</code>, copy <code>client_id</code>.</div>';
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
  h += '</div><div class="warn">Tokens are stored in Redis (Upstash) and survive restarts. HiFi uses community-hosted instances; if they are down, playback falls back to SoundCloud.</div></div>';
  h += '<div class="card"><h2>Import SoundCloud or YouTube Music Playlist</h2>';
  h += '<p class="sub">Downloads a CSV you can import in Eclipse via Library → Import CSV.</p>';
  h += '<div class="lbl">Your Addon URL</div>';
  h += '<input type="text" id="impToken" placeholder="Paste your addon URL (auto-fills after generating)">';
  h += '<div class="lbl">Playlist URL</div>';
  h += '<input type="text" id="impUrl" placeholder="soundcloud.com/artist/sets/name or music.youtube.com/playlist?list=...">';
  h += '<div class="status" id="impStatus"></div>';
  h += '<div class="preview" id="impPreview"></div>';
  h += '<button class="bg" id="impBtn" onclick="doImport()">Fetch &amp; Download CSV</button></div>';
  h += '<footer>Eclipse SoundCloud + HiFi Addon v4.0.0 — <a href="' + baseUrl + '/health" target="_blank" style="color:#333">' + baseUrl + '</a></footer>';
  h += '<script>';
  h += 'var _gu="",_ru="";';
  h += 'function generate(){var btn=document.getElementById("genBtn"),cid=document.getElementById("clientId").value.trim();btn.disabled=true;btn.textContent="Generating...";';
  h += 'fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId:cid||null})}).then(r=>r.json()).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}';
  h += '_gu=d.manifestUrl;document.getElementById("genUrl").textContent=_gu;document.getElementById("genBox").style.display="block";document.getElementById("impToken").value=_gu;btn.disabled=false;btn.textContent="Regenerate URL";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});}';
  h += 'function copyGen(){if(!_gu)return;navigator.clipboard.writeText(_gu).then(function(){var b=document.getElementById("copyGenBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
  h += 'function doRefresh(){var btn=document.getElementById("refBtn"),eu=document.getElementById("existingUrl").value.trim(),cid=document.getElementById("clientId").value.trim();if(!eu){alert("Paste your existing addon URL first.");return;}btn.disabled=true;btn.textContent="Refreshing...";';
  h += 'fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu,clientId:cid||null})}).then(r=>r.json()).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Refresh Existing URL";return;}';
  h += '_ru=d.manifestUrl;document.getElementById("refUrl").textContent=_ru;document.getElementById("refBox").style.display="block";document.getElementById("impToken").value=_ru;btn.disabled=false;btn.textContent="Refresh Again";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Refresh Existing URL";});}';
  h += 'function copyRef(){if(!_ru)return;navigator.clipboard.writeText(_ru).then(function(){var b=document.getElementById("copyRefBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
  h += 'function getTok(s){var m=s.match(/\\/u\\/([a-f0-9]{28})\\//);return m?m[1]:null;}';
  h += 'function hesc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}';
  h += 'function doImport(){var btn=document.getElementById("impBtn"),raw=document.getElementById("impToken").value.trim(),purl=document.getElementById("impUrl").value.trim(),st=document.getElementById("impStatus"),pv=document.getElementById("impPreview");';
  h += 'if(!raw){st.className="status err";st.textContent="Paste your addon URL first.";return;}if(!purl){st.className="status err";st.textContent="Paste a playlist URL.";return;}';
  h += 'var tok=getTok(raw);if(!tok){st.className="status err";st.textContent="Could not find your token in the URL.";return;}btn.disabled=true;btn.textContent="Fetching...";st.className="status";st.textContent="Fetching tracks...";pv.style.display="none";';
  h += 'fetch("/u/"+tok+"/import?url="+encodeURIComponent(purl)).then(function(r){if(!r.ok){return r.json().then(function(e){throw new Error(e.error||("Server error "+r.status));});}return r.json();}).then(function(data){var tracks=data.tracks||[];if(!tracks.length)throw new Error("No tracks found.");';
  h += 'var rows=tracks.slice(0,50).map(function(t,i){return \'<div class="tr"><span class="tn">\'+(i+1)+\'</span><div class="ti"><div class="tt">\'+hesc(t.title)+\'</div><div class="ta">\'+hesc(t.artist||"")+\'</div></div></div>\';});';
  h += 'if(tracks.length>50)rows.push(\'<div class="tr" style="text-align:center;color:#555"><span class="tn"></span><div class="ti"><div class="tt">\'+hesc((tracks.length-50)+" more...")+\'</div></div></div>\');';
  h += 'pv.innerHTML=rows.join("");pv.style.display="block";st.className="status ok";st.textContent="Found "+tracks.length+" tracks in "+(data.title||"playlist")+". Downloading CSV...";';
  h += 'var SEP=",";function ce(s){return "\\""+String(s==null?"":s).replace(/"/g,\'\\\\"\')+"\\""}var lines=[["Track URI","Track Name","Album Name","Artist Name(s)","Release Date","Duration (ms)","Popularity","Explicit","Added By","Added At","Genres","Record Label","Danceability","Energy","Key","Loudness","Mode","Speechiness","Acousticness","Instrumentalness","Liveness","Valence","Tempo","Time Signature"].map(function(h){return ce(h);}).join(SEP)];tracks.forEach(function(t){var dur=t.duration?Math.round(t.duration*1000):0;lines.push([ce(""),ce(t.title),ce(t.artist||""),ce(data.title||""),ce(""),ce(dur),ce(0),ce("false"),ce(""),ce(""),ce(""),ce(""),ce(""),ce(""),ce(""),ce(""),ce(""),ce(""),ce(""),ce(""),ce(""),ce(""),ce(""),ce("")].join(SEP));});';
  h += 'var blob=new Blob([lines.join("\\r\\n")],{type:"text/csv;charset=utf-8;"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(data.title||"playlist").replace(/[^a-zA-Z0-9 \\-_\\.]/g,"").trim()+".csv";document.body.appendChild(a);a.click();document.body.removeChild(a);';
  h += 'btn.disabled=false;btn.textContent="Fetch & Download CSV";}).catch(function(e){st.className="status err";st.textContent=e.message;btn.disabled=false;btn.textContent="Fetch & Download CSV";});}';
  h += '</script></body></html>';
  return h;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', c => c.html(buildConfigPage(getBaseUrl(c))));

app.post('/generate', async c => {
  const ip     = (c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown').split(',')[0].trim();
  const bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) return c.json({ error: 'Too many tokens today from this IP.' }, 429);

  const b   = await c.req.json().catch(() => ({}));
  const cid = b.clientId ? String(b.clientId).trim() : null;
  if (cid && !/^[a-zA-Z0-9]{20,40}$/.test(cid)) return c.json({ error: 'Invalid client_id.' }, 400);

  const token = generateToken();
  const entry = { clientId: cid || null, createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(c.env, token, entry);
  bucket.count++;

  // Kick off SC client ID fetch in background if needed
  if (!SHARED_CLIENT_ID && !c.env.SC_CLIENT_ID) {
    c.executionCtx.waitUntil(fetchSharedClientId(c.env));
  }

  return c.json({ token, manifestUrl: getBaseUrl(c) + '/u/' + token + '/manifest.json' });
});

app.post('/refresh', async c => {
  const b   = await c.req.json().catch(() => ({}));
  const raw = b.existingUrl ? String(b.existingUrl).trim() : '';
  const cid = b.clientId   ? String(b.clientId).trim()    : null;
  let token = raw;
  const m   = raw.match(/\/u\/([a-f0-9]{28})\//);
  if (m) token = m[1];
  if (!token || !/^[a-f0-9]{28}$/.test(token)) return c.json({ error: 'Paste your full addon URL.' }, 400);
  const entry = await getTokenEntry(c.env, token);
  if (!entry) return c.json({ error: 'URL not found. Generate a new one.' }, 404);
  if (cid) {
    if (!/^[a-zA-Z0-9]{20,40}$/.test(cid)) return c.json({ error: 'Invalid client_id.' }, 400);
    entry.clientId = cid;
    TOKEN_CACHE.set(token, entry);
    await redisSave(c.env, token, entry);
  }
  return c.json({ token, manifestUrl: getBaseUrl(c) + '/u/' + token + '/manifest.json', refreshed: true });
});

app.get('/health', c => c.json({
  status:              'ok',
  version:             '4.0.0',
  sharedClientIdReady: !!SHARED_CLIENT_ID,
  redisConfigured:     !!(c.env.REDIS_URL && c.env.REDIS_TOKEN),
  timestamp:           new Date().toISOString()
}));

// Manifest
app.get('/u/:token/manifest.json', async c =>
  withToken(c, () => c.json({
    id:          'com.eclipse.soundcloud.' + c.req.param('token').slice(0, 8),
    name:        'SoundCloud',
    version:     '4.0.0',
    description: 'SoundCloud search with HiFi (monochrome.tf) streams first, then SoundCloud fallback.',
    icon:        'https://files.softicons.com/download/social-media-icons/simple-icons-by-dan-leech/png/128x128/soundcloud.png',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist']
  }))
);

// Search
app.get('/u/:token/search', async c =>
  withToken(c, async entry => {
    const q = cleanText(c.req.query('q'));
    if (!q) return c.json({ tracks: [], albums: [], artists: [], playlists: [] });

    if (!SHARED_CLIENT_ID && !c.env.SC_CLIENT_ID) {
      await fetchSharedClientId(c.env);
    }
    const cid = effectiveCid(entry, c.env);
    if (!cid) return c.json({ error: 'No client_id yet. Retry in a few seconds.' }, 503);

    try {
      const [trackRes, plRes, userRes] = await Promise.all([
        scGet(cid, 'https://api-v2.soundcloud.com/search/tracks',    { q, limit: 20, offset: 0, linked_partitioning: 1 }).catch(() => null),
        scGet(cid, 'https://api-v2.soundcloud.com/search/playlists', { q, limit: 10, offset: 0 }).catch(() => null),
        scGet(cid, 'https://api-v2.soundcloud.com/search/users',     { q, limit: 5,  offset: 0 }).catch(() => null)
      ]);
      const allPl = (plRes && plRes.collection) || [];
      const tracks = ((trackRes && trackRes.collection) || []).map(t => {
        rememberTrack(t);
        const m = parseArtistTitle(t);
        return { id: String(t.id), title: m.title || 'Unknown', artist: m.artist || 'Unknown', album: null, duration: t.duration ? Math.floor(t.duration / 1000) : null, artworkURL: artworkUrl(t.artwork_url), format: 'aac' };
      });
      const albums    = allPl.filter(p => p.is_album).map(p => ({ id: String(p.id), title: p.title || 'Unknown', artist: (p.user && p.user.username) || 'Unknown', artworkURL: artworkUrl(p.artwork_url), trackCount: p.track_count || null, year: scYear(p) }));
      const playlists = allPl.filter(p => !p.is_album).map(p => ({ id: String(p.id), title: p.title || 'Unknown', description: p.description || null, artworkURL: artworkUrl(p.artwork_url), creator: (p.user && p.user.username) || null, trackCount: p.track_count || null }));
      const artists   = ((userRes && userRes.collection) || []).map(u => ({ id: String(u.id), name: u.username || 'Unknown', artworkURL: artworkUrl(u.avatar_url), genres: u.genre ? [u.genre] : [] }));
      return c.json({ tracks, albums, artists, playlists });
    } catch (e) {
      return c.json({ error: 'Search failed.', tracks: [] }, 500);
    }
  })
);

// Stream
app.get('/u/:token/stream/:id', async c =>
  withToken(c, async entry => {
    const cid = effectiveCid(entry, c.env);
    const tid = c.req.param('id');
    if (!cid) return c.json({ error: 'No client_id available.' }, 503);

    let track = null;
    const cached = TRACK_CACHE.get(String(tid)) || null;
    try {
      try { track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/soundcloud:tracks:' + tid); }
      catch { track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/' + tid); }
    } catch { }
    if (track) rememberTrack(track);

    const meta = cached || (track ? parseArtistTitle(track) : null);
    const albumName = track && track.publisher_metadata && track.publisher_metadata.release_title
      ? track.publisher_metadata.release_title : null;

    // 1) HiFi first
    try {
      const best = await hifiFindBestTrack(c.env, meta, albumName);
      if (best && best.id) {
        for (const ql of ['LOSSLESS', 'HIGH', 'LOW']) {
          try {
            const data    = await hifiGet(c.env, '/track/', { id: best.id, quality: ql });
            const payload = (data && data.data) ? data.data : data;
            if (payload && payload.manifest) {
              const decoded = JSON.parse(atob(payload.manifest));
              const url   = (decoded.urls && decoded.urls[0]) || null;
              const codec = decoded.codecs || decoded.mimeType || '';
              if (url) {
                const isFlac = codec && (codec.includes('flac') || codec.includes('audio/flac'));
                return c.json({ url, format: isFlac ? 'flac' : 'aac', quality: ql === 'LOSSLESS' ? 'lossless' : (ql === 'HIGH' ? '320kbps' : '128kbps'), expiresAt: Math.floor(Date.now() / 1000) + 21600 });
              }
            }
            if (payload && payload.url) return c.json({ url: payload.url, format: 'aac', quality: 'lossless', expiresAt: Math.floor(Date.now() / 1000) + 21600 });
          } catch { }
        }
      }
    } catch { }

    // 2) SoundCloud fallback
    if (track) {
      const tc = (track.media && track.media.transcodings) || [];
      async function resolveTranscoding(transcoding) {
        const sd = await scGet(cid, transcoding.url);
        if (!sd || !sd.url) return null;
        const mime = (transcoding.format && transcoding.format.mime_type) || '';
        return { url: sd.url, format: mime.includes('aac') ? 'aac' : 'mp3', quality: '160kbps', expiresAt: Math.floor(Date.now() / 1000) + 86400 };
      }
      const progressive = tc.find(t => t.format && t.format.protocol === 'progressive');
      if (progressive) { try { const r = await resolveTranscoding(progressive); if (r) return c.json(r); } catch { } }
      const hls = tc.find(t => t.format && t.format.protocol === 'hls');
      if (hls) { try { const r = await resolveTranscoding(hls); if (r) return c.json({ ...r, isHls: true }); } catch { } }
    }

    return c.json({ error: 'No stream found for track ' + tid }, 404);
  })
);

// Album
app.get('/u/:token/album/:id', async c =>
  withToken(c, async entry => {
    const cid = effectiveCid(entry, c.env);
    if (!cid) return c.json({ error: 'No client_id.' }, 503);
    try {
      const pl = await scGet(cid, 'https://api-v2.soundcloud.com/playlists/' + c.req.param('id'));
      if (!pl) return c.json({ error: 'Album not found.' }, 404);
      const resolved = await resolveStubs(cid, pl.tracks || [], pl.artwork_url);
      return c.json({
        id: String(pl.id), title: pl.title || 'Unknown', artist: (pl.user && pl.user.username) || 'Unknown',
        artworkURL: artworkUrl(pl.artwork_url), year: scYear(pl), description: pl.description || null, trackCount: resolved.length,
        tracks: resolved.map((t, i) => { rememberTrack(t); const m = parseArtistTitle(t); return { id: String(t.id), title: m.title || t.title || 'Unknown', artist: m.artist || (pl.user && pl.user.username) || 'Unknown', duration: t.duration ? Math.floor(t.duration / 1000) : null, trackNumber: t.track_number || (i + 1), artworkURL: artworkUrl(t.artwork_url, pl.artwork_url) }; })
      });
    } catch { return c.json({ error: 'Album fetch failed.' }, 500); }
  })
);

// Artist
app.get('/u/:token/artist/:id', async c =>
  withToken(c, async entry => {
    const cid = effectiveCid(entry, c.env);
    if (!cid) return c.json({ error: 'No client_id.' }, 503);
    try {
      const [user, trRes, plRes] = await Promise.all([
        scGet(cid, 'https://api-v2.soundcloud.com/users/' + c.req.param('id')),
        scGet(cid, 'https://api-v2.soundcloud.com/users/' + c.req.param('id') + '/tracks',    { limit: 10 }).catch(() => null),
        scGet(cid, 'https://api-v2.soundcloud.com/users/' + c.req.param('id') + '/playlists', { limit: 20 }).catch(() => null)
      ]);
      if (!user) return c.json({ error: 'Artist not found.' }, 404);
      const resolved  = await resolveStubs(cid, (trRes && trRes.collection) || [], null);
      const topTracks = resolved.map(t => { rememberTrack(t); const m = parseArtistTitle(t); return { id: String(t.id), title: m.title || t.title || 'Unknown', artist: m.artist || user.username || 'Unknown', duration: t.duration ? Math.floor(t.duration / 1000) : null, artworkURL: artworkUrl(t.artwork_url) }; });
      const albums    = ((plRes && plRes.collection) || []).filter(p => p.is_album).map(p => ({ id: String(p.id), title: p.title || 'Unknown', artist: user.username || 'Unknown', artworkURL: artworkUrl(p.artwork_url), trackCount: p.track_count || null, year: scYear(p) }));
      return c.json({ id: String(user.id), name: user.username || 'Unknown', artworkURL: artworkUrl(user.avatar_url), bio: user.description || null, genres: user.genre ? [user.genre] : [], topTracks, albums });
    } catch { return c.json({ error: 'Artist fetch failed.' }, 500); }
  })
);

// Playlist
app.get('/u/:token/playlist/:id', async c =>
  withToken(c, async entry => {
    const rawId = c.req.param('id');
    if (rawId.startsWith('ytm-')) {
      try { return c.json(await importYtmPlaylist(rawId.replace(/^ytm-/, ''))); }
      catch (e) { return c.json({ error: 'YTM playlist failed: ' + e.message }, 500); }
    }
    const cid = effectiveCid(entry, c.env);
    if (!cid) return c.json({ error: 'No client_id.' }, 503);
    try {
      const pl = await scGet(cid, 'https://api-v2.soundcloud.com/playlists/' + rawId);
      if (!pl) return c.json({ error: 'Playlist not found.' }, 404);
      const resolved = await resolveStubs(cid, pl.tracks || [], pl.artwork_url);
      return c.json({
        id: String(pl.id), title: pl.title || 'Unknown', description: pl.description || null,
        artworkURL: artworkUrl(pl.artwork_url), creator: (pl.user && pl.user.username) || null,
        tracks: resolved.map(t => { rememberTrack(t); const m = parseArtistTitle(t); return { id: String(t.id), title: m.title || t.title || 'Unknown', artist: m.artist || (pl.user && pl.user.username) || 'Unknown', duration: t.duration ? Math.floor(t.duration / 1000) : null, artworkURL: artworkUrl(t.artwork_url, pl.artwork_url) }; })
      });
    } catch { return c.json({ error: 'Playlist fetch failed.' }, 500); }
  })
);

// Import
app.get('/u/:token/import', async c =>
  withToken(c, async entry => {
    const cid      = effectiveCid(entry, c.env);
    const inputUrl = cleanText(c.req.query('url'));
    if (!inputUrl) return c.json({ error: 'Pass ?url with a playlist URL.' }, 400);
    const type = detectUrlType(inputUrl);
    if (type === 'scplaylist' || type === 'scplaylist-short') {
      if (!cid) return c.json({ error: 'No SoundCloud client_id yet.' }, 503);
      try { return c.json(await importScPlaylist(cid, inputUrl)); }
      catch (e) { return c.json({ error: 'SoundCloud import failed: ' + e.message }, 500); }
    }
    if (type === 'ytmplaylist') {
      const ytmId = extractYtmId(inputUrl);
      if (!ytmId) return c.json({ error: 'Could not extract playlist ID from URL.' }, 400);
      try { return c.json(await importYtmPlaylist(ytmId)); }
      catch (e) { return c.json({ error: e.message || 'YTM import failed.' }, 500); }
    }
    return c.json({ error: 'URL not recognised. Use soundcloud.com/sets/…, on.soundcloud.com/…, or music.youtube.com/playlist?list=…' }, 400);
  })
);

export default app;
