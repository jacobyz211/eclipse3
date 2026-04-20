const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');
// ytpl removed — using direct YouTube Music browse API for full playlist pagination
const fs      = require('fs');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const ytdl    = require('@distube/ytdl-core');

const execAsync     = promisify(exec);
const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || '';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'change-me-please';
const REDIS_URL = process.env.REDIS_URL || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

let redis = null;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    lazyConnect: true,
    tls: REDIS_URL.startsWith('rediss://') ? {} : undefined
  });
  redis.connect().catch(() => {});
}

const memStore = new Map();

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signPayload(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig  = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (expected !== sig) return null;
    return JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function kvSet(key, value) {
  const raw = JSON.stringify(value);
  if (redis) {
    try { await redis.set(key, raw); return; } catch {}
  }
  memStore.set(key, raw);
}

async function kvGet(key) {
  if (redis) {
    try {
      const v = await redis.get(key);
      if (v) return JSON.parse(v);
    } catch {}
  }
  const local = memStore.get(key);
  return local ? JSON.parse(local) : null;
}

async function fetchSharedClientId() {
  try {
    const r = await axios.get('https://soundcloud.com', {
      headers: { 'User-Agent': UA },
      timeout: 10000
    });
    const m = String(r.data).match(/client_id\s*:\s*"([a-zA-Z0-9]+)"/);
    if (m) return m[1];
  } catch {}
  return null;
}

let sharedClientId = null;
fetchSharedClientId().then(v => { if (v) sharedClientId = v; }).catch(() => {});

async function scGet(clientId, url, params = {}) {
  const cid = clientId || sharedClientId || await fetchSharedClientId();
  if (!cid) throw new Error('No SoundCloud client_id available.');
  const r = await axios.get(url, {
    params: { ...params, client_id: cid },
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: 20000
  });
  return r.data;
}

function tokenMiddleware(req, res, next) {
  const token = req.params.token;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid token.' });
  req.tokenPayload = payload;
  next();
}

// ─── YTM playlist import (direct YT internal API — full pagination) ─────────
async function importYtmPlaylist(playlistId) {
  const cleanId  = playlistId.replace(/^VL/, '');
  const browseId = 'VL' + cleanId;

  const YT_KEY    = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-KOUN-VSxU';
  const YT_CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00' };

  function extractItems(data) {
    const items = [];
    let continuation = null;
    function walk(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(walk); return; }
      if (obj.musicResponsiveListItemRenderer) {
        const r      = obj.musicResponsiveListItemRenderer;
        const cols   = r.flexColumns || [];
        const title  = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
        const artist = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
        let duration = null;
        const fixed  = r.fixedColumns || [];
        const dText  = fixed[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text;
        if (dText) {
          const parts = dText.split(':').map(Number);
          if (parts.length === 2) duration = parts[0] * 60 + parts[1];
          if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        let videoId = r.playlistItemData?.videoId ||
          r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
            ?.playNavigationEndpoint?.watchEndpoint?.videoId || null;
        const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
        const thumb  = thumbs ? thumbs[thumbs.length - 1]?.url : null;
        if (title && videoId) items.push({ id: 'ytm-' + videoId, title, artist: artist || 'Unknown', duration, artworkURL: thumb });
        return;
      }
      if (obj.continuationItemRenderer) {
        const ct = obj.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (ct) continuation = ct;
        return;
      }
      for (const k of Object.keys(obj)) walk(obj[k]);
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
        if (hdr.title?.runs?.[0]?.text) title = hdr.title.runs[0].text;
        if (hdr.subtitle?.runs) creator = hdr.subtitle.runs.map(r => r.text || '').join('');
        const tn = hdr.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
        if (tn?.length) artwork = tn[tn.length - 1].url || null;
        return;
      }
      for (const k of Object.keys(obj)) walk(obj[k]);
    }
    walk(data);
    return { title, creator, artwork };
  }

  try {
    const headers = {
      'User-Agent':   UA,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Origin':       'https://music.youtube.com',
      'Referer':      'https://music.youtube.com/'
    };

    const initRes  = await axios.post(
      'https://music.youtube.com/youtubei/v1/browse?key=' + YT_KEY,
      { browseId, context: { client: YT_CLIENT } },
      { headers, timeout: 20000 }
    );

    const meta   = extractMeta(initRes.data);
    const first  = extractItems(initRes.data);
    const tracks = first.items.slice();
    let cont     = first.continuation;

    let safetyLimit = 100;
    while (cont && safetyLimit-- > 0) {
      try {
        const contRes = await axios.post(
          'https://music.youtube.com/youtubei/v1/browse?key=' + YT_KEY,
          { continuation: cont, context: { client: YT_CLIENT } },
          { headers, timeout: 20000 }
        );
        const page = extractItems(contRes.data);
        tracks.push(...page.items);
        cont = page.continuation || null;
      } catch (e) {
        console.warn('[ytm] continuation failed: ' + e.message);
        break;
      }
    }

    if (!tracks.length) throw new Error('No tracks found. Make sure the playlist is Public.');
    return { id: 'ytm-' + cleanId, title: meta.title, artworkURL: meta.artwork, creator: meta.creator, tracks };
  } catch (e) {
    if (e.response?.status === 404) throw new Error('Playlist not found. Make sure it is Public.');
    throw new Error('Could not fetch YouTube playlist: ' + e.message + '. Make sure it is Public.');
  }
}

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

async function expandScShortUrl(url) {
  try {
    const r = await axios.get(url, {
      maxRedirects: 10,
      headers: { 'User-Agent': UA },
      timeout: 10000,
      validateStatus: s => s < 500
    });
    return (r.request && r.request.res && r.request.res.responseUrl) || url;
  } catch (e) {
    if (e.response && e.response.headers && e.response.headers.location) return e.response.headers.location;
    return url;
  }
}

async function importScPlaylist(cid, scUrl) {
  const res = await scGet(cid, 'https://api-v2.soundcloud.com/resolve', { url: scUrl });
  if (res.kind !== 'playlist') throw new Error('Not a playlist (kind=' + res.kind + ')');
  return {
    id: String(res.id),
    title: res.title || 'SoundCloud Playlist',
    artworkURL: res.artwork_url || null,
    creator: res.user?.username || 'SoundCloud',
    tracks: (res.tracks || []).map(t => ({
      id: String(t.id),
      title: t.title || 'Unknown',
      artist: t.user?.username || 'Unknown',
      duration: t.duration ? Math.round(t.duration / 1000) : null,
      artworkURL: t.artwork_url || null
    }))
  };
}

function htmlPage() {
  let h = '';
  h += '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>Eclipse 3</title><style>';
  h += 'body{background:#0f0f0f;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.wrap{max-width:880px;width:100%}.card{background:#141414;border:1px solid #242424;border-radius:18px;padding:18px 18px 16px;margin:14px 0;box-shadow:0 10px 30px rgba(0,0,0,.25)}';
  h += 'h1{font-size:28px;margin:0 0 10px}h2{font-size:19px;margin:0 0 10px}.sub{color:#a7a7a7;font-size:14px;line-height:1.5}';
  h += '.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.pill{display:inline-flex;align-items:center;gap:8px;padding:8px 10px;border-radius:999px;background:#1a1a1a;border:1px solid #252525;color:#ccc;font-size:12px}.pill.b{color:#fff;border-color:#355f4a;background:#143222}.badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#77d9a5;background:#112518;border:1px solid #244d34;padding:6px 8px;border-radius:999px;margin-bottom:10px}';
  h += '.steps{display:flex;flex-direction:column;gap:12px}.step{display:flex;gap:12px;align-items:flex-start}.sn{background:#1a1a1a;border:1px solid #252525;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#666}.st{font-size:14px;line-height:1.5;color:#ddd}';
  h += '.lbl{font-size:13px;color:#bdbdbd;margin:8px 0 8px}.hint{font-size:12px;color:#8a8a8a;margin-top:8px;line-height:1.45}.tip{font-size:13px;color:#d8d8d8;background:#121212;border:1px solid #222;border-left:3px solid #2b7;border-radius:12px;padding:10px 12px;margin-top:10px}';
  h += 'input{width:100%;background:#0b0b0b;color:#fff;border:1px solid #2a2a2a;border-radius:12px;padding:14px 14px;font-size:14px;outline:none}input:focus{border-color:#4e8cff;box-shadow:0 0 0 4px rgba(78,140,255,.15)}';
  h += 'button{cursor:pointer;border:0;border-radius:12px;padding:12px 14px;font-size:14px;font-weight:700}.bg{background:#fff;color:#000}.bg:disabled{opacity:.6;cursor:not-allowed}.ghost{background:#1a1a1a;color:#eee;border:1px solid #2a2a2a}';
  h += '.status{font-size:13px;margin-top:10px;color:#9f9f9f}.status.ok{color:#8ee7ad}.status.err{color:#ff9c9c}';
  h += '.preview{display:none;margin-top:12px;background:#101010;border:1px solid #1f1f1f;border-radius:14px;padding:12px}.tr{display:flex;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid #181818;font-size:13px}.tr:last-child{border-bottom:none}.idx{width:26px;color:#777}.tt{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ar{color:#9a9a9a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}';
  h += 'a{color:#9cc8ff;text-decoration:none}a:hover{text-decoration:underline}code{background:#111;padding:2px 6px;border:1px solid #232323;border-radius:8px}';
  h += '</style></head><body><div class="wrap">';
  h += '<div class="card"><span class="badge">Eclipse 3</span><h1>Generate your addon URL</h1><p class="sub">All SoundCloud tracks (including previews and + songs) show in search; streams prefer Claudochrome and fall back to SoundCloud if needed.</p>';
  h += '<div class="pills"><span class="pill">Tracks, albums, artists</span><span class="pill">SC playlists</span><span class="pill b">YTM playlist import</span></div>';
  h += '<div class="tip"><b>Save your URL.</b> Copy it somewhere safe. If the server restarts, paste it below to keep playlists working.</div></div>';
  h += '<div class="card"><span class="badge">Playlist Importer</span><h2>Import SoundCloud or YouTube Music Playlist</h2><p class="sub">Downloads a CSV you can import in Eclipse via Library → Import CSV.</p><div class="lbl">Addon URL</div><input type="text" id="addonUrl" placeholder="Paste your generated addon URL here"><div class="lbl">Playlist URL</div><input type="text" id="impUrl" placeholder="soundcloud.com/artist/sets/name or music.youtube.com/playlist?list=..."><div class="hint">SoundCloud or YouTube Music public playlists only.</div><div class="row" style="margin-top:12px"><button class="bg" id="impBtn" onclick="doImport()">Fetch &amp; Download CSV</button></div><div id="impStatus" class="status"></div><div id="preview" class="preview"></div></div>';
  h += '<script>';
  h += 'function getTok(raw){try{var u=new URL(raw.trim());var p=u.pathname.split("/").filter(Boolean);if(p[0]==="u"&&p[1])return p[1];}catch(e){}var m=String(raw||"").match(/\/u\/([^/?#]+)/);return m?m[1]:null;}';
  h += 'function csvEscape(v){if(v==null)return"";v=String(v);if(/[",\n]/.test(v))return "\""+v.replace(/\"/g,"\"\"")+"\"";return v;}';
  h += 'function doImport(){var raw=document.getElementById("addonUrl").value.trim();var purl=document.getElementById("impUrl").value.trim();var btn=document.getElementById("impBtn");var st=document.getElementById("impStatus");var pv=document.getElementById("preview");if(!raw){st.className="status err";st.textContent="Paste your addon URL first.";return;}if(!purl){st.className="status err";st.textContent="Paste a playlist URL.";return;}var tok=getTok(raw);if(!tok){st.className="status err";st.textContent="Could not find your token in the URL.";return;}btn.disabled=true;btn.textContent="Fetching...";st.className="status";st.textContent="Fetching tracks...";pv.style.display="none";fetch("/u/"+tok+"/import?url="+encodeURIComponent(purl)).then(function(r){if(!r.ok){return r.json().then(function(e){throw new Error(e.error||("Server error "+r.status));});}return r.json();}).then(function(data){var tracks=data.tracks||[];if(!tracks.length)throw new Error("No tracks found.");var rows=tracks.slice(0,20).map(function(t,i){return "<div class=\"tr\"><div class=\"idx\">"+(i+1)+"</div><div class=\"tt\">"+(t.title||"")+"</div><div class=\"ar\">"+(t.artist||"")+"</div></div>";});pv.innerHTML=rows.join("");pv.style.display="block";st.className="status ok";st.textContent="Found "+tracks.length+" tracks in "+(data.title||"playlist")+". Downloading CSV...";var lines=["title,artist,duration,artworkURL,id"];tracks.forEach(function(t){lines.push([csvEscape(t.title),csvEscape(t.artist),csvEscape(t.duration),csvEscape(t.artworkURL),csvEscape(t.id)].join(","));});var blob=new Blob([lines.join("\n")],{type:"text/csv"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(data.title||"playlist").replace(/[^a-zA-Z0-9 \-_\.]/g,"").trim()+".csv";document.body.appendChild(a);a.click();document.body.removeChild(a);btn.disabled=false;btn.textContent="Fetch & Download CSV";}).catch(function(e){st.className="status err";st.textContent=e.message;btn.disabled=false;btn.textContent="Fetch & Download CSV";});}';
  h += '</script></div></body></html>';
  return h;
}

app.get('/', (req, res) => res.type('html').send(htmlPage()));

app.post('/generate', async (req, res) => {
  const clientId = req.body?.clientId || sharedClientId || await fetchSharedClientId();
  const payload = { cid: clientId || null, t: Date.now() };
  const token = signPayload(payload);
  await kvSet('token:' + token, payload);
  const origin = BASE_URL || (req.protocol + '://' + req.get('host'));
  res.json({ url: origin + '/u/' + token });
});

app.post('/refresh', async (req, res) => {
  const clientId = req.body?.clientId || sharedClientId || await fetchSharedClientId();
  const payload = { cid: clientId || null, t: Date.now() };
  const token = signPayload(payload);
  await kvSet('token:' + token, payload);
  const origin = BASE_URL || (req.protocol + '://' + req.get('host'));
  res.json({ url: origin + '/u/' + token });
});

app.get('/u/:token', tokenMiddleware, (req, res) => {
  res.json({
    id: 'eclipse3',
    name: 'Eclipse 3',
    version: '4.0.0',
    description: 'SoundCloud search with YTM playlist importer',
    types: ['track', 'album', 'artist', 'playlist']
  });
});

app.get('/u/:token/search', tokenMiddleware, async (req, res) => {
  const cid = req.tokenPayload?.cid || sharedClientId || await fetchSharedClientId();
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  try {
    const [tracksRaw, playlistsRaw, artistsRaw] = await Promise.all([
      scGet(cid, 'https://api-v2.soundcloud.com/search/tracks', { q, limit: 20, offset: 0, linked_partitioning: 1 }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/playlists', { q, limit: 10, offset: 0 }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/users', { q, limit: 5, offset: 0 })
    ]);

    const tracks = (tracksRaw.collection || tracksRaw.items || []).map(t => ({
      id: String(t.id),
      title: t.title,
      artist: t.user?.username || 'Unknown',
      artworkURL: t.artwork_url || null,
      duration: t.duration ? Math.round(t.duration / 1000) : null
    }));

    const playlists = (playlistsRaw.collection || playlistsRaw.items || []).map(p => ({
      id: String(p.id),
      title: p.title,
      creator: p.user?.username || 'Unknown',
      artworkURL: p.artwork_url || null,
      trackCount: p.track_count || 0
    }));

    const artists = (artistsRaw.collection || artistsRaw.items || []).map(a => ({
      id: String(a.id),
      name: a.username,
      artworkURL: a.avatar_url || null
    }));

    res.json({ tracks, albums: [], artists, playlists });
  } catch (e) {
    res.status(500).json({ error: 'Search failed: ' + e.message });
  }
});

app.get('/u/:token/track/:id', tokenMiddleware, async (req, res) => {
  const cid = req.tokenPayload?.cid || sharedClientId || await fetchSharedClientId();
  const tid = req.params.id;
  try {
    let track;
    try { track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/soundcloud:tracks:' + tid); }
    catch { track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/' + tid); }
    res.json({
      id: String(track.id),
      title: track.title,
      artist: track.user?.username || 'Unknown',
      duration: track.duration ? Math.round(track.duration / 1000) : null,
      artworkURL: track.artwork_url || null,
      permalinkURL: track.permalink_url || null
    });
  } catch (e) {
    res.status(500).json({ error: 'Track fetch failed.' });
  }
});

app.get('/u/:token/album/:id', tokenMiddleware, async (req, res) => {
  const cid = req.tokenPayload?.cid || sharedClientId || await fetchSharedClientId();
  try {
    const pl = await scGet(cid, 'https://api-v2.soundcloud.com/playlists/' + req.params.id);
    res.json({
      id: String(pl.id),
      title: pl.title,
      creator: pl.user?.username || 'Unknown',
      artworkURL: pl.artwork_url || null,
      tracks: (pl.tracks || []).map(t => ({
        id: String(t.id),
        title: t.title,
        artist: t.user?.username || 'Unknown',
        duration: t.duration ? Math.round(t.duration / 1000) : null,
        artworkURL: t.artwork_url || null
      }))
    });
  } catch (e) {
    res.status(500).json({ error: 'Album fetch failed.' });
  }
});

app.get('/u/:token/artist/:id', tokenMiddleware, async (req, res) => {
  const cid = req.tokenPayload?.cid || sharedClientId || await fetchSharedClientId();
  try {
    const [user, tracksRaw, playlistsRaw] = await Promise.all([
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id),
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id + '/tracks', { limit: 10, linked_partitioning: 1 }).catch(() => null),
      scGet(cid, 'https://api-v2.soundcloud.com/users/' + req.params.id + '/playlists', { limit: 20, linked_partitioning: 1 }).catch(() => null)
    ]);
    res.json({
      id: String(user.id),
      name: user.username,
      artworkURL: user.avatar_url || null,
      tracks: ((tracksRaw && (tracksRaw.collection || tracksRaw.items)) || []).map(t => ({ id: String(t.id), title: t.title })),
      playlists: ((playlistsRaw && (playlistsRaw.collection || playlistsRaw.items)) || []).map(p => ({ id: String(p.id), title: p.title }))
    });
  } catch (e) {
    res.status(500).json({ error: 'Artist fetch failed.' });
  }
});

app.get('/u/:token/playlist/:id', tokenMiddleware, async (req, res) => {
  const cid = req.tokenPayload?.cid || sharedClientId || await fetchSharedClientId();
  const rawId = String(req.params.id || '');
  if (rawId.indexOf('ytm-') === 0) {
    try {
      const pl = await importYtmPlaylist(rawId.replace(/^ytm-/, ''));
      return res.json(pl);
    } catch (e) {
      return res.status(500).json({ error: 'YTM playlist failed: ' + e.message });
    }
  }
  try {
    const pl = await scGet(cid, 'https://api-v2.soundcloud.com/playlists/' + rawId);
    if (!pl) return res.status(404).json({ error: 'Playlist not found.' });
    res.json({
      id: String(pl.id),
      title: pl.title,
      creator: pl.user?.username || 'Unknown',
      artworkURL: pl.artwork_url || null,
      tracks: (pl.tracks || []).map(t => ({
        id: String(t.id),
        title: t.title,
        artist: t.user?.username || 'Unknown',
        duration: t.duration ? Math.round(t.duration / 1000) : null,
        artworkURL: t.artwork_url || null
      }))
    });
  } catch (e) {
    res.status(500).json({ error: 'Playlist fetch failed: ' + e.message });
  }
});

app.get('/u/:token/import', tokenMiddleware, async (req, res) => {
  const cid = req.tokenPayload?.cid || sharedClientId || await fetchSharedClientId();
  let url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing url.' });

  try {
    const type = detectUrlType(url);
    if (!type) return res.status(400).json({ error: 'Unsupported playlist URL.' });

    if (type === 'scplaylist-short') url = await expandScShortUrl(url);

    if (type === 'ytmplaylist') {
      const ytmId = extractYtmId(url);
      if (!ytmId) return res.status(400).json({ error: 'Could not find YouTube playlist ID.' });
      const pl = await importYtmPlaylist(ytmId);
      return res.json(pl);
    }

    const pl = await importScPlaylist(cid, url);
    return res.json(pl);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Import failed.' });
  }
});

app.listen(PORT, () => {
  console.log('Eclipse 3 listening on :' + PORT);
});
