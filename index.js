const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');
const ytpl    = require('ytpl');
const fs      = require('fs');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');

const execAsync     = promisify(exec);
const execFileAsync = promisify(execFile);

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── Hi-Fi / Claudochrome instances (monochrome.tf) ─────────────────────────
const HIFI_INSTANCES = [
  'https://tidal-api.binimum.org',
  'https://ohio-1.monochrome.tf',
  'https://frankfurt-1.monochrome.tf',
  'https://eu-central.monochrome.tf',
  'https://us-west.monochrome.tf',
  'https://hifi.geeked.wtf',
  'https://monochrome-api.samidy.com'
];
let activeInstance  = HIFI_INSTANCES[0];
let instanceHealthy = false;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Hi-Fi client ────────────────────────────────────────────────────────────
async function hifiGet(path, params) {
  const errors    = [];
  const instances = instanceHealthy
    ? [activeInstance].concat(HIFI_INSTANCES.filter(i => i !== activeInstance))
    : HIFI_INSTANCES.slice();

  for (const inst of instances) {
    try {
      const r = await axios.get(inst + path, {
        params:  params || {},
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: 15000
      });
      if (r.status === 200 && r.data) {
        if (inst !== activeInstance) {
          activeInstance  = inst;
          instanceHealthy = true;
          console.log('[hifi] switched to ' + inst);
        }
        return r.data;
      }
    } catch (e) {
      errors.push(inst + ': ' + e.message);
    }
  }
  throw new Error('All Hi-Fi instances failed: ' + errors.slice(-2).join(' | '));
}

async function hifiGetSafe(path, params) {
  try { return await hifiGet(path, params); }
  catch (_e) { return null; }
}

async function checkInstances() {
  for (const inst of HIFI_INSTANCES) {
    try {
      await axios.get(inst + '/search/', {
        params: { s: 'test', limit: 1 },
        timeout: 8000
      });
      activeInstance  = inst;
      instanceHealthy = true;
      console.log('[hifi] healthy: ' + inst);
      return;
    } catch (_e) {}
  }
  instanceHealthy = false;
  console.warn('[hifi] WARNING: no healthy instances.');
}
checkInstances();
setInterval(checkInstances, 15 * 60 * 1000);

// ─── Redis ───────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck:     false
  });
  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('error',   e => console.error('[Redis] Error: ' + e.message));
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set('sc:token:' + token, JSON.stringify({
      clientId:  entry.clientId,
      createdAt: entry.createdAt,
      lastUsed:  entry.lastUsed,
      reqCount:  entry.reqCount
    }));
  } catch (e) {
    console.error('[Redis] Save failed: ' + e.message);
  }
}

async function redisLoad(token) {
  if (!redis) return null;
  try {
    const d = await redis.get('sc:token:' + token);
    return d ? JSON.parse(d) : null;
  } catch (_e) { return null; }
}

// ─── Token store ─────────────────────────────────────────────────────────────
const TOKEN_CACHE       = new Map();
const IP_CREATES        = new Map();
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX          = 60;
const RATE_WINDOW_MS    = 60000;

function generateToken() {
  return crypto.randomBytes(14).toString('hex');
}

function getOrCreateIpBucket(ip) {
  const now = Date.now();
  let b     = IP_CREATES.get(ip);
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
    clientId:  saved.clientId,
    createdAt: saved.createdAt,
    lastUsed:  saved.lastUsed,
    reqCount:  saved.reqCount,
    rateWin:   []
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
function effectiveCid(e) {
  return (e && e.clientId) ? e.clientId : SHARED_CLIENT_ID;
}

// ─── SoundCloud client_id ───────────────────────────────────────────────────
let SHARED_CLIENT_ID = null;
const TRACK_CACHE    = new Map();
const sleep          = ms => new Promise(r => setTimeout(r, ms));

const ID_PATTERNS = [
  /client_id\s*[=:,]\s*["']([a-zA-Z0-9]{32})["']/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /client_id=([a-zA-Z0-9]{32})[&"'\s,)]/
];

