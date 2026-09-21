'use strict';

/* ==========================================================================
   Page Multimedia Downloader – early network watcher

   Runs at document_start, in every frame, on every page. Its only job is to
   make sure the address of a streamed video (its .m3u8/.mpd playlist, or the
   segments a player fetches with fetch()/XHR instead of a <video> element)
   is still known by the time the user opens the popup and scans.

   Without this, two things make streamed video invisible on some sites:

   1. The Performance Resource Timing buffer holds a limited number of
      entries (250 by default). Pages that load a lot of ads and trackers –
      exactly the sites that also stream video – fill that buffer within a
      few seconds, evicting the very manifest/segment requests we need
      before the user ever clicks "Find images". This script raises the
      buffer size immediately, before those other requests start.

   2. Modern players load segments with fetch() or XMLHttpRequest rather
      than by setting a <video src>, so the browser tags the matching
      Resource Timing entry as initiatorType "fetch"/"xmlhttprequest", not
      "video"/"media". Relying on that tag misses them entirely. This script
      watches fetch()/XHR directly instead, so the request is recorded no
      matter how the player made it.
   ========================================================================== */

(() => {
  if (window.__pifWatchInstalled) return;
  window.__pifWatchInstalled = true;

  const STREAM_RE = /\.(m3u8|m3u|mpd)(?:$|[?#])/i;
  const VIDEO_RE = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|mpe?g|3gp|flv|wmv|m4s|ts)(?:$|[?#])/i;
  const MAX_ENTRIES = 500; // enough to remember a playlist plus a first batch of segments

  const store = window.__pifNetworkVideos || (window.__pifNetworkVideos = new Map());

  const DEBUG = true; // TEMP: flip to false once the issue is found

  function record(raw, initiator) {
    if (typeof raw !== 'string' || !raw) return;
    let url;
    try { url = new URL(raw, document.baseURI).href; } catch (_) {
      if (DEBUG) console.debug('[PIF watch] could not resolve URL, skipped:', raw);
      return;
    }
    const stream = STREAM_RE.test(url);
    if (!stream && !VIDEO_RE.test(url)) return; // not a video/playlist URL at all, ignore silently
    if (store.has(url)) return;
    if (store.size >= MAX_ENTRIES) {
      if (DEBUG) console.warn('[PIF watch] MAX_ENTRIES reached, dropping:', url);
      return;
    }
    store.set(url, { url, stream, initiator });
    if (DEBUG) console.log('[PIF watch] recorded', { url, stream, initiator, storeSize: store.size });
  }

  if (DEBUG) {
    console.log('[PIF watch] installing at', location.href, 'readyState=', document.readyState);
  }

  /* ---- 1. Keep the Resource Timing buffer from filling up before scan ---- */
  try {
    if (performance.setResourceTimingBufferSize) {
      performance.setResourceTimingBufferSize(20000);
      window.addEventListener('resourcetimingbufferfull', () => {
        try {
          const grown = performance.getEntriesByType('resource').length + 20000;
          performance.setResourceTimingBufferSize(grown);
        } catch (_) { /* ignore */ }
      });
    }
  } catch (_) { /* Performance API not available in this context */ }

  /* ---- 2. Watch fetch() and XMLHttpRequest directly ---- */
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url);
          record(url, 'fetch');
        } catch (_) { /* ignore */ }
        return origFetch.apply(this, arguments);
      };
      if (DEBUG) console.log('[PIF watch] fetch patched OK');
    } else if (DEBUG) {
      console.warn('[PIF watch] window.fetch is not a function, cannot patch', typeof origFetch);
    }
  } catch (err) {
    if (DEBUG) console.warn('[PIF watch] fetch patch threw:', err);
  }

  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { record(url, 'xhr'); } catch (_) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    if (DEBUG) console.log('[PIF watch] XHR.open patched OK');
  } catch (err) {
    if (DEBUG) console.warn('[PIF watch] XHR patch threw:', err);
  }

  // A page can spawn Worker/SharedWorker threads (common for HLS.js / Shaka
  // Player "low-latency" or worker-loader builds). Those workers get their
  // OWN global scope with their own fetch/XHR - this content script only
  // patches the main page, so any segment requests issued from inside a
  // Worker are invisible to us. Flag it here rather than silently missing them.
  try {
    const OrigWorker = window.Worker;
    if (typeof OrigWorker === 'function') {
      window.Worker = function (...args) {
        if (DEBUG) console.warn('[PIF watch] page created a Worker - fetch/XHR inside it will NOT be captured:', args[0]);
        return new OrigWorker(...args);
      };
      window.Worker.prototype = OrigWorker.prototype;
    }
  } catch (_) { /* ignore */ }
})();
