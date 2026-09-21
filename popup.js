'use strict';

/* ==========================================================================
   Page Image Finder – popup logic
   ========================================================================== */

const scanBtn = document.getElementById('scanBtn');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const toastEl = document.getElementById('toast');
const sortSelect = document.getElementById('sortSelect');
const selectAll = document.getElementById('selectAll');
const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
const headerBar = document.querySelector('.bar');
const typeDropdown = document.getElementById('typeDropdown');
const typeBtn = document.getElementById('typeBtn');
const typeMenu = document.getElementById('typeMenu');
const typeSummary = document.getElementById('typeSummary');
const typeBoxes = Array.from(typeMenu.querySelectorAll('input[type="checkbox"]'));
const tabBtn = document.getElementById('tabBtn');
const modeBtn = document.getElementById('modeBtn');
const typeControl = document.getElementById('typeControl');
const linkPanel = document.getElementById('linkPanel');
const linkInput = document.getElementById('linkInput');
const linkGoBtn = document.getElementById('linkGoBtn');
const linkClearBtn = document.getElementById('linkClearBtn');
const progressEl = document.getElementById('progress');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const progressCancel = document.getElementById('progressCancel');

const CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 20000;
// Videos the page holds as blob: URLs are handed over in chunks above this size
// instead of being inlined, so there is no limit on how large they can be.
const BLOB_CHUNK_BYTES = 4 * 1024 * 1024;

const KIND_LABELS = {
  'img': 'Image element',
  'css': 'CSS background',
  'svg-image': 'SVG image',
  'inline-svg': 'Inline SVG',
  'canvas': 'Canvas snapshot',
  'video': 'Video poster',
  'icon': 'Page icon',
  'meta': 'Social preview image',
  'video-el': 'Video element',
  'video-source': 'Video source',
  'video-link': 'Link to a video',
  'video-meta': 'Social preview video',
  'video-stream': 'Streamed video',
  'link': 'Pasted address',
  'video-network': 'Video loaded by the page'
};

const MIME = {
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  GIF: 'image/gif',
  WEBP: 'image/webp',
  AVIF: 'image/avif',
  SVG: 'image/svg+xml',
  BMP: 'image/bmp',
  ICO: 'image/x-icon',
  TIFF: 'image/tiff',
  HEIC: 'image/heic'
};

const KNOWN_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic']);

// Video formats we recognise, by file extension.
const VIDEO_EXT_FORMAT = {
  mp4: 'MP4', m4v: 'M4V', webm: 'WEBM', ogv: 'OGV', ogg: 'OGV', mov: 'MOV', mkv: 'MKV',
  avi: 'AVI', mpg: 'MPEG', mpeg: 'MPEG', '3gp': '3GP', flv: 'FLV', wmv: 'WMV'
};

const VIDEO_MIME_FORMAT = {
  'video/mp4': 'MP4',
  'video/x-m4v': 'M4V',
  'video/webm': 'WEBM',
  'video/ogg': 'OGV',
  'video/quicktime': 'MOV',
  'video/x-matroska': 'MKV',
  'video/x-msvideo': 'AVI',
  'video/msvideo': 'AVI',
  'video/mpeg': 'MPEG',
  'video/3gpp': '3GP',
  'video/3gpp2': '3GP',
  'video/x-flv': 'FLV',
  'video/x-ms-wmv': 'WMV'
};

const SORT_MODES = ['page', 'res-desc', 'res-asc', 'size-desc', 'size-asc'];

const DATA_TYPES = ['images', 'videos'];
const TYPE_LABELS = { images: 'Images', videos: 'Videos' };

let scanToken = 0;
let objectUrls = [];
let toastTimer = 0;
let currentEntries = [];
let sortMode = 'page';
let dataTypes = ['images'];
let hasScanned = false;
let isBusy = false;
let isDownloading = false;
let bubbleMayBeOpen = false;
let dismissingBubble = false;
let activeJob = null;   // the download shown in the progress bar
let scannedPage = '';   // which page was scanned (only shown when in a tab)
let mode = 'standard';  // 'standard' reads the page, 'link' reads pasted addresses

scanBtn.addEventListener('click', scan);
sortSelect.addEventListener('change', onSortChange);
selectAll.addEventListener('change', onSelectAllChange);
typeBtn.addEventListener('click', () => setTypeMenu(typeMenu.hidden));
typeBoxes.forEach((box) => box.addEventListener('change', onTypeChange));
document.addEventListener('pointerdown', (e) => {
  if (!typeMenu.hidden && !typeDropdown.contains(e.target)) setTypeMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !typeMenu.hidden) {
    setTypeMenu(false);
    typeBtn.focus();
  }
});
downloadSelectedBtn.addEventListener('click', downloadSelected);
progressCancel.addEventListener('click', cancelJob);
modeBtn.addEventListener('click', () => setMode(mode === 'link' ? 'standard' : 'link'));
linkGoBtn.addEventListener('click', loadLinks);
linkClearBtn.addEventListener('click', clearLinks);
linkInput.addEventListener('input', rememberLinks);
linkInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) loadLinks();
});
tabBtn.addEventListener('click', openInTab);
tabBtn.hidden = !isPopupWindow();
if (!isPopupWindow()) document.body.classList.add('in-tab');
window.addEventListener('beforeunload', () => { if (activeJob) activeJob.controller.abort(); });
// A click on the header dismisses Chrome's download bubble, like clicking elsewhere would.
headerBar.addEventListener('pointerdown', dismissDownloadBubble);
window.addEventListener('pagehide', restoreDownloadUi);
restoreDownloadUi();
const sortReady = initSort();
const typesReady = initTypes();
initMode();
updateSelectionUI();
renderTypes();

/* ==========================================================================
   Scan flow
   ========================================================================== */

async function scan() {
  const token = ++scanToken;
  hasScanned = true;
  setTypeMenu(false);
  resetList();
  currentEntries = [];
  setBusy(true);
  setStatus('Scanning the page…');

  await typesReady;
  if (token !== scanToken) return;
  const types = [...dataTypes];
  const noun = mediaNoun(types);

  let items;
  let skipped = 0;
  try {
    ({ items, skipped } = await collectFromTab(types));
  } catch (err) {
    if (token !== scanToken) return;
    setStatus(err.message, true);
    showEmpty('Could not scan this page', `Try a regular website tab and press “${scanLabel()}” again.`);
    setBusy(false);
    return;
  }
  if (token !== scanToken) return;

  if (!items.length) {
    setStatus(`No ${noun} found on this page.` + (skipped ? ' ' + skippedNote(skipped) : ''));
    showEmpty(`No ${noun} found`, skipped ? skippedNote(skipped) : `This page does not seem to use any ${noun}.`);
    setBusy(false);
    return;
  }

  const entries = items.map((item, i) => createEntry(item, i + 1));
  currentEntries = entries;
  const frag = document.createDocumentFragment();
  entries.forEach((e) => frag.append(e.row));
  listEl.replaceChildren(frag);

  await runQueue(entries, token);
  if (token !== scanToken) return;
  await sortReady;
  if (token !== scanToken) return;

  const shown = entries.filter((e) => !e.removed);
  const dropped = entries.length - shown.length;
  const totalBytes = shown.reduce((sum, e) => sum + (e.size || 0), 0);

  if (!shown.length) {
    setStatus(`No ${noun} could be loaded from this page.`);
    showEmpty(`No ${noun} could be loaded`, skipped ? skippedNote(skipped) : `The site may block access to its ${noun}.`);
  } else {
    const rough = shown.some((e) => e.sizeEstimated);
    let msg = `${countsText(shown)} found, ${rough ? '≈ ' : ''}${formatBytes(totalBytes)} in total.`;
    if (dropped) msg += ` ${plural(dropped, 'file')} could not be loaded and left out.`;
    if (skipped) msg += ' ' + skippedNote(skipped);
    if (scannedPage) msg = `${scannedPage} – ${msg}`;
    setStatus(msg);
    applySort();
  }
  setBusy(false);
}