function findId(text) {
  for (let i = 0; i < ID_PATTERNS.length; i++) {
    const m = text.match(ID_PATTERNS[i]);
    if (m) return m[1];
  }
  return null;
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function parseArtistTitle(track) {
  const raw  = cleanText(track && track.title);
  const meta = cleanText(
    (track && track.publisher_metadata &&
     (track.publisher_metadata.artist || track.publisher_metadata.writer_composer)) || ''
  );
  const up   = cleanText(track && track.user && track.user.username);
  if (raw.indexOf(' - ') !== -1) {
    const parts = raw.split(' - ');
    const L     = cleanText(parts[0]);
    const R     = cleanText(parts.slice(1).join(' - '));
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

function artworkUrl(raw, fb) {
  const s = raw || fb || '';
  return s ? s.replace('-large', '-t500x500') : null;
}
function scYear(x) {
  return (x.release_date || x.created_at || '').slice(0, 4) || null;
}

// SNIP = SoundCloud 30-second preview. BLOCK = region-blocked.
function isFullyPlayable(t) {
  if (!t) return false;
  if (t.streamable === false) return false;
  const p = t.policy;
  if (!p || p === 'SNIP' || p === 'BLOCK') return false;
  return true; // ALLOW or MONETIZE
}

async function getHtml(url) {
  try {
    const r = await axios.get(url, {
      headers: {
        'User-Agent':      UA,
        'Accept':          'text/html',
        'Accept-Encoding': 'gzip, deflate'
      },
      timeout:       15000,
      decompress:    true,
      responseType:  'text',
      validateStatus: s => s < 500
    });
    return r.data || '';
  } catch (_e) { return null; }
}

async function getJs(url) {
  try {
    const r = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept':     '*/*',
        'Referer':    'https://soundcloud.com/'
      },
      timeout:       12000,
      decompress:    true,
      responseType:  'text',
      validateStatus: s => s < 500
    });
    if (r.status !== 200 || (r.data || '').length < 5000) return null;
    return r.data;
  } catch (_e) { return null; }
}

async function tryExtract() {
  for (const pu of ['https://soundcloud.com', 'https://soundcloud.com/discover']) {
    const html = await getHtml(pu);
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
      const js  = await getJs(u);
      if (!js) continue;
      const bid = findId(js);
      if (bid) return bid;
    }
  }
  return null;
}

async function fetchSharedClientId() {
  if (process.env.SC_CLIENT_ID) {
    SHARED_CLIENT_ID = process.env.SC_CLIENT_ID;
    return;
  }

  // Check Redis first
  if (redis) {
    try {
      const cached = await redis.get('sc:shared_client_id');
      if (cached) {
        SHARED_CLIENT_ID = cached;
        console.log('[clientid] loaded from Redis');
        return;
      }
    } catch (_e) {}
  }

  // Not in Redis — scrape it
  const delays = [5000, 10000, 15000, 30000, 60000];
  let attempt  = 0;
  while (true) {
    attempt++;
    try {
      const id = await tryExtract();
      if (!id) throw new Error('not found');
      SHARED_CLIENT_ID = id;
      console.log('[clientid] obtained attempt ' + attempt);

      // Save to Redis for 5 hours
      if (redis) {
        await redis.set('sc:shared_client_id', id, 'EX', 18000);
      }

      setTimeout(() => {
        SHARED_CLIENT_ID = null;
        if (redis) redis.del('sc:shared_client_id');
        fetchSharedClientId();
      }, 5 * 60 * 60 * 1000);
      return;
    } catch (_e) {
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
    }
  }
}
fetchSharedClientId();

async function scGet(cid, url, params, retried) {
  if (!cid) throw new Error('No client_id');
  try {
    const r = await axios.get(url, {
      params: Object.assign({}, params || {}, { client_id: cid }),
      headers: {
        'User-Agent': UA,
        'Accept':     'application/json'
      },
      timeout:    12000,
      decompress: true
    });
    return r.data;
  } catch (e) {
    if (!retried && e.response && (e.response.status === 401 || e.response.status === 403)) {
      SHARED_CLIENT_ID = null;
      fetchSharedClientId();
      await sleep(3000);
      return scGet(SHARED_CLIENT_ID, url, params, true);
    }
    throw e;
  }
}

async function resolveStubs(cid, tracks, fbArt) {
  const stubs = tracks.filter(t => !t.title).map(t => t.id);
  const map   = {};
  for (let i = 0; i < stubs.length; i += 50) {
    try {
      const data = await scGet(cid, 'https://api-v2.soundcloud.com/tracks', {
        ids: stubs.slice(i, i + 50).join(',')
      });
      const arr = Array.isArray(data) ? data
        : data.collection ? data.collection
        : [];
      arr.forEach(t => { map[String(t.id)] = t; });
    } catch (e) {
      console.warn('[resolveStubs] failed: ' + e.message);
    }
  }
  return tracks.map(t => map[String(t.id)] || t).filter(t => !!t.title);
}

// ─── Smarter Hi-Fi track search (multiple retries/queries) ──────────────────
async function hifiFindBestTrack(meta, albumName) {
  if (!meta || !meta.title) return null;

  const baseTitle  = meta.title;
  const baseArtist = meta.artist || meta.uploader || '';
  const queries    = [];

  if (baseArtist) {
    queries.push(baseArtist + ' ' + baseTitle);
    queries.push(baseTitle + ' ' + baseArtist);
  }
  queries.push(baseTitle);
  if (albumName) {
    queries.push(baseTitle + ' ' + albumName);
  }

  const norm = str => String(str || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const wantTitle  = norm(baseTitle);
  const wantArtist = norm(baseArtist);

  for (const q of queries) {
    try {
      const sData = await hifiGetSafe('/search/', { s: q, limit: 5, offset: 0 });
      if (!sData) continue;

      let items = [];
      if (sData.data && Array.isArray(sData.data.items)) items = sData.data.items;
      else if (Array.isArray(sData.items))               items = sData.items;
      else if (Array.isArray(sData.data))                items = sData.data;
      if (!items.length) continue;

      const ranked = items.slice().sort((a, b) => {
        const aTitle  = norm(a.title);
        const bTitle  = norm(b.title);
        const aArtist = norm(
          (a.artist && a.artist.name) ||
          (a.artists && a.artists[0] && a.artists[0].name) ||
          ''
        );
        const bArtist = norm(
          (b.artist && b.artist.name) ||
          (b.artists && b.artists[0] && b.artists[0].name) ||
          ''
        );

        let aScore = 0, bScore = 0;

        // Exact title match
        if (aTitle === wantTitle) aScore += 5;
        if (bTitle === wantTitle) bScore += 5;

        // Exact artist match
        if (wantArtist && aArtist === wantArtist) aScore += 5;
        if (wantArtist && bArtist === wantArtist) bScore += 5;

        // Partial title match
        if (wantTitle && aTitle.includes(wantTitle)) aScore += 2;
        if (wantTitle && bTitle.includes(wantTitle)) bScore += 2;

        // Partial artist match
        if (wantArtist && aArtist.includes(wantArtist)) aScore += 2;
        if (wantArtist && bArtist.includes(wantArtist)) bScore += 2;

        return bScore - aScore;
      });

      // Only accept a Hi-Fi match if it’s a strong match on both title and artist.
      const best = ranked[0];
      if (!best) continue;

      const bestTitle  = norm(best.title);
      const bestArtist = norm(
        (best.artist && best.artist.name) ||
        (best.artists && best.artists[0] && best.artists[0].name) ||
        ''
      );

      const titleGood =
        wantTitle &&
        (bestTitle === wantTitle || bestTitle.includes(wantTitle));

      const artistGood =
        !wantArtist || // if SC had no artist meta, we can’t enforce artist
        (bestArtist &&
         (bestArtist === wantArtist || bestArtist.includes(wantArtist)));

      // If we have an artist from SoundCloud, require both titleGood and artistGood.
      if (wantArtist) {
        if (titleGood && artistGood) return best;
      } else {
        // No artist info from SC: still require a very strong title match.
        if (bestTitle === wantTitle) return best;
      }
    } catch (_e) {}
  }
  return null;
}

// ─── YTM playlist import (direct YTM browse API — full pagination) ────────────
async function importYtmPlaylist(playlistId) {
  const cleanId  = playlistId.replace(/^VL/, '');
  const browseId = 'VL' + cleanId;

  const YT_KEY    = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-KOUN-VSxU';
  const YT_CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00' };
  const YT_HEADERS = {
    'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Content-Type': 'application/json',
    'Accept':       'application/json',
    'Origin':       'https://music.youtube.com',
    'Referer':      'https://music.youtube.com/'
  };

  // Pull track items + next continuation token out of any browse response
  function extractItems(data) {
    const items = [];
    let continuation = null;

    function walk(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(walk); return; }

      // Track row
      if (obj.musicResponsiveListItemRenderer) {
        const r     = obj.musicResponsiveListItemRenderer;
        const cols  = r.flexColumns || [];
        const title = cols[0]
          ?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || null;
        const artist = cols[1]
          ?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || 'Unknown';

        // Duration
        let duration = null;
        const dRun = (r.fixedColumns || [])[0]
          ?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text;
        if (dRun) {
          const parts = dRun.split(':').map(Number);
          if (parts.length === 2) duration = parts[0] * 60 + parts[1];
          if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }

        // Video ID — try playlistItemData first, then overlay play button
        const videoId =
          r.playlistItemData?.videoId ||
          r.overlay?.musicItemThumbnailOverlayRenderer?.content
            ?.musicPlayButtonRenderer?.playNavigationEndpoint
            ?.watchEndpoint?.videoId || null;

        // Best thumbnail
        const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
        const thumb  = thumbs?.length ? thumbs[thumbs.length - 1].url : null;

        if (title && videoId) {
          items.push({
            id:         'ytm-' + videoId,
            title,
            artist,
            duration,
            artworkURL: thumb
          });
        }
        return;
      }

      // Continuation token for next page
      if (obj.continuationItemRenderer) {
        const token =
          obj.continuationItemRenderer?.continuationEndpoint
            ?.continuationCommand?.token || null;
        if (token) continuation = token;
        return;
      }

      for (const key of Object.keys(obj)) walk(obj[key]);
    }

    walk(data);
    return { items, continuation };
  }

  // Pull playlist title + author + artwork out of the first response
  function extractMeta(data) {
    let title = 'YouTube Music Playlist', creator = 'YouTube Music', artwork = null;

    function walk(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(walk); return; }

      const hdr =
        obj.musicImmersiveHeaderRenderer ||
        obj.musicDetailHeaderRenderer ||
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

  try {
    // ── First page ────────────────────────────────────────────────────────────
    const initRes = await axios.post(
      'https://music.youtube.com/youtubei/v1/browse?key=' + YT_KEY,
      { browseId, context: { client: YT_CLIENT } },
      { headers: YT_HEADERS, timeout: 20000 }
    );

    const meta   = extractMeta(initRes.data);
    const first  = extractItems(initRes.data);
    const tracks = [...first.items];
    let cont     = first.continuation;

    // ── Follow continuation pages until exhausted ─────────────────────────────
    let guard = 200; // max pages safety cap
    while (cont && guard-- > 0) {
      try {
        const pageRes = await axios.post(
          'https://music.youtube.com/youtubei/v1/browse?key=' + YT_KEY,
          { continuation: cont, context: { client: YT_CLIENT } },
          { headers: YT_HEADERS, timeout: 20000 }
        );
        const page = extractItems(pageRes.data);
        tracks.push(...page.items);
        cont = page.continuation || null;
      } catch (pageErr) {
        console.warn('[ytm] continuation page failed:', pageErr.message);
        break;
      }
    }

    if (!tracks.length) {
      throw new Error('No tracks found. Make sure the playlist is Public.');
    }

    return {
      id:         'ytm-' + cleanId,
      title:      meta.title,
      artworkURL: meta.artwork,
      creator:    meta.creator,
      tracks
    };

  } catch (e) {
    if (e.response?.status === 404) {
      throw new Error('Playlist not found. Make sure it is Public and the URL is correct.');
    }
    throw new Error('Could not fetch YouTube playlist: ' + e.message + '. Make sure it is Public.');
  }
}

// ─── URL helpers ─────────────────────────────────────────────────────────────
function detectUrlType(url) {
  if (!url) return null;
  if (/soundcloud\.com\/.*\/sets\//.test(url)) return 'scplaylist';
  if (/on\.soundcloud\.com\//.test(url))       return 'scplaylist-short';
  if (/snd\.sc\//.test(url))                   return 'scplaylist-short';
  if (/music\.youtube\.com|youtube\.com.*\?list=/.test(url)) return 'ytmplaylist';
  if (/music\.youtube\.com\/browse\/VL/.test(url))           return 'ytmplaylist';
  return null;
}

function extractYtmId(url) {
  const browse = url.match(/browse\/VL([a-zA-Z0-9_-]+)/);
  if (browse) return browse[1];
  const m = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ─── SC short URL expander ───────────────────────────────────────────────────
async function expandScShortUrl(url) {
  try {
    const r = await axios.get(url, {
      maxRedirects: 10,
      headers: { 'User-Agent': UA },
      timeout: 10000,
      validateStatus: s => s < 500
    });
    const final = (r.request && r.request.res && r.request.res.responseUrl) || url;
    console.log('[expandScShortUrl]', url, '->', final);
    return final;
  } catch (e) {
    if (e.response && e.response.headers && e.response.headers.location) {
      return e.response.headers.location;
    }
    return url;
  }
}

// ─── SC playlist import ──────────────────────────────────────────────────────
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

// ─── Config page (SoundCloud + Claudochrome) ────────────────────────────────
function buildConfigPage(baseUrl) {
  let h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>SoundCloud + Claudochrome Addon</title>';
  h += '<style>*{box-sizing:border-box;margin:0;padding:0}';
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
  h += '.tn{color:#444;font-size:11px;min-width:22px;text-align:right}.ti{flex:1;min-width:0}.tt{color:#e8e8e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ta{color:#666;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
  h += 'footer{margin-top:32px;font-size:12px;color:#333;text-align:center;line-height:1.8}</style></head><body>';
  h += '<svg class="logo" width="52" height="52" viewBox="0 0 52 52" fill="none"><circle cx="26" cy="26" r="26" fill="#f50"/><path d="M15 30c0-2.4 2-4.4 4.4-4.4s4.4 2 4.4 4.4" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="M10.5 30c0-4.9 4-8.9 8.9-8.9s8.9 4 8.9 8.9" stroke="#fff" stroke-width="2.5" stroke-linecap="round" opacity=".55"/><rect x="30" y="21" width="3.5" height="17" rx="1.75" fill="#fff"/><rect x="35.5" y="18" width="3.5" height="20" rx="1.75" fill="#fff"/><rect x="41" y="23" width="3.5" height="15" rx="1.75" fill="#fff"/></svg>';
  h += '<div class="card"><h1>SoundCloud for Eclipse</h1>';
  h += '<div class="tip"><b>Save your URL.</b> Copy it to Notes or a bookmark. If the server restarts, paste it below to keep all playlists working.</div>';
  h += '<p class="sub">All SoundCloud tracks (including previews and + songs) show in search; streams prefer Claudochrome (Hi-Fi API, monochrome.tf) and fall back to SoundCloud if needed.</p>';
  h += '<div class="pills"><span class="pill">Tracks, albums, artists</span><span class="pill">SC playlists</span><span class="pill b">Claudochrome first</span><span class="pill b">YTM playlist import</span></div>';
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
  h += '</div><div class="warn">Your URL is saved to Redis and survives restarts. Claudochrome uses community-hosted Hi-Fi instances; if they are down, playback falls back to SoundCloud only.</div></div>';
  h += '<div class="card"><span class="badge">Playlist Importer</span>';
  h += '<h2>Import SoundCloud or YouTube Music Playlist</h2>';
  h += '<p class="sub">Downloads a CSV you can import in Eclipse via Library → Import CSV.</p>';
  h += '<div class="lbl">Your Addon URL</div>';
  h += '<input type="text" id="impToken" placeholder="Paste your addon URL (auto-fills after generating)">';
  h += '<div class="lbl">Playlist URL</div>';
  h += '<input type="text" id="impUrl" placeholder="soundcloud.com/artist/sets/name or on.soundcloud.com/XXXX or music.youtube.com/playlist?list=...">';
  h += '<div class="hint">SoundCloud: <code>soundcloud.com/…/sets/…</code> or <code>on.soundcloud.com/…</code>.&nbsp;&nbsp;YouTube Music: <code>music.youtube.com/playlist?list=…</code>.</div>';
  h += '<div class="status" id="impStatus"></div>';
  h += '<div class="preview" id="impPreview"></div>';
  h += '<button class="bg" id="impBtn" onclick="doImport()">Fetch &amp; Download CSV</button></div>';
  h += '<footer>Eclipse SoundCloud + Claudochrome Addon v4.0.0 • <a href="' + baseUrl + '/health" target="_blank" style="color:#333;text-decoration:none">' + baseUrl + '</a></footer>';
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
  h += 'if(tracks.length>50)rows.push(\'<div class="tr" style="text-align:center;color:#555"><span class="tn"></span><div class="ti"><div class="tt">\'+hesc((tracks.length-50)+\' more...\')+\'</div></div></div>\');';
  h += 'pv.innerHTML=rows.join("");pv.style.display="block";st.className="status ok";st.textContent="Found "+tracks.length+" tracks in "+(data.title||"playlist")+". Downloading CSV...";';
  h += 'var lines=["name,artist,album,duration"];function ce(s){var x=String(s==null?"":s).replace(/[\\r\\n]+/g," ");return \'"\'+x.replace(/"/g,\'""\')+\'"\';}tracks.forEach(function(t){lines.push(ce(t.title)+","+ce(t.artist)+","+ce(data.title||"")+","+ce(t.duration||""));});';
  h += 'var blob=new Blob([lines.join("\\r\\n")],{type:"text/csv"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(data.title||"playlist").replace(/[^a-zA-Z0-9 \\-_\\.]/g,"").trim()+".csv";document.body.appendChild(a);a.click();document.body.removeChild(a);';
  h += 'btn.disabled=false;btn.textContent="Fetch & Download CSV";}).catch(function(e){st.className="status err";st.textContent=e.message;btn.disabled=false;btn.textContent="Fetch & Download CSV";});}';
  h += '</script></body></html>';
  return h;
}

// ─── Routes ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async (req, res) => {
  const ip     = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) {
    return res.status(429).json({ error: 'Too many tokens today from this IP.' });
  }
  const cid = (req.body && req.body.clientId) ? String(req.body.clientId).trim() : null;
  if (cid && !/^[a-zA-Z0-9]{20,40}$/.test(cid)) {
    return res.status(400).json({ error: 'Invalid client_id.' });
  }
  const token = generateToken();
  const entry = { clientId: cid || null, createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.post('/refresh', async (req, res) => {
  const raw = (req.body && req.body.existingUrl) ? String(req.body.existingUrl).trim() : '';
  const cid = (req.body && req.body.clientId) ? String(req.body.clientId).trim() : null;
  let token = raw;
  const m   = raw.match(/\/u\/([a-f0-9]{28})\//);
  if (m) token = m[1];
  if (!token || !/^[a-f0-9]{28}$/.test(token)) {
    return res.status(400).json({ error: 'Paste your full addon URL.' });
  }
  const entry = await getTokenEntry(token);
  if (!entry) return res.status(404).json({ error: 'URL not found. Generate a new one.' });
  if (cid) {
    if (!/^[a-zA-Z0-9]{20,40}$/.test(cid)) {
      return res.status(400).json({ error: 'Invalid client_id.' });
    }
    entry.clientId = cid;
    TOKEN_CACHE.set(token, entry);
    await redisSave(token, entry);
  }
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json', refreshed: true });
});

// Health
app.get('/health', (req, res) => {
  res.json({
    status:              'ok',
    version:             '4.0.0',
    sharedClientIdReady: !!SHARED_CLIENT_ID,
    redisConnected:      !!(redis && redis.status === 'ready'),
    hifiInstance:        activeInstance,
    hifiHealthy:         instanceHealthy,
    activeTokens:        TOKEN_CACHE.size,
    timestamp:           new Date().toISOString()
  });
});

// ─── Manifest ────────────────────────────────────────────────────────────────
app.get('/u/:token/manifest.json', tokenMiddleware, (req, res) => {
  res.json({
    id:          'com.eclipse.soundcloud.' + req.params.token.slice(0, 8),
    name:        'SoundCloud',
    version:     '4.0.0',
    description: 'SoundCloud search with Claudochrome (Hi-Fi API, monochrome.tf) streams first, then SoundCloud fallback. Previews and + songs still appear in search.',
    icon:        'https://files.softicons.com/download/social-media-icons/simple-icons-by-dan-leech/png/128x128/soundcloud.png',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist']
  });
});

// ─── Search (SoundCloud only, no filtering) ─────────────────────────────────
app.get('/u/:token/search', tokenMiddleware, async (req, res) => {
  const q = cleanText(req.query.q);
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });

  // Wait up to 8 seconds for client ID if not ready yet
  if (!SHARED_CLIENT_ID) {
    await fetchSharedClientId();
  }

  const cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id yet. Retry in a few seconds.' });

  // ... rest of your search code unchanged

  
  try {
    const results = await Promise.all([
      scGet(cid, 'https://api-v2.soundcloud.com/search/tracks',     { q, limit: 20, offset: 0, linked_partitioning: 1 }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/playlists',  { q, limit: 10, offset: 0 }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/users',      { q, limit: 5,  offset: 0 })
    ].map(p => p.catch(() => null)));

    const trackRes = results[0] || { collection: [] };
    const plRes    = results[1] || { collection: [] };
    const userRes  = results[2] || { collection: [] };

    const allPl    = plRes.collection || [];

    const tracks = (trackRes.collection || [])
      .map(t => {
        rememberTrack(t);
        const m = parseArtistTitle(t);
        return {
          id:         String(t.id),
          title:      m.title || 'Unknown',
          artist:     m.artist || 'Unknown',
          album:      null,
          duration:   t.duration ? Math.floor(t.duration / 1000) : null,
          artworkURL: artworkUrl(t.artwork_url),
          format:     'aac'
        };
      });

    const albums = allPl
      .filter(p => p.is_album === true)
      .map(p => ({
        id:         String(p.id),
        title:      p.title || 'Unknown',
        artist:     (p.user && p.user.username) || 'Unknown',
        artworkURL: artworkUrl(p.artwork_url),
        trackCount: p.track_count || null,
        year:       scYear(p)
      }));

    const playlists = allPl
      .filter(p => !p.is_album)
      .map(p => ({
        id:         String(p.id),
        title:      p.title || 'Unknown',
        description: p.description || null,
        artworkURL: artworkUrl(p.artwork_url),
        creator:     (p.user && p.user.username) || null,
        trackCount:  p.track_count || null
      }));

    const artists = (userRes.collection || []).map(u => ({
      id:         String(u.id),
      name:       u.username || 'Unknown',
      artworkURL: artworkUrl(u.avatar_url),
      genres:     u.genre ? [u.genre] : []
    }));

    res.json({ tracks, albums, artists, playlists });
  } catch (e) {
    res.status(500).json({ error: 'Search failed, tracks only.', tracks: [] });
  }
});

// ─── Stream (Claudochrome/Hi-Fi FIRST, SoundCloud fallback) ────────────────
app.get('/u/:token/stream/:id', tokenMiddleware, async (req, res) => {
  const cid = effectiveCid(req.tokenEntry);
  const tid = req.params.id;

  if (!cid) return res.status(503).json({ error: 'No client_id available.' });

  let track  = null;
  const cached = TRACK_CACHE.get(String(tid)) || null;

  // Fetch SC track once for metadata and SC fallback
  try {
    try {
      track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/soundcloud:tracks:' + tid);
    } catch (_e) {
      track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/' + tid);
    }
  } catch (e) {
    console.warn('[stream] SC track lookup failed for ' + tid + ': ' + e.message);
  }

  if (track) rememberTrack(track);

  const meta = cached || (track ? parseArtistTitle(track) : null);
  const albumName =
    track && track.publisher_metadata && track.publisher_metadata.release_title
      ? track.publisher_metadata.release_title
      : null;

  // 1) Claudochrome / Hi-Fi FIRST with smarter search
  try {
    const best = await hifiFindBestTrack(meta, albumName);
    if (best && best.id) {
      const hifiId = best.id;
      const qList  = ['LOSSLESS', 'HIGH', 'LOW'];

      for (let qi = 0; qi < qList.length; qi++) {
        const ql = qList[qi];
        try {
          const data    = await hifiGet('/track/', { id: hifiId, quality: ql });
          const payload = (data && data.data) ? data.data : data;

          if (payload && payload.manifest) {
            const decoded = JSON.parse(
              Buffer.from(payload.manifest, 'base64').toString('utf8')
            );
            const url   = (decoded.urls && decoded.urls[0]) || null;
            const codec = decoded.codecs || decoded.mimeType || '';
            if (url) {
              const isFlac = codec &&
                (codec.indexOf('flac') !== -1 || codec.indexOf('audio/flac') !== -1);
              return res.json({
                url,
                format:    isFlac ? 'flac' : 'aac',
                quality:   ql === 'LOSSLESS' ? 'lossless' : (ql === 'HIGH' ? '320kbps' : '128kbps'),
                expiresAt: Math.floor(Date.now() / 1000) + 21600
              });
            }
          }

          if (payload && payload.url) {
            return res.json({
              url:       payload.url,
              format:    'aac',
              quality:   'lossless',
              expiresAt: Math.floor(Date.now() / 1000) + 21600
            });
          }
        } catch (e) {
          if (qi === qList.length - 1) {
            console.warn('[stream] Hi-Fi all qualities failed for ' + hifiId + ': ' + e.message);
          }
        }
      }
    }
  } catch (e) {
    console.warn('[stream] Hi-Fi error for ' + tid + ': ' + e.message);
  }

  // 2) SoundCloud fallback — try progressive first, then HLS
  if (track) {
    const tc = (track.media && track.media.transcodings) || [];

    // Helper to resolve a transcoding URL to a playable stream URL
    async function resolveTranscoding(transcoding) {
      const sd = await scGet(cid, transcoding.url);
      if (!sd || !sd.url) return null;
      const mime = (transcoding.format && transcoding.format.mime_type) || '';
      const fmt  = mime.indexOf('aac') !== -1 ? 'aac' : 'mp3';
      return { url: sd.url, format: fmt, quality: '160kbps', expiresAt: Math.floor(Date.now() / 1000) + 86400 };
    }

    // 2a) Progressive (direct mp3/aac URL — preferred, works in all players)
    const progressive = tc.find(t => t.format && t.format.protocol === 'progressive');
    if (progressive && progressive.url) {
      try {
        const result = await resolveTranscoding(progressive);
        if (result) {
          console.log('[stream] SC progressive OK for ' + tid);
          return res.json(result);
        }
      } catch (e) {
        console.warn('[stream] SC progressive failed for ' + tid + ': ' + e.message);
      }
    }

    // 2b) HLS fallback — many tracks (especially newer ones) ONLY have HLS
    //     Eclipse handles m3u8 playlists natively so this works fine
    const hls = tc.find(t => t.format && t.format.protocol === 'hls');
    if (hls && hls.url) {
      try {
        const result = await resolveTranscoding(hls);
        if (result) {
          console.log('[stream] SC HLS fallback OK for ' + tid);
          // Override format — HLS streams are m3u8 manifests
          result.format = result.format === 'aac' ? 'aac' : 'mp3';
          result.isHls  = true;
          return res.json(result);
        }
      } catch (e) {
        console.warn('[stream] SC HLS failed for ' + tid + ': ' + e.message);
      }
    }

    // 2c) Last resort — any remaining transcoding
    for (const tc_item of tc) {
      if (!tc_item || !tc_item.url) continue;
      if (tc_item === progressive || tc_item === hls) continue;
      try {
        const result = await resolveTranscoding(tc_item);
        if (result) {
          console.log('[stream] SC fallback (other protocol) OK for ' + tid);
          return res.json(result);
        }
      } catch (e) { /* keep trying */ }
    }
  }

  return res.status(404).json({ error: 'No stream found for track ' + tid });
});

