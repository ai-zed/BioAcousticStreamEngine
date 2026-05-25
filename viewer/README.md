# BASE Viewer

A standalone browser app that subscribes to a BASE MQTT feed and displays live species detections as they arrive — a real-time photo gallery with an ambient soundscape.

No installation, no server, no dependencies to install. Open `index.html` in a browser.

---

## Features

- **Live gallery** — species cards appear and reorder in real time as detections arrive via MQTT
- **Soundscape** — upload up to 5 recordings per species; one plays randomly each time that species is detected, building a live audio picture of what's happening at the remote site
- **Per-species photos** — upload your own image for any species; stored locally in the browser (IndexedDB, persists across sessions)
- **First / last detected timestamps** on every card
- **Confidence score** colour-coded on each card (green / amber / red)
- **Auto-reconnect** — recovers from broker disconnects automatically

---

## Getting started

1. Open `viewer/index.html` in Chrome, Firefox, or Edge
2. Click **⚙ Settings** and fill in your broker details (see below)
3. Click **Save & Connect**
4. Click **🔇 Enable sounds** to allow audio playback

---

## MQTT setup

| Setting | Value |
|---|---|
| Broker URL | `wss://u1d78101.ala.eu-central-1.emqxsl.com:8084/mqtt` |
| Topic prefix | `bioacoustics` (must match BASE's `topic_prefix` in settings) |
| Username / Password | Same credentials as BASE |

The URL must include a scheme: `wss://`, `ws://`, or `mqtts://`.

### Local Mosquitto

Add WebSocket support to `/etc/mosquitto/mosquitto.conf`:

```
listener 9001
protocol websockets
```

Then use `ws://localhost:9001` as the broker URL.

---

## Adding photos

1. Detections arrive → cards appear with a placeholder if no photo is set
2. Click any card → **+ Add photo** to upload a JPEG, PNG, or WebP
3. Photos are stored in your browser's IndexedDB and persist across sessions

---

## Adding sounds

1. Click any species card to open the detail panel
2. Under **Sounds**, click **+ Add sounds** and select up to 5 audio files (MP3, WAV, OGG)
3. Each time that species is detected, one file is chosen at random and played
4. Up to 3 sounds can play simultaneously to create a natural soundscape
5. Click **▶** to preview a sound; **✕** to remove it

Sounds are stored locally in IndexedDB. They persist across sessions but are specific to the browser and device.

---

## Notes

- All settings and data are stored in the browser — clearing browser storage will remove photos, sounds, and settings
- Audio playback requires a user gesture first (browser security policy) — click **🔇 Enable sounds** after opening the page
- The viewer only receives detections that arrive while it is open; it does not replay historical detections
