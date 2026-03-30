const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

let SC_CLIENT_ID = null;
const TRACK_CACHE = new Map();
const sleep = function(ms) { return new Promise(function(r) { return setTimeout(r, ms); }); };

const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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
  for (i = 0; i < ID_PATTERNS.length; i++) {
    m = text.match(ID_PATTERNS[i]);
    if (m && m[1]) return m[1];
  }
  return null;
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripFeatures(s) {
  return cleanText(
    String(s || '')
      .replace(/\s*\((feat|ft|featuring)[^)]+\)/gi, '')
      .replace(/\s*(feat|ft|featuring)\.?\s+[^-|/]+/gi, '')
  );
}

function parseArtistTitle(track) {
  var rawTitle = cleanText(track && track.title);
  var metaArtist = cleanText(
    (track && track.publisher_metadata && (track.publisher_metadata.artist || track.publisher_metadata.writer_composer)) || ''
  );
  var uploader = cleanText(track && track.user && track.user.username);
  var parts, left, right;

  if (rawTitle.indexOf(' - ') !== -1) {
    parts = rawTitle.split(' - ');
    left = cleanText(parts[0]);
    right = cleanText(parts.slice(1).join(' - '));
    if (left && right) {
      return { artist: metaArtist || left, title: right, rawTitle: rawTitle, uploader: uploader };
    }
  }

  return { artist: metaArtist || uploader, title: rawTitle, rawTitle: rawTitle, uploader: uploader };
}

function rememberTrack(track) {
  if (!track || !track.id) return;
  var meta = parseArtistTitle(track);
  TRACK_CACHE.set(String(track.id), {
    id: String(track.id),
    artist: meta.artist,
    title: meta.title,
    rawTitle: meta.rawTitle,
    uploader: meta.uploader
  });
}

async function getPage(url) {
  try {
    var res = await axios.get(url, {
      headers: PAGE_HEADERS,
      timeout: 15000,
      decompress: true,
      responseType: 'text',
      validateStatus: function(s) { return s < 500; }
    });
    var html = res.data || '';
    console.log('[SC] ' + url + ' => HTTP ' + res.status + ' | ' + html.length + ' bytes');
    return html;
  } catch (err) {
    console.warn('[SC] Page failed: ' + err.message);
    return null;
  }
}

async function getScript(url) {
  try {
    var res = await axios.get(url, {
      headers: {
        'User-Agent': PAGE_HEADERS['User-Agent'],
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate',
        'Referer': 'https://soundcloud.com/'
      },
      timeout: 12000,
      decompress: true,
      responseType: 'text',
      validateStatus: function(s) { return s < 500; }
    });
    var text = res.data || '';
    console.log('[SC] Script ' + url.split('/').pop() + ' => ' + res.status + ' | ' + text.length + ' bytes');
    if (res.status !== 200 || text.length < 5000) return null;
    return text;
  } catch (err) {
    console.warn('[SC] Script failed: ' + err.message);
    return null;
  }
}

async function tryExtract() {
  var pages = ['https://soundcloud.com', 'https://soundcloud.com/discover'];
  var i, pageUrl, html, inlineMatches, match, id, bundleUrls, srcUrls, all, url, js;

  for (i = 0; i < pages.length; i++) {
    pageUrl = pages[i];
    html = await getPage(pageUrl);
    if (!html || html.length < 5000) continue;

    inlineMatches = html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g);
    for (match of inlineMatches) {
      id = findId(match[1]);
      if (id) {
        console.log('[SC] client_id in inline script');
        return id;
      }
    }

    bundleUrls = Array.from(new Set(
      Array.from(html.matchAll(/https?:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9._-]+\.js/g)).map(function(m) { return m[0]; })
    ));

    srcUrls = Array.from(
      html.matchAll(/src=["'](https?:\/\/[^"']*(?:sndcdn|soundcloud)[^"']*\.js[^"']*)["']/g)
    ).map(function(m) { return m[1]; });

    all = Array.from(new Set(bundleUrls.concat(srcUrls)));
    console.log('[SC] Found ' + all.length + ' bundle(s) in ' + pageUrl);

    all = all.reverse().slice(0, 10);
    for (url of all) {
      js = await getScript(url);
      if (!js) continue;
      id = findId(js);
      if (id) {
        console.log('[SC] client_id found in bundle');
        return id;
      }
    }
  }

  return null;
}

