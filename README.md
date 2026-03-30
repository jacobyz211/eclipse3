# SoundCloud Eclipse Addon

A plug-and-play Eclipse Music addon that lets you search and stream SoundCloud.

## Deploy to Render via GitHub

1. Push this repo to GitHub (public or private).
2. Go to https://render.com → **New** → **Web Service**.
3. Connect your GitHub repo.
4. Render auto-detects Node.js. Leave all defaults as-is.
5. Click **Deploy**.
6. Your live URL will be: `https://soundcloud-eclipse-addon.onrender.com`

## Install in Eclipse Music

1. Open Eclipse Music
2. Go to **Library → Cloud → Add Connection**
3. Tap **Addon**
4. Paste: `https://your-render-url.onrender.com/manifest.json`
5. Tap **Install**

## Local Development

npm install
node index.js
# Addon runs at http://localhost:3000

## Notes

- The addon automatically extracts SoundCloud's `client_id` from their
  JS bundles on startup. No manual key needed.
- The client_id refreshes every 6 hours and re-fetches on 401/403 errors.
- As of January 2026, SoundCloud only serves AAC HLS streams (MP3
  progressive was removed Dec 31, 2025). Eclipse's iOS audio engine
  (AVPlayer) handles HLS natively.