async function collectFromTab(types) {
  const tab = await targetTab();
  if (!tab || tab.id === undefined) throw new Error('No page to scan was found.');
  scannedPage = isPopupWindow() ? '' : (tab.title || tab.url || '');

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: pageCollector,
      args: [{ images: types.includes('images'), videos: types.includes('videos') }]
    });
  } catch (err) {
    throw new Error(
      'This page cannot be scanned. Chrome does not allow extensions on pages like chrome:// or the Chrome Web Store.'
    );
  }

  const merged = new Map();
  let skipped = 0;
  for (const r of results || []) {
    const res = r.result;
    if (!res) continue;
    skipped += res.skipped || 0;
    for (const it of res.items || []) {
      if (merged.has(it.url)) continue;
      it.tabId = tab.id;
      it.frameId = r.frameId || 0;
      merged.set(it.url, it);
    }
  }
  return { items: [...merged.values()], skipped };
}

// In a tab this panel is itself the active tab, so the page the user means is
// the last one they looked at.
async function targetTab() {
  const own = chrome.runtime.getURL('');
  const isOwn = (t) => !t.url || t.url.startsWith(own);

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && !isOwn(active)) return active;

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const others = tabs.filter((t) => t.id !== undefined && !isOwn(t));
  others.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return others[0] || null;
}