// ─── Album (SC playlist-as-album, no filtering) ─────────────────────────────
app.get('/u/:token/album/:id', tokenMiddleware, async (req, res) => {
  const cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id.' });
  try {
    const pl = await scGet(cid, 'https://api-v2.soundcloud.com/playlists/' + req.params.id);
    if (!pl) return res.status(404).json({ error: 'Album not found.' });
    const resolved = await resolveStubs(cid, pl.tracks || [], pl.artwork_url);
    const tracks   = resolved.map((t, i) => {
      rememberTrack(t);
      const m = parseArtistTitle(t);
      return {
        id:         String(t.id),
        title:      m.title || t.title || 'Unknown',
        artist:     m.artist || (pl.user && pl.user.username) || 'Unknown',
        duration:   t.duration ? Math.floor(t.duration / 1000) : null,
        trackNumber: t.track_number || (i + 1),
        artworkURL: artworkUrl(t.artwork_url, pl.artwork_url)
      };
    });
    res.json({
      id:         String(pl.id),
      title:      pl.title || 'Unknown',
      artist:     (pl.user && pl.user.username) || 'Unknown',
      artworkURL: artworkUrl(pl.artwork_url),
      year:       scYear(pl),
      description: pl.description || null,
      trackCount: tracks.length,
      tracks
    });
  } catch (e) {
    res.status(500).json({ error: 'Album fetch failed.' });
  }
});

