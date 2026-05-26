'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const DB_NAME    = 'base-viewer';
const DB_VERSION = 1;
const MAX_SOUNDS = 5;
const MAX_SIMULTANEOUS_AUDIO = 3;

const PLACEHOLDER = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 60">' +
  '<rect width="80" height="60" fill="%231c2333"/>' +
  '<text x="40" y="38" text-anchor="middle" font-size="28" fill="%23768390">◈</text>' +
  '</svg>'
);

// ── State ────────────────────────────────────────────────────────────────────

const gallery   = {};   // speciesCommon → entry
const imgCache  = {};   // speciesKey    → object URL (or PLACEHOLDER)
let activeAudio = 0;
let audioUnlocked = false;
let soundEnabled  = false;
let mqttClient  = null;
let db          = null;

// ── Settings (localStorage) ──────────────────────────────────────────────────

function defaultSettings() {
  return {
    brokerUrl:   '',
    topicPrefix: 'bioacoustics',
    username:    '',
    password:    '',
    autoConnect: false,
  };
}

function loadSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(localStorage.getItem('base-viewer-settings') || '{}') };
  } catch { return defaultSettings(); }
}

function saveSettings(s) {
  localStorage.setItem('base-viewer-settings', JSON.stringify(s));
}

// ── IndexedDB ────────────────────────────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('sounds')) d.createObjectStore('sounds', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images', { keyPath: 'key' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(value);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Image cache ──────────────────────────────────────────────────────────────

async function preloadImageCache() {
  try {
    const all = await dbGetAll('images');
    for (const row of all) {
      const blob = new Blob([row.data], { type: row.mime || 'image/jpeg' });
      imgCache[row.key] = URL.createObjectURL(blob);
    }
  } catch { /* non-fatal */ }
}