async function fetchClientId() {
  if (process.env.SC_CLIENT_ID) {
    SC_CLIENT_ID = process.env.SC_CLIENT_ID;
    console.log('client_id loaded from SC_CLIENT_ID env var');
    return;
  }

  var delays = [5000, 10000, 15000, 30000, 60000];
  var attempt = 0;
  var id, delay;

  while (true) {
    attempt++;
    console.log('[Attempt ' + attempt + '] Fetching client_id...');
    try {
      id = await tryExtract();
      if (!id) throw new Error('Not found');
      SC_CLIENT_ID = id;
      console.log('client_id: ' + id);
      setTimeout(function() { SC_CLIENT_ID = null; fetchClientId(); }, 6 * 60 * 60 * 1000);
      return;
    } catch (err) {
      delay = delays[Math.min(attempt - 1, delays.length - 1)];
      console.warn('Attempt ' + attempt + ' failed: ' + err.message + '. Retry in ' + (delay / 1000) + 's');
      await sleep(delay);
    }
  }
}

fetchClientId();

async function scGet(url, params, retried) {
  params = params || {};
  retried = retried || false;
  if (!SC_CLIENT_ID) throw new Error('client_id not ready');
  try {
    var res = await axios.get(url, {
      params: Object.assign({}, params, { client_id: SC_CLIENT_ID }),
      headers: {
        'User-Agent': PAGE_HEADERS['User-Agent'],
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate'
      },
      timeout: 12000,
      decompress: true
    });
    return res.data;
  } catch (err) {
    if (!retried && err.response && (err.response.status === 401 || err.response.status === 403)) {
      console.warn('[API] 401/403 - refreshing client_id');
      SC_CLIENT_ID = null;
      fetchClientId();
      await sleep(3000);
      return scGet(url, params, true);
    }
    throw err;
  }
}

var PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://piped-api.garudalinux.org',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.in.projectsegfau.lt'
];

async function pipedGet(path, params) {
  params = params || {};
  var i, res;
  for (i = 0; i < PIPED_INSTANCES.length; i++) {
    try {
      res = await axios.get(PIPED_INSTANCES[i] + path, {
        params: params,
        headers: { 'User-Agent': PAGE_HEADERS['User-Agent'] },
        timeout: 10000
      });
      if (res.data) return res.data;
    } catch (e) {}
  }
  return null;
}