// ─── Artist (no filtering) ──────────────────────────────────────────────────
app.get('/u/:token/artist/:id', tokenMiddleware, async (req, res) => {
  const cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id.' });
  try {
    const results = await Promise.all([
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id),
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id + '/tracks',    { limit: 10, linked_partitioning: 1 }).catch(() => null),
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id + '/playlists', { limit: 20, linked_partitioning: 1 }).catch(() => null)
    ]);
    const user  = results[0];
    if (!user) return res.status(404).json({ error: 'Artist not found.' });
    const trRes = results[1] || { collection: [] };
    const plRes = results[2] || { collection: [] };

    const resolved = await resolveStubs(cid, trRes.collection || [], null);
    const topTracks = resolved.map(t => {
      rememberTrack(t);
      const m = parseArtistTitle(t);
      return {
        id:         String(t.id),
        title:      m.title || t.title || 'Unknown',
        artist:     m.artist || user.username || 'Unknown',
        duration:   t.duration ? Math.floor(t.duration / 1000) : null,
        artworkURL: artworkUrl(t.artwork_url)
      };
    });

    const albums = (plRes.collection || [])
      .filter(p => p.is_album === true)
      .map(p => ({
        id:         String(p.id),
        title:      p.title || 'Unknown',
        artist:     user.username || 'Unknown',
        artworkURL: artworkUrl(p.artwork_url),
        trackCount: p.track_count || null,
        year:       scYear(p)
      }));

    res.json({
      id:         String(user.id),
      name:       user.username || 'Unknown',
      artworkURL: artworkUrl(user.avatar_url),
      bio:        user.description || null,
      genres:     user.genre ? [user.genre] : [],
      topTracks,
      albums
    });
  } catch (e) {
    console.error('[artist] ' + e.message);
    res.status(500).json({ error: 'Artist fetch failed.' });
  }
});