function _imgSrc(key) {
  return imgCache[key] || ('assets/images/' + key + '.jpg');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _speciesKey(name) {
  return (name || '').toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function _confClass(conf) {
  return conf >= 0.8 ? 'conf-high' : conf >= 0.6 ? 'conf-med' : 'conf-low';
}

function _fmtSeen(date, time) {
  if (!date || !time) return '—';
  const hhmm  = time.slice(0, 5);
  const today = new Date().toISOString().slice(0, 10);
  if (date === today) return hhmm;
  const d   = new Date(date + 'T' + time);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${d.getDate()} ${mon} ${hhmm}`;
}

// ── MQTT ─────────────────────────────────────────────────────────────────────

function connect() {
  const s = loadSettings();
  if (!s.brokerUrl) { showSettings(); return; }
  if (mqttClient) { mqttClient.end(true); mqttClient = null; }

  setConnStatus('connecting', 'Connecting…');

  const opts = {
    clientId:        'base-viewer-' + Math.random().toString(16).slice(2, 10),
    clean:           true,
    reconnectPeriod: 5000,
  };
  if (s.username) { opts.username = s.username; opts.password = s.password; }

  try {
    mqttClient = mqtt.connect(s.brokerUrl, opts);
  } catch (e) {
    setConnStatus('disconnected', 'Error: ' + e.message);
    return;
  }

  mqttClient.on('connect', () => {
    setConnStatus('connected', 'Connected');
    const prefix = (s.topicPrefix || 'bioacoustics').replace(/\/$/, '');
    mqttClient.subscribe(prefix + '/detections', err => {
      if (err) console.warn('Subscribe failed:', err.message);
    });
  });

  mqttClient.on('message', (_topic, payload) => {
    try {
      const det = JSON.parse(payload.toString());
      if (det.species_common) updateGallery(det);
    } catch { /* ignore malformed */ }
  });

  mqttClient.on('error',      (err) => setConnStatus('disconnected', 'Error: ' + (err?.message || err)));
  mqttClient.on('disconnect', ()    => setConnStatus('disconnected', 'Disconnected'));
  mqttClient.on('offline',    ()    => setConnStatus('disconnected', 'Offline'));
  mqttClient.on('reconnect',  ()    => setConnStatus('connecting',   'Reconnecting…'));
}

function disconnect() {
  if (mqttClient) { mqttClient.end(true); mqttClient = null; }
  setConnStatus('disconnected', 'Disconnected');
}

function setConnStatus(state, label) {
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-label');
  if (dot) dot.className = 'conn-dot ' + state;
  if (lbl) lbl.textContent = label;
}

// ── Gallery ──────────────────────────────────────────────────────────────────

function updateGallery(det) {
  const name = det.species_common;
  const key  = _speciesKey(name);
  const ts   = (det.date && det.time) ? new Date(det.date + 'T' + det.time).getTime() : Date.now();

  if (!gallery[name]) {
    gallery[name] = {
      det, key, count: 1, bestConf: det.confidence,
      firstSeen:  { date: det.date, time: det.time },
      lastSeen:   { date: det.date, time: det.time },
      lastSeenTs: ts,
    };
  } else {
    const e = gallery[name];
    e.count++;
    if (det.confidence > e.bestConf) e.bestConf = det.confidence;
    e.lastSeen   = { date: det.date, time: det.time };
    e.lastSeenTs = ts;
  }

  renderGallery(name);
  playDetectionSound(key);
}

function renderGallery(flashName) {
  const grid  = document.getElementById('gallery-grid');
  const empty = document.getElementById('empty-state');
  if (!grid) return;

  const entries = Object.values(gallery)
    .sort((a, b) => (b.lastSeenTs || 0) - (a.lastSeenTs || 0));

  if (!entries.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  grid.innerHTML = entries.map(e => galleryCard(e)).join('');

  if (flashName) {
    const key = _speciesKey(flashName);
    const el  = document.getElementById('card-' + key);
    if (el) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
  }
}

function galleryCard(entry) {
  const { det, key, count, bestConf, firstSeen, lastSeen } = entry;
  const pct = Math.round(bestConf * 100);

  return `
    <div class="gallery-card" id="card-${key}" onclick="showSpeciesDetail('${det.species_common.replace(/'/g, "\\'")}')">
      <div class="card-img-wrap">
        <img src="${_imgSrc(key)}" alt="${det.species_common}"
             onerror="this.onerror=null;this.src='${PLACEHOLDER}';this.classList.add('img-placeholder')">
        <span class="card-count">×${count}</span>
        <span class="card-conf ${_confClass(bestConf)}">${pct}%</span>
      </div>
      <div class="card-info">
        <div class="card-name">${det.species_common}</div>
        <div class="card-sci">${det.species_scientific || ''}</div>
        <div class="card-clf">${det.classifier || ''} · ${det.location_name || ''}</div>
        <div class="card-times">
          <span title="First detected">⬆ ${_fmtSeen(firstSeen?.date, firstSeen?.time)}</span>
          <span title="Last detected">⬇ ${_fmtSeen(lastSeen?.date,  lastSeen?.time)}</span>
        </div>
      </div>
    </div>`;
}

// ── Audio ─────────────────────────────────────────────────────────────────────

function toggleSound() {
  audioUnlocked = true;  // satisfies browser autoplay policy on first click
  soundEnabled  = !soundEnabled;
  const btn = document.getElementById('sound-unlock-btn');
  if (!btn) return;
  if (soundEnabled) {
    btn.textContent = '🔊 Sounds on';
    btn.classList.add('sound-on');
  } else {
    btn.textContent = '🔇 Sounds off';
    btn.classList.remove('sound-on');
  }
}

async function playDetectionSound(key) {
  if (!audioUnlocked || !soundEnabled || activeAudio >= MAX_SIMULTANEOUS_AUDIO) return;
  try {
    const record = await dbGet('sounds', key);
    let url, isObjectUrl = false;
    if (record?.clips?.length) {
      const clip = record.clips[Math.floor(Math.random() * record.clips.length)];
      const blob = new Blob([clip.data], { type: clip.mime || 'audio/mpeg' });
      url = URL.createObjectURL(blob);
      isObjectUrl = true;
    } else {
      url = 'assets/sounds/' + key + '.mp3';
    }
    const audio = new Audio(url);
    audio.volume = 0.65;
    activeAudio++;
    audio.play().catch(() => { activeAudio--; });
    audio.onended  = () => { activeAudio--; if (isObjectUrl) URL.revokeObjectURL(url); };
    audio.onerror  = () => { activeAudio--; };
  } catch { }
}

// ── Settings UI ──────────────────────────────────────────────────────────────

function checkBrokerUrl() {
  const input = document.getElementById('s-url');
  const warn  = document.getElementById('url-warn');
  if (!input || !warn) return;
  const val = input.value.trim();
  if (!val) { warn.style.display = 'none'; return; }

  if (!/^(wss?|mqtts?):\/\//.test(val)) {
    warn.innerHTML = 'URL must include a scheme: <strong>wss://</strong>, <strong>ws://</strong>, or <strong>mqtts://</strong>.';
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }
}

function showSettings() {
  const s = loadSettings();
  document.getElementById('s-url').value          = s.brokerUrl || '';
  document.getElementById('s-prefix').value       = s.topicPrefix || 'bioacoustics';
  document.getElementById('s-username').value     = s.username || '';
  document.getElementById('s-password').value     = s.password || '';
  document.getElementById('s-autoconnect').checked = !!s.autoConnect;
  document.getElementById('settings-overlay').classList.add('open');
  document.getElementById('settings-panel').classList.add('open');
  checkBrokerUrl();
}

function hideSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
  document.getElementById('settings-panel').classList.remove('open');
}

function applySettings(e) {
  e.preventDefault();
  saveSettings({
    brokerUrl:   document.getElementById('s-url').value.trim(),
    topicPrefix: document.getElementById('s-prefix').value.trim() || 'bioacoustics',
    username:    document.getElementById('s-username').value,
    password:    document.getElementById('s-password').value,
    autoConnect: document.getElementById('s-autoconnect').checked,
  });
  hideSettings();
  connect();
}

// ── Species detail modal ──────────────────────────────────────────────────────

async function showSpeciesDetail(speciesName) {
  const entry = gallery[speciesName];
  if (!entry) return;
  document.getElementById('modal-title').textContent = speciesName;
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('species-modal').classList.add('open');
  await _renderModalBody(speciesName, entry.key, entry);
}

function hideModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('species-modal').classList.remove('open');
}

async function _renderModalBody(speciesName, key, entry) {
  const { det, count } = entry;
  const sounds = await dbGet('sounds', key);
  const clips  = sounds?.clips || [];
  const hasImg = imgCache[key] && imgCache[key] !== PLACEHOLDER;

  const soundItems = clips.map((c, i) => `
    <li class="sound-item">
      <span class="sound-name">${c.name}</span>
      <button class="btn btn-sm btn-outline" onclick="previewSound('${key}', ${i})">▶</button>
      <button class="btn btn-sm btn-danger" onclick="deleteSound('${key}', ${i}, '${speciesName.replace(/'/g, "\\'")}')">✕</button>
    </li>`).join('');

  document.getElementById('modal-body').innerHTML = `
    ${hasImg ? `<img class="modal-img" src="${imgCache[key]}" alt="${speciesName}">` : ''}

    <div class="modal-meta">
      ${det.species_scientific ? `<em>${det.species_scientific}</em><br>` : ''}
      ${count} detection${count !== 1 ? 's' : ''} this session
      ${det.location_name ? ' · ' + det.location_name : ''}
    </div>

    <hr class="modal-divider">

    <div class="modal-section-title">Photo</div>
    ${!hasImg ? `<p style="font-size:0.75rem;color:var(--muted);margin-bottom:8px">Default: <code>assets/images/${key}.jpg</code></p>` : ''}
    <label class="upload-area">
      ${hasImg ? '↑ Replace photo' : '+ Upload your own'} (JPEG, PNG, WebP)
      <input type="file" accept="image/jpeg,image/png,image/webp" style="display:none"
             onchange="uploadImage('${key}', this, '${speciesName.replace(/'/g, "\\'")}')">
    </label>

    <hr class="modal-divider">

    <div class="modal-section-title">Sounds — play randomly on detection (${clips.length}/${MAX_SOUNDS})</div>
    ${clips.length ? `<ul class="sound-list">${soundItems}</ul>` : `<p style="font-size:0.75rem;color:var(--muted);margin-bottom:8px">Default: <code>assets/sounds/${key}.mp3</code></p>`}
    ${clips.length < MAX_SOUNDS ? `
    <label class="upload-area">
      + Upload your own sound${clips.length ? 's' : ''} (MP3, WAV, OGG — up to ${MAX_SOUNDS - clips.length} more)
      <input type="file" accept="audio/*" multiple style="display:none"
             onchange="uploadSounds('${key}', this, '${speciesName.replace(/'/g, "\\'")}')">
    </label>` : ''}`;
}

// ── Image management ──────────────────────────────────────────────────────────

async function uploadImage(key, input, speciesName) {
  const file = input.files[0];
  if (!file) return;
  const data = await file.arrayBuffer();
  await dbPut('images', { key, data, mime: file.type });
  if (imgCache[key]) URL.revokeObjectURL(imgCache[key]);
  imgCache[key] = URL.createObjectURL(new Blob([data], { type: file.type }));
  renderGallery();
  const entry = gallery[speciesName];
  if (entry) await _renderModalBody(speciesName, key, entry);
}

// ── Sound management ──────────────────────────────────────────────────────────

async function uploadSounds(key, input, speciesName) {
  const files  = Array.from(input.files);
  const record = (await dbGet('sounds', key)) || { key, clips: [] };
  const slots  = MAX_SOUNDS - record.clips.length;
  for (const file of files.slice(0, slots)) {
    const data = await file.arrayBuffer();
    record.clips.push({ name: file.name, data, mime: file.type });
  }
  await dbPut('sounds', record);
  const entry = gallery[speciesName];
  if (entry) await _renderModalBody(speciesName, key, entry);
}

async function deleteSound(key, index, speciesName) {
  const record = await dbGet('sounds', key);
  if (!record) return;
  record.clips.splice(index, 1);
  if (record.clips.length) {
    await dbPut('sounds', record);
  } else {
    await dbDelete('sounds', key);
  }
  const entry = gallery[speciesName];
  if (entry) await _renderModalBody(speciesName, key, entry);
}

async function previewSound(key, index) {
  const record = await dbGet('sounds', key);
  if (!record?.clips[index]) return;
  const clip  = record.clips[index];
  const blob  = new Blob([clip.data], { type: clip.mime || 'audio/mpeg' });
  const url   = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play().catch(() => {});
  audio.onended = () => URL.revokeObjectURL(url);
}

// ── About modal ──────────────────────────────────────────────────────────────

function showAbout() {
  document.getElementById('about-overlay').classList.add('open');
}

function hideAbout() {
  document.getElementById('about-overlay').classList.remove('open');
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  db = await openDb();
  await preloadImageCache();

  // URL params override stored settings — useful for kiosk/Yodeck deployments
  // where you can't interact with the settings panel.
  // e.g. ?broker=wss://host:8084/mqtt&username=base&password=secret&prefix=bioacoustics
  const params = new URLSearchParams(window.location.search);
  if (params.has('broker')) {
    saveSettings({
      brokerUrl:   params.get('broker'),
      topicPrefix: params.get('prefix')   || 'bioacoustics',
      username:    params.get('username') || '',
      password:    params.get('password') || '',
      autoConnect: true,
    });
  }

  const s = loadSettings();
  if (s.autoConnect && s.brokerUrl) connect();
}

document.addEventListener('DOMContentLoaded', init);