async function runQueue(entries, token) {
  const total = entries.length;
  let next = 0;
  let finished = 0;

  const worker = async () => {
    while (next < total && token === scanToken) {
      const entry = entries[next++];
      let ok = false;
      try {
        ok = await processEntry(entry);
      } catch (_) {
        ok = false;
      }
      if (token !== scanToken) return;
      finished++;
      if (!ok) {
        entry.removed = true;
        entry.row.remove();
      }
      setStatus(`Found ${countsText(entries)}. Reading details… ${finished} of ${total}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
}

/* ==========================================================================
   Injected into the page (runs in every frame). Must be fully self-contained.
   ========================================================================== */

async function pageCollector(opts) {
  const DEBUG = true; // TEMP: flip to false once the issue is found
  const dlog = (...a) => { if (DEBUG) console.log('[PIF collector]', ...a); };

  const wantImages = !opts || opts.images !== false;
  const wantVideos = Boolean(opts && opts.videos);
  const found = new Map();
  let blobSkipped = 0;            // blob: videos that could not be read (Media Source streams)
  const base = document.baseURI;
  dlog('start', { url: location.href, wantImages, wantVideos });

  const STREAM_RE = /\.(m3u8|m3u|mpd)(?:$|[?#])/i;
  const VIDEO_URL_RE = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|mpe?g|3gp|flv|wmv)(?:$|[?#])/i;

  const add = (raw, kind, w, h, type = 'image', duration = 0) => {
    if (typeof raw !== 'string') return;
    raw = raw.trim();
    if (!raw || /^javascript:/i.test(raw) || raw === 'about:blank') return;
    let url = raw;
    if (!/^data:/i.test(raw)) {
      try { url = new URL(raw, base).href; } catch (_) { return; }
    }
    if (found.has(url)) return;
    const item = { url, kind, type, w: w || 0, h: h || 0 };
    if (type === 'video') {
      // A playlist is not a file but a list of segments; the popup joins them.
      const m = STREAM_RE.exec(url);
      if (m) {
        item.stream = m[1].toLowerCase() === 'mpd' ? 'dash' : 'hls';
        item.kind = kind === 'video-network' ? 'video-stream' : kind;
      }
      if (Number.isFinite(duration) && duration > 0) item.duration = duration;
    }
    found.set(url, item);
  };
  const addVideo = (raw, kind, w, h, duration) => add(raw, kind, w, h, 'video', duration);

  const urlRe = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)/g;
  const addCss = (value, kind) => {
    if (!value || value === 'none' || value === 'normal') return;
    urlRe.lastIndex = 0;
    let m;
    while ((m = urlRe.exec(value)) !== null) add(m[1] ?? m[2] ?? m[3], kind);
  };

  const SKIP = new Set(['script', 'style', 'title', 'head', 'noscript', 'base']);
  const svgRoots = [];
  const canvases = [];

  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      const tag = el.localName;

      if (tag === 'link') {
        if (wantImages && /icon/i.test(el.getAttribute('rel') || '')) add(el.getAttribute('href'), 'icon');
        continue;
      }
      if (tag === 'meta') {
        const key = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
        if (wantImages && /^(og:image(:url|:secure_url)?|twitter:image(:src)?)$/.test(key)) {
          add(el.getAttribute('content'), 'meta');
        }
        if (wantVideos && /^(og:video(:url|:secure_url)?|twitter:player:stream)$/.test(key)) {
          addVideo(el.getAttribute('content'), 'video-meta');
        }
        continue;
      }
      if (SKIP.has(tag)) continue;

      // Children of an <svg> are part of that SVG; only <image> needs handling.
      if (el instanceof SVGElement && tag !== 'svg') {
        if (tag === 'image') add(el.getAttribute('href') || el.getAttribute('xlink:href'), 'svg-image');
        continue;
      }

      if (tag === 'img') {
        if (wantImages) {
          const main = el.currentSrc || el.getAttribute('src');
          add(main, 'img', el.naturalWidth, el.naturalHeight);
          // Lazy-loaded images that have not been swapped in yet.
          for (const attr of ['data-src', 'data-lazy-src', 'data-original']) add(el.getAttribute(attr), 'img');
        }
      } else if (tag === 'input') {
        if (wantImages && el.type === 'image') add(el.getAttribute('src'), 'img');
      } else if (tag === 'video') {
        if (wantImages) add(el.getAttribute('poster'), 'video');
        if (wantVideos) {
          addVideo(el.currentSrc || el.getAttribute('src'), 'video-el', el.videoWidth, el.videoHeight, el.duration);
          // A player that feeds the element from a playlist keeps the original
          // address in a data attribute more often than not.
          for (const attr of ['data-src', 'data-source', 'data-hls', 'data-dash', 'data-video-src']) {
            const v = el.getAttribute(attr);
            if (v) addVideo(v, 'video-el', el.videoWidth, el.videoHeight, el.duration);
          }
        }
      } else if (tag === 'source') {
        if (wantVideos && el.parentElement && el.parentElement.localName === 'video') {
          addVideo(el.getAttribute('src'), 'video-source');
        }
      } else if (tag === 'a') {
        // Plain links that point straight to a video file
        if (wantVideos) {
          const href = el.getAttribute('href');
          if (href && (VIDEO_URL_RE.test(href) || STREAM_RE.test(href))) addVideo(href, 'video-link');
        }
      } else if (tag === 'canvas') {
        if (wantImages) canvases.push(el);
      } else if (tag === 'svg') {
        if (wantImages && !(el.parentElement && el.parentElement.closest('svg'))) svgRoots.push(el);
      }

      if (wantImages) {
        // CSS images: backgrounds, list markers, border images, ::before / ::after
        const cs = getComputedStyle(el);
        addCss(cs.backgroundImage, 'css');
        addCss(cs.listStyleImage, 'css');
        addCss(cs.borderImageSource, 'css');
        for (const pseudo of ['::before', '::after']) {
          const ps = getComputedStyle(el, pseudo);
          addCss(ps.backgroundImage, 'css');
          addCss(ps.content, 'css');
        }
      }

      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };

  visit(document);
  dlog('after DOM visit, found so far', found.size, [...found.values()].filter(v => v.type === 'video'));

  // Players load their playlists over the network, so they never appear in the
  // page markup. Resource timing still remembers every address the page used.
  if (wantVideos) {
    try {
      const entries = performance.getEntriesByType('resource');
      const initiatorTally = {};
      let streamHits = 0, videoNetworkHits = 0;
      for (const e of entries) {
        const name = e.name || '';
        initiatorTally[e.initiatorType] = (initiatorTally[e.initiatorType] || 0) + 1;
        if (STREAM_RE.test(name)) { addVideo(name, 'video-stream'); streamHits++; }
        else if (VIDEO_URL_RE.test(name) && (e.initiatorType === 'video' || e.initiatorType === 'media')) {
          addVideo(name, 'video-network');
          videoNetworkHits++;
        }
      }
      dlog('performance.getEntriesByType("resource")', {
        totalEntries: entries.length,
        streamHits,
        videoNetworkHits,
        initiatorTally,
        // If a request looks like a video/segment file but was tagged as
        // fetch/xhr/other (not "video"/"media"), it gets skipped by the
        // branch above on purpose and has to be caught by watch.js instead.
        videoLikeButWrongInitiator: entries
          .filter(e => VIDEO_URL_RE.test(e.name || '') && e.initiatorType !== 'video' && e.initiatorType !== 'media')
          .map(e => ({ url: e.name, initiatorType: e.initiatorType }))
      });
    } catch (err) { dlog('performance API failed', err); }

    // Belt and braces: watch.js (a content script that runs from the very
    // start of the page) records every fetch()/XHR request matching a video
    // or playlist address on its own. This catches two cases Resource Timing
    // alone misses: ad-heavy pages that fill its 250-entry buffer before this
    // scan ever runs, and players that load segments with fetch()/XHR, which
    // Resource Timing tags as initiatorType "fetch"/"xmlhttprequest" rather
    // than "video"/"media".
    try {
      const watched = window.__pifNetworkVideos;
      dlog('window.__pifNetworkVideos present?', Boolean(watched), watched ? watched.size : 0,
        watched ? [...watched.values()] : null);
      if (watched) {
        for (const rec of watched.values()) {
          addVideo(rec.url, rec.stream ? 'video-stream' : 'video-network');
        }
      } else {
        dlog('watch.js store missing entirely - either watch.js did not run in this frame, ' +
          'or it ran in a different execution world than this scan.');
      }
    } catch (err) { dlog('reading __pifNetworkVideos failed', err); }

    dlog('after network scan, video entries now', [...found.values()].filter(v => v.type === 'video'));
  }

  // Inline <svg> elements -> standalone SVG data URLs
  const serializer = new XMLSerializer();
  for (const svg of svgRoots) {
    try {
      if (svg.querySelector('use')) continue; // depends on symbols defined elsewhere
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const clone = svg.cloneNode(true);
      if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (!clone.getAttribute('width') || !clone.getAttribute('height')) {
        clone.setAttribute('width', String(Math.round(rect.width)));
        clone.setAttribute('height', String(Math.round(rect.height)));
        if (!clone.getAttribute('viewBox')) {
          clone.setAttribute('viewBox', `0 0 ${Math.round(rect.width)} ${Math.round(rect.height)}`);
        }
      }
      clone.style.color = getComputedStyle(svg).color; // keeps currentColor icons visible
      const markup = serializer.serializeToString(clone);
      const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
      if (dataUrl.length > 3e6) continue;
      if (!found.has(dataUrl)) {
        found.set(dataUrl, { url: dataUrl, kind: 'inline-svg', w: Math.round(rect.width), h: Math.round(rect.height) });
      }
    } catch (_) { /* ignore this SVG */ }
  }

  // <canvas> elements -> PNG snapshots (fails silently for tainted canvases)
  for (const c of canvases) {
    try {
      if (c.width < 2 || c.height < 2) continue;
      const dataUrl = c.toDataURL('image/png');
      if (dataUrl.length > 30e6) continue;
      if (!found.has(dataUrl)) {
        found.set(dataUrl, { url: dataUrl, kind: 'canvas', w: c.width, h: c.height });
      }
    } catch (_) { /* tainted canvas */ }
  }

  // blob: URLs only work inside the page. Small ones travel to the popup as
  // data URLs; larger videos stay here and are handed over in chunks when the
  // user actually downloads them, so their size does not matter.
  const store = window.__pifBlobs || (window.__pifBlobs = new Map());
  const blobKeys = Array.from(found).filter(([key]) => key.startsWith('blob:'));
  dlog('blob: URLs to resolve', blobKeys.map(([key, item]) => ({ key, kind: item.kind, type: item.type })));
  for (const [key, item] of blobKeys) {
    const isVideo = item.type === 'video';
    try {
      const blob = await (await fetch(key)).blob();
      if (!blob.size) throw new Error('empty');
      if (isVideo && blob.size > 24e6) {
        store.set(key, blob);
        item.viaPage = true;
        item.blobSize = blob.size;
        item.blobMime = blob.type || '';
        dlog('blob resolved (large, kept as-is)', key, blob.size, blob.type);
        continue;
      }
      if (!isVideo && blob.size > 25e6) throw new Error('too large');
      item.url = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
      dlog('blob resolved (inlined as data URL)', key, blob.size, blob.type);
    } catch (err) {
      // Videos played through Media Source Extensions have no readable blob
      // (this is the expected/normal case, not a bug); the playlist or
      // segments behind them should be picked up separately via the network scan above.
      dlog('blob could NOT be read - dropping this entry. This is EXPECTED for MSE-based ' +
        'players (like most streaming video sites); the real video should already have been ' +
        'added above as video-stream / video-network. If it was not, that is the real bug.',
        key, item.kind, String(err));
      found.delete(key);
      if (isVideo) blobSkipped++;
    }
  }

  dlog('FINAL result', { totalItems: found.size, blobSkipped, videos: [...found.values()].filter(v => v.type === 'video') });
  return { items: Array.from(found.values()), skipped: blobSkipped };
}

/* ==========================================================================
   Loading details for each image
   ========================================================================== */

async function processEntry(entry) {
  if (isVideo(entry)) return processVideoEntry(entry);
  const { item } = entry;

  let blob = null;
  try {
    const res = await fetch(item.url, { credentials: 'include', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch (_) {
    blob = null;
  }

  let previewSrc = item.url;

  if (blob) {
    if (blob.size === 0) return false;
    entry.format = await sniffFormat(blob, item.url);
    entry.blob = new Blob([blob], { type: MIME[entry.format] || blob.type });
    entry.size = blob.size;
    entry.objectUrl = URL.createObjectURL(entry.blob);
    objectUrls.push(entry.objectUrl);
    previewSrc = entry.objectUrl;
  } else {
    entry.format = formatFromUrl(item.url);
  }

  let img = null;
  try {
    img = await loadImage(previewSrc);
  } catch (_) {
    img = null;
  }

  if (!img) {
    // Keep formats the browser cannot preview (TIFF, HEIC...) but drop anything that is not an image.
    if (!(blob && entry.format)) return false;
  } else {
    entry.w = img.naturalWidth || item.w || 0;
    entry.h = img.naturalHeight || item.h || 0;
  }

  fillRow(entry, Boolean(img), previewSrc);
  return true;
}

// Videos can be huge, so the file itself is not fetched just to read its details:
// size and type come from the response headers, dimensions and length from the metadata.
async function processVideoEntry(entry) {
  if (entry.item.stream) return processStreamEntry(entry);
  if (entry.item.viaPage) return processPageBlobEntry(entry);

  const { item } = entry;
  let src = item.url;
  let mime = '';
  let confirmedVideo = false;

  if (item.url.startsWith('data:')) {
    // Videos that live in the page as blob: URLs arrive here as data URLs.
    const blob = await (await fetch(item.url)).blob();
    if (!blob.size) return false;
    mime = (blob.type || '').toLowerCase();
    entry.blob = blob;
    entry.size = blob.size;
    entry.objectUrl = URL.createObjectURL(blob);
    objectUrls.push(entry.objectUrl);
    src = entry.objectUrl;
    confirmedVideo = true;
  } else {
    const probe = await probeRemote(item.url, item.tabId, item.frameId);
    if (probe) {
      mime = probe.type;
      entry.size = probe.size;
      const octet = !mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream';
      confirmedVideo = mime.startsWith('video/') || (octet && videoExtOf(item.url) !== null);

      // A playlist often has no telling extension; the server type gives it away.
      const asStream = PIFStreams.streamKindFromType(mime);
      if (asStream) {
        item.stream = asStream;
        return processStreamEntry(entry);
      }
      if (mime.startsWith('image/')) {
        item.type = 'image';
        return processEntry(entry);
      }
    }
  }

  if (mime.startsWith('audio/')) return false;
  entry.format = videoFormat(mime, item.url);

  const meta = await loadVideoMeta(src);
  if (meta) {
    entry.w = meta.w || item.w || 0;
    entry.h = meta.h || item.h || 0;
    entry.duration = Number.isFinite(meta.duration) ? meta.duration : null;
  } else if (!confirmedVideo) {
    // A pasted address may still be a playlist that announces nothing useful.
    if (item.kind === 'link' && !item.stream) return processStreamEntry(entry);
    return false;
  } else {
    entry.w = item.w || 0;
    entry.h = item.h || 0;
  }

  fillRow(entry, Boolean(meta), src);
  return true;
}

// A streamed video: read the playlist, work out what the best track is and how
// many segments it has. Nothing is downloaded yet beyond the playlist itself.
async function processStreamEntry(entry) {
  const { item } = entry;
  let plan;
  try {
    plan = await PIFStreams.probe(item.url, { kind: item.stream, tabId: item.tabId, frameId: item.frameId });
  } catch (err) {
    entry.streamError = err.message;
    return false;
  }

  entry.plan = plan;
  entry.format = PIFStreams.formatLabel(plan);
  entry.w = plan.width || item.w || 0;
  entry.h = plan.height || item.h || 0;
  entry.duration = plan.duration || item.duration || null;
  entry.size = plan.estBytes;
  entry.sizeEstimated = entry.size != null;

  const notes = [];
  notes.push(`${plural(plan.segments.length, 'segment')} to join`);
  if (plan.audioSeparate) notes.push('audio is a separate track and is left out');
  if (plan.encrypted && plan.kind === 'dash') {
    entry.protected = true;
    notes.push('protected (DRM), cannot be saved');
  }
  if (plan.live) notes.push('live stream, only the part available now');
  entry.details = notes.join(' · ');

  const preview = await streamPreview(plan, item.tabId, item.frameId);
  fillRow(entry, Boolean(preview), preview);
  return true;
}

// Builds a short playable piece (init + first segment) just for the thumbnail.
async function streamPreview(plan, tabId, frameId) {
  if (plan.container !== 'mp4' || !plan.init || !plan.segments.length) return null;
  try {
    const head = { ...plan, segments: plan.segments.slice(0, 1) };
    const { blob } = await PIFStreams.download(head, { tabId, frameId });
    if (!blob.size || blob.size > 12e6) return null;
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return url;
  } catch (_) {
    return null;
  }
}

// A video the page keeps as a blob that is too large to inline. It stays in the
// page until the user downloads it, so only its details are read here.
async function processPageBlobEntry(entry) {
  const { item } = entry;
  entry.size = item.blobSize || null;
  entry.format = videoFormat((item.blobMime || '').toLowerCase(), item.url);
  entry.w = item.w || 0;
  entry.h = item.h || 0;
  entry.duration = Number.isFinite(item.duration) ? item.duration : null;
  entry.details = 'Held by the page, handed over when you download it';
  fillRow(entry, false, null);
  return true;
}

// Runs inside the target page, so the request carries the page's own
// Referer/Origin/cookies instead of the extension's — some CDNs 403/404 a
// signed file URL otherwise, even though the URL itself is still valid.
// Must be fully self-contained: chrome.scripting serialises this function
// and runs it in the page's own world, so it cannot close over anything
// outside itself.
function __pifPageProbeFile(url) {
  const attempts = ['head', 'range'];
  const tryOne = (i) => {
    if (i >= attempts.length) return null;
    const attempt = attempts[i];
    const init = { credentials: 'include' };
    if (attempt === 'head') init.method = 'HEAD';
    else init.headers = { Range: 'bytes=0-0' };
    return fetch(url, init).then((res) => {
      if (!res.ok) return tryOne(i + 1);
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      let size = null;
      const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      if (total) size = Number(total[1]);
      else if (res.status !== 206 && res.headers.has('content-length')) {
        const len = Number(res.headers.get('content-length'));
        if (Number.isFinite(len)) size = len;
      }
      if (res.body) res.body.cancel().catch(() => {});
      return { type, size };
    }).catch(() => tryOne(i + 1));
  };
  return Promise.resolve(tryOne(0));
}

async function probeRemote(url, tabId, frameId) {
  if (tabId != null && chrome.scripting) {
    try {
      const target = { tabId };
      if (frameId != null) target.frameIds = [frameId];
      const [result] = await chrome.scripting.executeScript({
        target, func: __pifPageProbeFile, args: [url]
      });
      if (result && result.result) return result.result;
    } catch (_) { /* tab closed, restricted page, etc. — fall back below */ }
  }

  for (const attempt of ['head', 'range']) {
    try {
      const init = { credentials: 'include', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
      if (attempt === 'head') init.method = 'HEAD';
      else init.headers = { Range: 'bytes=0-0' };

      const res = await fetch(url, init);
      if (!res.ok) continue;

      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      let size = null;
      const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      if (total) {
        size = Number(total[1]);
      } else if (res.status !== 206 && res.headers.has('content-length')) {
        const len = Number(res.headers.get('content-length'));
        if (Number.isFinite(len)) size = len;
      }
      // Never download the body here (a server may ignore the Range header).
      if (res.body) res.body.cancel().catch(() => {});
      return { type, size };
    } catch (_) { /* try the next way */ }
  }
  return null;
}

function loadVideoMeta(src) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), FETCH_TIMEOUT_MS);
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => done({ w: v.videoWidth, h: v.videoHeight, duration: v.duration });
    v.onerror = () => done(null);
    v.src = src;
  });
}

function videoExtOf(url) {
  try {
    const m = /\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname);
    return m && VIDEO_EXT_FORMAT[m[1].toLowerCase()] ? m[1].toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

function videoFormat(mime, url) {
  if (VIDEO_MIME_FORMAT[mime]) return VIDEO_MIME_FORMAT[mime];
  const ext = videoExtOf(url);
  if (ext) return VIDEO_EXT_FORMAT[ext];
  const m = /^video\/(?:x-)?([a-z0-9]+)/.exec(mime || '');
  return m ? m[1].toUpperCase() : null;
}

function loadImage(src, cors = false) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('Timed out')), FETCH_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('Image failed to load')); };
    if (cors) img.crossOrigin = 'anonymous';
    img.src = src;
  });
}

async function sniffFormat(blob, url) {
  const b = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));

  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'PNG';
  if (b[0] === 0xff && b[1] === 0xd8) return 'JPEG';
  if (ascii(0, 4) === 'GIF8') return 'GIF';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'WEBP';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'AVIF';
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return 'HEIC';
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return 'BMP';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ICO';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return 'TIFF';

  const head = new TextDecoder().decode(b).toLowerCase();
  if (head.includes('<svg')) return 'SVG';

  return formatFromMime(blob.type) || formatFromUrl(url);
}

function formatFromMime(type) {
  const m = /^image\/([a-z0-9.+-]+)/i.exec(type || '');
  if (!m) return null;
  const sub = m[1].toLowerCase();
  if (sub === 'jpeg' || sub === 'jpg' || sub === 'pjpeg') return 'JPEG';
  if (sub === 'svg+xml') return 'SVG';
  if (sub === 'x-icon' || sub === 'vnd.microsoft.icon') return 'ICO';
  if (sub === 'tif') return 'TIFF';
  return sub.toUpperCase();
}

function formatFromUrl(url) {
  const data = /^data:image\/([a-z0-9.+-]+)/i.exec(url);
  if (data) return formatFromMime('image/' + data[1]);
  try {
    const path = new URL(url).pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(path);
    if (!m) return null;
    const ext = m[1].toLowerCase();
    if (!KNOWN_EXT.has(ext)) return null;
    if (ext === 'jpg') return 'JPEG';
    if (ext === 'tif') return 'TIFF';
    return ext.toUpperCase();
  } catch (_) {
    return null;
  }
}

/* ==========================================================================
   Rows
   ========================================================================== */

function createEntry(item, index) {
  const entry = {
    item,
    index,
    name: baseName(item, index),
    blob: null,
    objectUrl: null,
    format: null,
    size: null,
    sizeEstimated: false,
    plan: null,
    details: '',
    w: 0,
    h: 0,
    duration: Number.isFinite(item.duration) ? item.duration : null,
    removed: false
  };

  const row = el('article', 'row is-loading');

  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'pick';
  pick.disabled = true;
  pick.setAttribute('aria-label', `Select ${entry.name}`);
  pick.addEventListener('change', () => {
    row.classList.toggle('is-selected', pick.checked);
    updateSelectionUI();
  });

  const thumb = el('div', 'thumb');
  const note = el('div', 'thumb-note', 'Loading');
  thumb.append(note);

  const info = el('div', 'info');
  const name = el('p', 'name', entry.name);
  name.title = entry.name;
  const url = el('p', 'url', describeSource(item));
  if (!item.url.startsWith('data:')) url.title = item.url;
  const facts = el('div', 'facts');
  facts.append(el('span', 'fact-muted', 'Reading details…'));
  const source = el('p', 'source', KIND_LABELS[item.kind] || (isVideo(entry) ? 'Video' : 'Image'));
  const detailsEl = el('p', 'note');
  detailsEl.hidden = true;
  info.append(name, url, facts, source, detailsEl);

  const actions = el('div', 'actions');
  const dlBtn = actionButton('Download', 'btn btn-download');
  const cpBtn = actionButton(isVideo(entry) ? 'Copy link' : 'Copy to clipboard', 'btn btn-copy');
  dlBtn.disabled = true;
  cpBtn.disabled = true;
  dlBtn.addEventListener('click', () => downloadEntry(entry, dlBtn));
  cpBtn.addEventListener('click', () => copyEntry(entry, cpBtn));
  actions.append(dlBtn, cpBtn);

  row.append(pick, thumb, info, actions);

  Object.assign(entry, { row, pick, thumb, note, detailsEl, facts, dlBtn, cpBtn, ready: false });
  return entry;
}

function fillRow(entry, hasPreview, previewSrc) {
  if (hasPreview && isVideo(entry)) {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.disablePictureInPicture = true;
    // Show a frame just after the start instead of a possibly black first frame.
    video.addEventListener('loadedmetadata', () => {
      try {
        if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(0.1, video.duration / 2);
      } catch (_) { /* keep the first frame */ }
    }, { once: true });
    video.src = previewSrc;
    entry.thumb.replaceChildren(video);
  } else if (hasPreview) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = previewSrc;
    entry.thumb.replaceChildren(img);
  } else {
    entry.note.textContent = entry.plan ? 'Stream' : 'No preview';
  }

  const facts = [];
  facts.push(entry.w && entry.h
    ? el('span', '', `${entry.w} × ${entry.h} px`)
    : el('span', 'fact-muted', 'Size in pixels unknown'));
  facts.push(entry.size != null
    ? el('span', '', (entry.sizeEstimated ? '≈ ' : '') + formatBytes(entry.size))
    : el('span', 'fact-muted', 'File size unknown'));
  facts.push(entry.format
    ? el('span', 'fmt', entry.format)
    : el('span', 'fact-muted', 'Format unknown'));
  if (isVideo(entry) && entry.duration) facts.push(el('span', '', formatDuration(entry.duration)));
  entry.facts.replaceChildren(...facts);

  if (entry.details) {
    entry.detailsEl.textContent = entry.details;
    entry.detailsEl.hidden = false;
  }

  entry.row.classList.remove('is-loading');
  entry.dlBtn.disabled = Boolean(entry.protected);
  if (entry.protected) entry.dlBtn.title = 'This stream is protected and cannot be saved.';
  // Videos cannot go on the clipboard, so they get a "Copy link" button (needs a real web address).
  const copyLabel = isVideo(entry) ? 'Copy link' : 'Copy to clipboard';
  entry.cpBtn.textContent = copyLabel;
  entry.cpBtn.dataset.label = copyLabel;
  entry.cpBtn.disabled = isVideo(entry) && !/^https?:/i.test(entry.item.url);
  entry.pick.disabled = false;
  entry.ready = true;
  updateSelectionUI();
}

function actionButton(label, className) {
  const b = el('button', className, label);
  b.type = 'button';
  b.dataset.label = label;
  return b;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function baseName(item, index) {
  const video = item.type === 'video';
  if (item.kind === 'inline-svg') return `inline-svg-${index}`;
  if (item.kind === 'canvas') return `canvas-${index}`;
  if (item.url.startsWith('data:') || item.url.startsWith('blob:')) {
    return `${video ? 'video' : 'embedded-image'}-${index}`;
  }
  try {
    const u = new URL(item.url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return last || u.hostname;
  } catch (_) {
    return `${video ? 'video' : 'image'}-${index}`;
  }
}

function describeSource(item) {
  if (item.kind === 'inline-svg') return 'Inline <svg> element';
  if (item.kind === 'canvas') return 'Snapshot of a <canvas> element';
  if (item.url.startsWith('blob:')) return 'Video loaded in the page';
  if (item.url.startsWith('data:')) return item.type === 'video' ? 'Video loaded in the page' : 'Embedded data URI';
  return item.url;
}

/* ==========================================================================
   Actions: download and copy
   ========================================================================== */

async function downloadEntry(entry, btn) {
  if (activeJob) {
    toast('One download at a time – wait for the current one to finish.');
    return;
  }
  try {
    if (entry.plan) await saveStream(entry, btn);
    else if (entry.item.viaPage) await savePageBlob(entry, btn);
    else await saveDirect(entry, btn);
  } catch (err) {
    if (err.name === 'AbortError') {
      flash(btn, 'Cancelled', false);
    } else {
      flash(btn, 'Failed', false);
      toast(`Download failed: ${err.message}`);
    }
  } finally {
    endJob();
  }
}

// A plain file: Chrome downloads it, the popup only follows the progress.
async function saveDirect(entry, btn) {
  const job = startJob(`Downloading ${entry.name}`);
  const id = await chrome.downloads.download({
    url: entry.objectUrl || entry.item.url,
    filename: suggestName(entry),
    conflictAction: 'uniquify',
    saveAs: false
  });
  bubbleMayBeOpen = true;
  job.downloadIds.push(id);
  await trackDownloads([id]);
  if (btn) flash(btn, 'Saved', true);
}

// A streamed video: every segment is fetched here and joined into one file.
async function saveStream(entry, btn) {
  const job = startJob(`Downloading ${entry.name}`, true);
  setProgressText(`Joining ${plural(entry.plan.segments.length, 'segment')}…`);

  const { blob, failed } = await PIFStreams.download(entry.plan, {
    signal: job.controller.signal,
    tabId: entry.item.tabId,
    frameId: entry.item.frameId,
    onProgress: (p) => updateProgress({
      bytes: p.bytes,
      total: p.estTotal,
      fraction: p.fraction,
      estimated: true,
      detail: `segment ${p.done} of ${p.total}`
    })
  });

  if (!blob.size) throw new Error('Nothing could be downloaded from this stream.');
  await handOff(entry, blob, job);
  if (btn) flash(btn, 'Saved', true);
  if (failed) toast(`Saved, but ${plural(failed, 'segment')} could not be fetched.`);
}

// A video the page holds as a blob: it is copied out in chunks.
async function savePageBlob(entry, btn) {
  const job = startJob(`Downloading ${entry.name}`, true);
  const total = entry.item.blobSize || 0;
  const parts = [];
  let bytes = 0;

  for (let offset = 0; offset < total; offset += BLOB_CHUNK_BYTES) {
    if (job.controller.signal.aborted) throw abortError();
    const end = Math.min(offset + BLOB_CHUNK_BYTES, total);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: entry.item.tabId, frameIds: [entry.item.frameId] },
      func: pageBlobChunk,
      args: [entry.item.url, offset, end]
    });
    const chunk = result && result.result;
    if (!chunk || chunk.error) {
      throw new Error(
        chunk && chunk.error === 'gone'
          ? 'The page no longer holds this video. Scan the page again.'
          : 'The video could not be read from the page.'
      );
    }
    parts.push(base64ToBytes(chunk.data));
    bytes = end;
    updateProgress({ bytes, total, fraction: total ? bytes / total : null });
  }

  const blob = new Blob(parts, { type: entry.item.blobMime || 'video/mp4' });
  await handOff(entry, blob, job);
  if (btn) flash(btn, 'Saved', true);
}

// Runs inside the page: returns one slice of a blob the page still holds.
function pageBlobChunk(url, start, end) {
  const store = window.__pifBlobs;
  const blob = store && store.get(url);
  if (!blob) return { error: 'gone' };
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ data: String(fr.result).split(',')[1] || '' });
    fr.onerror = () => resolve({ error: 'read' });
    fr.readAsDataURL(blob.slice(start, end));
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Gives a finished blob to Chrome and waits until the file is on disk, so the
// blob address stays valid the whole time.
async function handOff(entry, blob, job) {
  setProgress(1);
  setProgressText(`Saving ${formatBytes(blob.size)} to disk…`);
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  const id = await chrome.downloads.download({
    url,
    filename: suggestName(entry),
    conflictAction: 'uniquify',
    saveAs: false
  });
  bubbleMayBeOpen = true;
  job.downloadIds.push(id);
  await trackDownloads([id], { quiet: true });
}

/* ==========================================================================
   Progress bar
   ========================================================================== */

function startJob(label, longRunning = false) {
  activeJob = { controller: new AbortController(), downloadIds: [], cancelled: false };
  if (longRunning && isPopupWindow()) {
    toast('Keep this window open until the file is saved – or press “Open in tab”.');
  }
  isDownloading = true;
  updateSelectionUI();
  progressLabel.textContent = label;
  progressLabel.title = label;
  progressCancel.disabled = false;
  progressEl.hidden = false;
  setProgress(null);
  setProgressText('Starting…');
  return activeJob;
}

function endJob() {
  activeJob = null;
  isDownloading = false;
  progressEl.hidden = true;
  setProgress(null);
  updateSelectionUI();
}

function cancelJob() {
  if (!activeJob) return;
  activeJob.cancelled = true;
  progressCancel.disabled = true;
  setProgressText('Cancelling…');
  activeJob.controller.abort();
  for (const id of activeJob.downloadIds) {
    if (chrome.downloads && chrome.downloads.cancel) chrome.downloads.cancel(id).catch(() => {});
  }
}

function setProgress(fraction) {
  if (fraction == null) {
    progressFill.classList.add('is-unknown');
    progressFill.style.width = '';
    return;
  }
  progressFill.classList.remove('is-unknown');
  progressFill.style.width = `${Math.max(0, Math.min(100, fraction * 100)).toFixed(1)}%`;
}

function setProgressText(text) {
  progressText.textContent = text;
  progressText.title = text;
}

function updateProgress({ bytes, total, fraction, estimated, detail }) {
  const done = fraction != null ? fraction : (total ? bytes / total : null);
  setProgress(done);

  const parts = [];
  if (done != null) parts.push(`${Math.round(done * 100)}%`);
  if (total) {
    parts.push(`${formatBytes(bytes)} of ${estimated ? '≈ ' : ''}${formatBytes(total)}`);
    parts.push(`${formatBytes(Math.max(0, total - bytes))} left`);
  } else {
    parts.push(`${formatBytes(bytes)} so far`);
  }
  if (detail) parts.push(detail);
  setProgressText(parts.join(' · '));
}

// Follows one or more Chrome downloads until they finish.
function trackDownloads(ids, options = {}) {
  return new Promise((resolve, reject) => {
    const pending = new Set(ids);
    const timer = setInterval(check, 300);
    check();

    async function check() {
      let received = 0;
      let total = 0;
      let totalKnown = true;
      let failure = null;

      for (const id of ids) {
        let item;
        try {
          [item] = await chrome.downloads.search({ id });
        } catch (_) {
          continue;
        }
        if (!item) continue;
        received += item.bytesReceived || 0;
        if (item.totalBytes > 0) total += item.totalBytes;
        else if (item.state === 'complete') total += item.bytesReceived || 0;
        else totalKnown = false;

        if (item.state === 'complete') pending.delete(id);
        else if (item.state === 'interrupted') {
          pending.delete(id);
          if (item.error !== 'USER_CANCELED') failure = item.error || 'interrupted';
        }
      }

      if (!options.quiet) {
        updateProgress({ bytes: received, total: totalKnown && total ? total : 0 });
      }

      if (pending.size) return;
      clearInterval(timer);
      if (activeJob && activeJob.cancelled) reject(abortError());
      else if (failure) reject(new Error(String(failure).toLowerCase().replace(/_/g, ' ')));
      else resolve();
    }
  });
}

function abortError() {
  const err = new Error('Download cancelled.');
  err.name = 'AbortError';
  return err;
}

function isPopupWindow() {
  // The same page opened in a tab is wider than the fixed popup size.
  return !location.search.includes('tab=1');
}

async function openInTab() {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') });
    window.close();
  } catch (_) {
    toast('Could not open a tab.');
  }
}

async function copyEntry(entry, btn) {
  if (isVideo(entry)) {
    try {
      await navigator.clipboard.writeText(entry.item.url);
      flash(btn, 'Copied', true);
    } catch (err) {
      flash(btn, 'Failed', false);
      toast(`Could not copy the link: ${err.message}`);
    }
    return;
  }
  try {
    if (!navigator.clipboard || !window.ClipboardItem) {
      throw new Error('Clipboard access is not available.');
    }
    const png = await getPngBlob(entry);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    flash(btn, 'Copied', true);
  } catch (err) {
    flash(btn, 'Failed', false);
    toast(`Could not copy this image: ${err.message}`);
  }
}

// The clipboard only reliably accepts PNG, so everything else is converted first.
async function getPngBlob(entry) {
  if (entry.format === 'PNG' && entry.blob) {
    return new Blob([entry.blob], { type: 'image/png' });
  }
  const img = entry.objectUrl
    ? await loadImage(entry.objectUrl)
    : await loadImage(entry.item.url, true);

  const w = img.naturalWidth || entry.w || 512;
  const h = img.naturalHeight || entry.h || 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);

  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not convert the image to PNG.'))),
        'image/png'
      );
    } catch (_) {
      reject(new Error('The site does not allow this image to be read.'));
    }
  });
}

function suggestName(entry) {
  const video = isVideo(entry);
  let name = entry.name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .trim() || (video ? 'video' : 'image');

  if (entry.plan) {
    // "index.m3u8" says nothing, so such playlists borrow the site name.
    name = name.replace(/\.(m3u8|m3u|mpd)$/i, '');
    if (!name || /^(index|master|manifest|playlist|stream|video|out|hls|dash)$/i.test(name)) {
      try { name = new URL(entry.item.url).hostname.replace(/^www\./, '') + '-video'; }
      catch (_) { name = 'video'; }
    }
    return `${name.slice(0, 100)}.${entry.plan.container}`;
  }
  if (name.length > 120) name = name.slice(0, 100);
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  const known = m && (video ? VIDEO_EXT_FORMAT[m[1].toLowerCase()] : KNOWN_EXT.has(m[1].toLowerCase()));
  if (!known) name += '.' + extensionFor(entry.format, video);
  return name;
}

function extensionFor(format, video = false) {
  if (format === 'HLS') return 'ts';
  if (format === 'DASH') return 'mp4';
  if (!format) return video ? 'mp4' : 'img';
  if (format === 'JPEG') return 'jpg';
  return format.toLowerCase();
}

/* ==========================================================================
   Selection and bulk download
   ========================================================================== */

function readyEntries() {
  return currentEntries.filter((e) => !e.removed && e.ready);
}

function selectedEntries() {
  return readyEntries().filter((e) => e.pick.checked);
}

function onSelectAllChange() {
  const checked = selectAll.checked;
  for (const entry of readyEntries()) {
    entry.pick.checked = checked;
    entry.row.classList.toggle('is-selected', checked);
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const ready = readyEntries();
  const selected = ready.filter((e) => e.pick.checked);

  selectAll.disabled = isBusy || isDownloading || ready.length === 0;
  selectAll.checked = ready.length > 0 && selected.length === ready.length;
  selectAll.indeterminate = selected.length > 0 && selected.length < ready.length;

  scanBtn.disabled = isBusy || isDownloading;
  modeBtn.disabled = isBusy || isDownloading;
  linkGoBtn.disabled = isBusy || isDownloading;
  linkClearBtn.disabled = isBusy || isDownloading;
  downloadSelectedBtn.disabled = isBusy || isDownloading || selected.length === 0;
  if (isDownloading) {
    downloadSelectedBtn.textContent = 'Downloading…';
  } else {
    downloadSelectedBtn.textContent = selected.length
      ? `Download Selected (${selected.length})`
      : 'Download Selected';
  }
}

async function downloadSelected() {
  if (activeJob) return;
  // Same order as shown in the list
  const chosen = selectedEntries().sort(compareEntries);
  if (!chosen.length) return;

  // Plain files go to Chrome all at once; streams and page-held videos are
  // assembled here, one after another, so the progress bar means something.
  const plain = chosen.filter((e) => !e.plan && !e.item.viaPage);
  const heavy = chosen.filter((e) => e.plan || e.item.viaPage);

  let saved = 0;
  let failed = 0;
  let cancelled = false;

  if (plain.length) {
    const job = startJob(`Downloading ${plural(plain.length, 'file')}`);
    for (const entry of plain) {
      try {
        const id = await chrome.downloads.download({
          url: entry.objectUrl || entry.item.url,
          filename: suggestName(entry),
          conflictAction: 'uniquify',
          saveAs: false
        });
        bubbleMayBeOpen = true;
        job.downloadIds.push(id);
      } catch (_) {
        failed++;
      }
    }
    try {
      if (job.downloadIds.length) await trackDownloads(job.downloadIds);
      saved += job.downloadIds.length;
    } catch (err) {
      if (err.name === 'AbortError') cancelled = true;
      else failed += job.downloadIds.length;
    }
    endJob();
  }

  for (const entry of heavy) {
    if (cancelled) break;
    try {
      if (entry.plan) await saveStream(entry, entry.dlBtn);
      else await savePageBlob(entry, entry.dlBtn);
      saved++;
    } catch (err) {
      if (err.name === 'AbortError') cancelled = true;
      else {
        failed++;
        toast(`${entry.name}: ${err.message}`);
      }
    } finally {
      endJob();
    }
  }

  let msg = `Saved ${plural(saved, 'file')}.`;
  if (failed) msg += ` ${failed} failed.`;
  if (cancelled) msg += ' Cancelled.';
  toast(msg);
}

/* ==========================================================================
   Data type: images / videos (choice is remembered between sessions)
   ========================================================================== */

async function initTypes() {
  try {
    const stored = await chrome.storage.local.get({ dataTypes: ['images'] });
    const saved = Array.isArray(stored.dataTypes) ? stored.dataTypes : [];
    const valid = DATA_TYPES.filter((t) => saved.includes(t));
    if (valid.length) dataTypes = valid;
  } catch (_) { /* fall back to images only */ }
  renderTypes();
}

function onTypeChange(e) {
  const chosen = typeBoxes.filter((b) => b.checked).map((b) => b.value);
  if (!chosen.length) {
    // At least one type has to stay selected.
    e.target.checked = true;
    toast('Keep at least one data type selected.');
    return;
  }
  dataTypes = DATA_TYPES.filter((t) => chosen.includes(t));
  chrome.storage.local.set({ dataTypes }).catch(() => {});
  renderTypes();
}

function renderTypes() {
  typeBoxes.forEach((box) => { box.checked = dataTypes.includes(box.value); });
  typeSummary.textContent = dataTypes.map((t) => TYPE_LABELS[t]).join(', ');
  if (!isBusy) scanBtn.textContent = scanLabel();
  if (!hasScanned) showIntro();
}

function setTypeMenu(open) {
  typeMenu.hidden = !open;
  typeBtn.setAttribute('aria-expanded', String(open));
}

function scanLabel() {
  if (dataTypes.length > 1) return 'Find media';
  return dataTypes[0] === 'videos' ? 'Find videos' : 'Find images';
}

function showIntro() {
  if (mode === 'link') {
    showEmpty('Nothing checked yet', 'Paste the addresses of videos, playlists or images above and press “Check links”.');
    return;
  }
  const what = dataTypes.length > 1 ? 'image and video' : dataTypes[0] === 'videos' ? 'video' : 'image';
  showEmpty('Nothing scanned yet', `Press “${scanLabel()}” to list every ${what} on the current page.`);
}

function mediaNoun(types) {
  if (types.length > 1) return 'images or videos';
  return types[0] === 'videos' ? 'videos' : 'images';
}

function countsText(entries) {
  let images = 0;
  let videos = 0;
  for (const e of entries) {
    if (isVideo(e)) videos++;
    else images++;
  }
  const parts = [];
  if (images) parts.push(plural(images, 'image'));
  if (videos) parts.push(plural(videos, 'video'));
  return parts.join(' and ');
}

function skippedNote(n) {
  return `${plural(n, 'video')} played through the browser's media engine could not be read directly; look for its stream in the list.`;
}

function isVideo(entry) {
  return entry.item.type === 'video';
}

/* ==========================================================================
   Link mode: work from addresses the user pastes instead of from the page
   ========================================================================== */

async function initMode() {
  try {
    const stored = await chrome.storage.local.get({ mode: 'standard', linkText: '' });
    if (stored.mode === 'link') mode = 'link';
    if (typeof stored.linkText === 'string') linkInput.value = stored.linkText;
  } catch (_) { /* start in the standard mode */ }
  applyMode();
}

function setMode(next) {
  if (mode === next || isBusy || isDownloading) return;
  mode = next;
  chrome.storage.local.set({ mode }).catch(() => {});

  scanToken++;            // forget whatever the other mode was still loading
  currentEntries = [];
  hasScanned = false;
  resetList();
  setTypeMenu(false);
  setStatus(mode === 'link'
    ? 'Paste the addresses of the files you want.'
    : 'List every image or video the current tab uses.');
  applyMode();
  updateSelectionUI();
  if (mode === 'link') linkInput.focus();
}

function applyMode() {
  const link = mode === 'link';
  linkPanel.hidden = !link;
  scanBtn.hidden = link;
  typeControl.hidden = link;
  modeBtn.textContent = link ? 'Standard mode' : 'Link mode';
  modeBtn.title = link
    ? 'Go back to listing what the current page uses'
    : 'Download from addresses you paste instead of from the current page';
  if (!hasScanned) showIntro();
}

function rememberLinks() {
  chrome.storage.local.set({ linkText: linkInput.value.slice(0, 20000) }).catch(() => {});
}

function clearLinks() {
  linkInput.value = '';
  rememberLinks();
  linkInput.focus();
}

function parseLinks(text) {
  const seen = new Set();
  const out = [];
  for (const piece of String(text).split(/\s+/)) {
    const raw = piece.trim().replace(/^[<("']+/, '').replace(/[>)"',]+$/, '');
    if (!raw) continue;
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    // A bare word is prose, not an address; a host needs a dot.
    if (!hasScheme && !/^[^/]+\.[^/.]{2,}/.test(raw)) continue;
    let url;
    try {
      url = new URL(hasScheme ? raw : 'https://' + raw);
    } catch (_) {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(url.href);
  }
  return out;
}

// An address alone says little, so the type is a first guess: anything that is
// not clearly an image is treated as video and checked over the network.
function linkItem(url) {
  const stream = PIFStreams.streamKindFromUrl(url);
  const item = { url, kind: 'link', type: !stream && formatFromUrl(url) ? 'image' : 'video', w: 0, h: 0 };
  if (stream) item.stream = stream;
  return item;
}

async function loadLinks() {
  if (isBusy || isDownloading) return;

  const urls = parseLinks(linkInput.value);
  const token = ++scanToken;
  hasScanned = true;
  currentEntries = [];
  resetList();

  if (!urls.length) {
    setStatus('No usable address found – each one needs to look like https://…', true);
    showEmpty('Nothing to check', 'Paste one address per line, then press “Check links”.');
    return;
  }

  setBusy(true);
  setStatus(`Checking ${plural(urls.length, 'address')}…`);

  const entries = urls.map((url, i) => createEntry(linkItem(url), i + 1));
  currentEntries = entries;
  const frag = document.createDocumentFragment();
  entries.forEach((e) => frag.append(e.row));
  listEl.replaceChildren(frag);

  await runQueue(entries, token);
  if (token !== scanToken) return;
  await sortReady;
  if (token !== scanToken) return;

  const shown = entries.filter((e) => !e.removed);
  const dropped = entries.length - shown.length;
  const totalBytes = shown.reduce((sum, e) => sum + (e.size || 0), 0);

  if (!shown.length) {
    setStatus('None of these addresses could be read. They may be gone, private, or not a media file.', true);
    showEmpty('Nothing could be loaded', 'Check the addresses and try again.');
  } else {
    const rough = shown.some((e) => e.sizeEstimated);
    let msg = `${countsText(shown)} ready, ${rough ? '≈ ' : ''}${formatBytes(totalBytes)} in total.`;
    if (dropped) msg += ` ${plural(dropped, 'address')} could not be read.`;
    setStatus(msg);
    applySort();
  }
  setBusy(false);
}

/* ==========================================================================
   Sorting (choice is remembered between sessions)
   ========================================================================== */

async function initSort() {
  try {
    const stored = await chrome.storage.local.get({ sortMode: 'page' });
    if (SORT_MODES.includes(stored.sortMode)) sortMode = stored.sortMode;
  } catch (_) { /* fall back to page order */ }
  sortSelect.value = sortMode;
}

function onSortChange() {
  sortMode = SORT_MODES.includes(sortSelect.value) ? sortSelect.value : 'page';
  chrome.storage.local.set({ sortMode }).catch(() => {});
  applySort();
}

function applySort() {
  const shown = currentEntries.filter((e) => !e.removed);
  if (!shown.length) return;
  shown.sort(compareEntries);
  listEl.replaceChildren(...shown.map((e) => e.row));
  listEl.scrollTop = 0;
}

function compareEntries(a, b) {
  if (sortMode === 'page') return a.index - b.index;

  const [field, direction] = sortMode.split('-');
  const get = field === 'res' ? resolutionOf : sizeOf;
  const av = get(a);
  const bv = get(b);

  // Unknown values always go to the bottom, whatever the direction.
  if (av == null && bv == null) return a.index - b.index;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (av !== bv) return direction === 'asc' ? av - bv : bv - av;
  return a.index - b.index;
}

function resolutionOf(entry) {
  return entry.w && entry.h ? entry.w * entry.h : null;
}

function sizeOf(entry) {
  return entry.size != null ? entry.size : null;
}

/* ==========================================================================
   Chrome download bubble
   ==========================================================================
   After a download Chrome opens its own bubble in the top-right corner, right
   on top of this popup. Chrome has no direct "close bubble" call, so the popup
   switches the download UI off and straight back on, which closes the bubble.
   This only runs after a download that was started from this popup. */

async function dismissDownloadBubble() {
  if (!bubbleMayBeOpen || dismissingBubble) return;
  if (!chrome.downloads || !chrome.downloads.setUiOptions) return;
  dismissingBubble = true;
  bubbleMayBeOpen = false;
  try {
    await chrome.downloads.setUiOptions({ enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
  } catch (_) { /* ignore */ }
  await restoreDownloadUi();
  dismissingBubble = false;
}

// Always leave Chrome's download UI switched on.
async function restoreDownloadUi() {
  try {
    if (chrome.downloads && chrome.downloads.setUiOptions) {
      await chrome.downloads.setUiOptions({ enabled: true });
    }
  } catch (_) { /* ignore */ }
}

/* ==========================================================================
   Small helpers
   ========================================================================== */

function flash(btn, text, ok) {
  clearTimeout(btn._timer);
  btn.textContent = text;
  btn.classList.toggle('is-ok', ok);
  btn.classList.toggle('is-fail', !ok);
  btn._timer = setTimeout(() => {
    btn.textContent = btn.dataset.label;
    btn.classList.remove('is-ok', 'is-fail');
  }, 1600);
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.title = message;
  statusEl.classList.toggle('is-error', isError);
}

function setBusy(busy) {
  isBusy = busy;
  if (busy) setTypeMenu(false);
  sortSelect.disabled = busy;
  typeBtn.disabled = busy;
  scanBtn.disabled = busy;
  scanBtn.textContent = busy ? 'Scanning…' : scanLabel();
  updateSelectionUI();
}

function showEmpty(title, hint) {
  const box = el('div', 'empty');
  box.append(el('strong', '', title), el('p', '', hint));
  listEl.replaceChildren(box);
}

function resetList() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
  listEl.replaceChildren();
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatDuration(sec) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function plural(n, word) {
  if (n === 1) return `${n} ${word}`;
  return `${n} ${word}${/(s|x|z|ch|sh)$/.test(word) ? 'es' : 's'}`;
}