// ─── Playlist ────────────────────────────────────────────────────────────────
app.get('/u/:token/playlist/:id', tokenMiddleware, async (req, res) => {
  const cid   = effectiveCid(req.tokenEntry);
  const rawId = req.params.id;

  if (rawId.indexOf('ytm-') === 0) {
    try {
      const pl = await importYtmPlaylist(rawId.replace(/^ytm-/, ''));
      return res.json(pl);
    } catch (e) {
      return res.status(500).json({ error: 'YTM playlist failed: ' + e.message });
    }
  }

  if (!cid) return res.status(503).json({ error: 'No client_id.' });
  try {
    const pl = await scGet(cid, 'https://api-v2.soundcloud.com/playlists/' + rawId);
    if (!pl) return res.status(404).json({ error: 'Playlist not found.' });
    const resolved = await resolveStubs(cid, pl.tracks || [], pl.artwork_url);
    const tracks   = resolved.map(t => {
      rememberTrack(t);
      const m = parseArtistTitle(t);
      return {
        id:         String(t.id),
        title:      m.title || t.title || 'Unknown',
        artist:     m.artist || (pl.user && pl.user.username) || 'Unknown',
        duration:   t.duration ? Math.floor(t.duration / 1000) : null,
        artworkURL: artworkUrl(t.artwork_url, pl.artwork_url)
      };
    });
    res.json({
      id:         String(pl.id),
      title:      pl.title || 'Unknown',
      description: pl.description || null,
      artworkURL: artworkUrl(pl.artwork_url),
      creator:    (pl.user && pl.user.username) || null,
      tracks
    });
  } catch (e) {
    res.status(500).json({ error: 'Playlist fetch failed.' });
  }
});