function extractVideoId(item) {
  if (!item) return null;
  if (typeof item.id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(item.id)) return item.id;
  if (typeof item.videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(item.videoId)) return item.videoId;
  var url = String(item.url || item.videoUrl || '');
  var m = url.match(/(?:v=|\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function scoreItem(item, query) {
  var hay = cleanText((item.title || item.name || '') + ' ' + (item.uploaderName || item.uploader || '')).toLowerCase();
  var tokens = cleanText(query).toLowerCase().split(' ').filter(Boolean);
  return tokens.reduce(function(n, t) { return n + (hay.indexOf(t) !== -1 ? 1 : 0); }, 0);
}

async function pipedSearch(query, filter) {
  var params = filter ? { q: query, filter: filter } : { q: query };
  var data = await pipedGet('/search', params);
  var items = (data && Array.isArray(data.items)) ? data.items : (Array.isArray(data) ? data : []);
  if (!items.length) return null;

  var ranked = items
    .map(function(item) { return { item: item, id: extractVideoId(item), score: scoreItem(item, query) }; })
    .filter(function(x) { return !!x.id; })
    .sort(function(a, b) { return b.score - a.score; });

  return ranked.length > 0 ? ranked[0].id : null;
}

async function youtubeSearch(title, artist) {
  var cleanTitle = cleanText(title);
  var cleanArtist = cleanText(artist);

  var rawQueries = [
    cleanArtist + ' ' + cleanTitle,
    cleanTitle + ' ' + cleanArtist,
    stripFeatures(cleanTitle) + ' ' + cleanArtist,
    cleanArtist + ' ' + stripFeatures(cleanTitle),
    cleanTitle,
    stripFeatures(cleanTitle),
    cleanArtist + ' ' + cleanTitle + ' audio'
  ];

  var queries = Array.from(new Set(rawQueries.map(cleanText).filter(Boolean)));
  var filters = ['music_songs', 'videos', null];
  var q, f, id;

  for (q of queries) {
    console.log('[YT] Trying query: "' + q + '"');
    for (f of filters) {
      id = await pipedSearch(q, f);
      if (id) return id;
    }
  }

  return null;
}

async function youtubeStreamUrl(videoId) {
  var data = await pipedGet('/streams/' + videoId);
  if (!data) return null;

  var streams = Array.isArray(data.audioStreams) ? data.audioStreams : [];
  if (!streams.length) return null;

  var direct = streams.filter(function(s) { return s && s.url && /^https?:\/\//i.test(s.url); });

  var chosen =
    direct.find(function(s) { return (s.mimeType || '').indexOf('audio/mp4') !== -1; }) ||
    direct.find(function(s) { return String(s.format || '').toUpperCase() === 'M4A'; }) ||
    direct.sort(function(a, b) { return (b.bitrate || 0) - (a.bitrate || 0); })[0];

  if (!chosen || !chosen.url) return null;

  return {
    url: chosen.url,
    format: 'm4a',
    quality: Math.round((chosen.bitrate || 128000) / 1000) + 'kbps'
  };
}

async function youtubeFallback(title, artist) {
  console.log('[YT] Fallback for: "' + artist + ' - ' + title + '"');
  var videoId = await youtubeSearch(title, artist);
  if (!videoId) { console.log('[YT] No video found'); return null; }
  console.log('[YT] Found videoId: ' + videoId);
  return youtubeStreamUrl(videoId);
}

app.get('/manifest.json', function(_req, res) {
  res.json({
    id: 'com.eclipse.soundcloud',
    name: 'SoundCloud',
    version: '2.1.0',
    description: 'Search SoundCloud. Falls back to YouTube for restricted tracks.',
    icon: 'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-orange-2xhdpi-a9dce059.png',
    resources: ['search', 'stream'],
    types: ['track']
  });
});

app.get('/search', async function(req, res) {
  var q = cleanText(req.query.q || '');
  if (!q) return res.json({ tracks: [] });

  if (!SC_CLIENT_ID) {
    return res.status(503).json({ error: 'client_id not ready yet. Retry in a few seconds.', tracks: [] });
  }

  try {
    var data = await scGet('https://api-v2.soundcloud.com/search/tracks', {
      q: q, limit: 20, offset: 0, linked_partitioning: 1
    });

    var tracks = (data.collection || [])
      .filter(function(t) { return t.streamable !== false; })
      .map(function(t) {
        rememberTrack(t);
        var meta = parseArtistTitle(t);
        return {
          id: String(t.id),
          title: meta.title || 'Unknown Title',
          artist: meta.artist || 'Unknown Artist',
          album: null,
          duration: t.duration ? Math.floor(t.duration / 1000) : null,
          artworkURL: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : null,
          format: 'aac'
        };
      });

    res.json({ tracks: tracks });
  } catch (err) {
    console.error('[/search] ' + err.message);
    res.status(500).json({ error: 'Search failed', tracks: [] });
  }
});

app.get('/stream/:id', async function(req, res) {
  if (!SC_CLIENT_ID) {
    return res.status(503).json({ error: 'client_id not ready. Retry in a few seconds.' });
  }

  var trackId = req.params.id;
  var track = null;
  var cached = TRACK_CACHE.get(String(trackId)) || null;

  try {
    try {
      track = await scGet('https://api-v2.soundcloud.com/tracks/soundcloud:tracks:' + trackId);
    } catch (e) {
      track = await scGet('https://api-v2.soundcloud.com/tracks/' + trackId);
    }
  } catch (err) {
    console.warn('[/stream] Track lookup failed: ' + err.message);
  }

  if (track) {
    rememberTrack(track);
    cached = TRACK_CACHE.get(String(trackId)) || cached;
  }

  if (track && track.policy !== 'BLOCK') {
    try {
      var transcodings = (track.media && track.media.transcodings) || [];
      var chosen =
        transcodings.find(function(t) {
          return t.format && t.format.protocol === 'hls' && t.format.mime_type && t.format.mime_type.indexOf('aac') !== -1;
        }) ||
        transcodings.find(function(t) { return t.format && t.format.protocol === 'hls'; }) ||
        transcodings.find(function(t) { return t.format && t.format.protocol === 'progressive'; }) ||
        transcodings[0];

      if (chosen && chosen.url) {
        var streamData = await scGet(chosen.url);
        if (streamData && streamData.url) {
          console.log('[/stream] SoundCloud OK for track ' + trackId);
          return res.json({
            url: streamData.url,
            format: (chosen.format && chosen.format.mime_type && chosen.format.mime_type.indexOf('aac') !== -1) ? 'aac' : 'mp3',
            quality: '160kbps'
          });
        }
      }
    } catch (err) {
      console.warn('[/stream] SoundCloud stream failed: ' + err.message);
    }
  }

  var meta = track ? parseArtistTitle(track) : cached;

  if (!meta || !meta.title) {
    return res.status(404).json({ error: 'No stream and no metadata for fallback.' });
  }

  var yt = await youtubeFallback(meta.title, meta.artist || meta.uploader || '');
  if (yt) {
    console.log('[/stream] YouTube fallback OK for "' + meta.title + '"');
    return res.json(yt);
  }

  return res.status(404).json({
    error: 'No stream from SoundCloud or YouTube for: ' + (meta.artist ? meta.artist + ' - ' : '') + meta.title
  });
});

app.get('/health', function(_req, res) {
  res.json({ status: 'ok', clientIdReady: !!SC_CLIENT_ID, timestamp: new Date().toISOString() });
});

app.listen(PORT, function() {
  console.log('SoundCloud + YouTube Fallback Addon on port ' + PORT);
});