// ─── Import (SC playlist or YTM playlist to JSON/CSV) ───────────────────────
app.get('/u/:token/import', tokenMiddleware, async (req, res) => {
  const cid      = effectiveCid(req.tokenEntry);
  const inputUrl = cleanText(req.query.url);
  if (!inputUrl) return res.status(400).json({ error: 'Pass ?url with a playlist URL.' });

  const type = detectUrlType(inputUrl);

  if (type === 'scplaylist' || type === 'scplaylist-short') {
    if (!cid) return res.status(503).json({ error: 'No SoundCloud client_id yet.' });
    try {
      const pl = await importScPlaylist(cid, inputUrl);
      return res.json(pl);
    } catch (e) {
      return res.status(500).json({ error: 'SoundCloud import failed: ' + e.message });
    }
  }

  if (type === 'ytmplaylist') {
    const ytmId = extractYtmId(inputUrl);
    if (!ytmId) return res.status(400).json({ error: 'Could not extract playlist ID from URL.' });
    try {
      const pl = await importYtmPlaylist(ytmId);
      return res.json(pl);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'YTM import failed.' });
    }
  }

  return res.status(400).json({ error: 'URL not recognised. Use soundcloud.com/sets/…, on.soundcloud.com/…, or music.youtube.com/playlist?list=…' });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('Eclipse SoundCloud + Claudochrome Addon v4.0.0 on port ' + PORT);
});
