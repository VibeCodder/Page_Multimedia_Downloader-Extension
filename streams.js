'use strict';

/* ==========================================================================
   Page Image Finder – streamed video support (HLS and DASH)

   A streamed video is not one file: the page loads a playlist (.m3u8) or a
   manifest (.mpd) that points at hundreds of small segments. This module
   reads such a playlist, works out what the video is, and can fetch every
   segment and join them back into a single playable file.

   Joining works because the segments of one track are meant to be played
   back to back: MPEG-TS segments concatenate into a .ts file, and fragmented
   MP4 / WebM segments concatenate into a .mp4 / .webm file as long as the
   initialisation segment comes first. Nothing is re-encoded.

   Not supported: DRM (Widevine, FairPlay, SAMPLE-AES) and muxing a separate
   audio track into the video file, which would need a real muxer.
   ========================================================================== */

var PIFStreams = (function () {
  const TIMEOUT_MS = 20000;
  const SEGMENT_CONCURRENCY = 5;
  const PROBE_SEGMENT_LIMIT = 6000; // sanity cap while parsing a playlist

  /* ---------------------------------------------------------------- utils */

  function streamKindFromUrl(url) {
    const path = String(url || '').split(/[?#]/)[0].toLowerCase();
    if (/\.m3u8?$/.test(path)) return 'hls';
    if (/\.mpd$/.test(path)) return 'dash';
    return null;
  }

  function streamKindFromType(type) {
    const t = String(type || '').split(';')[0].trim().toLowerCase();
    if (t === 'application/vnd.apple.mpegurl' || t === 'application/x-mpegurl' ||
        t === 'audio/mpegurl' || t === 'audio/x-mpegurl') return 'hls';
    if (t === 'application/dash+xml') return 'dash';
    return null;
  }

  function signalFor(outer) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    if (!outer) return timeout;
    if (AbortSignal.any) return AbortSignal.any([outer, timeout]);
    return outer;
  }

  /* ---- Page-context fetch bridge -----------------------------------------
     A fetch made from the popup goes out as chrome-extension://… – no
     Referer/Origin/cookies of the real page. Some CDNs sign playlist and
     segment URLs against exactly those, and reject (403/412/404) a request
     that doesn't carry them, even though the URL itself is still valid.

     When a tabId is known (the scan that found this URL came from that
     tab), these helpers run the actual fetch *inside* that tab via
     chrome.scripting.executeScript, so it looks just like the page's own
     player making the request. Every caller still falls back to a direct
     fetch from the extension when no tabId is available (pasted links in
     Link mode) or the bridge fails for any reason (tab closed, restricted
     page, etc.), so behaviour for those cases is unchanged.
     ------------------------------------------------------------------- */

  // Runs inside the target page. Must be fully self-contained: no closures
  // over anything outside this function, since chrome.scripting serialises
  // it and executes it in the page's own world.
  function __pifPageFetchText(url) {
    return fetch(url, { credentials: 'include' }).then((res) =>
      res.text().then((text) => ({
        ok: res.ok, status: res.status,
        type: res.headers.get('content-type') || '',
        url: res.url, text
      }))
    ).catch((err) => ({ ok: false, status: 0, error: String((err && err.message) || err) }));
  }

  function __pifPageFetchBytes(url, offset, length) {
    const init = { credentials: 'include' };
    if (offset != null && length != null) {
      init.headers = { Range: 'bytes=' + offset + '-' + (offset + length - 1) };
    }
    return fetch(url, init).then((res) =>
      res.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return { ok: res.ok, status: res.status, url: res.url, data: btoa(binary) };
      })
    ).catch((err) => ({ ok: false, status: 0, error: String((err && err.message) || err) }));
  }

  function __pifPageFetchHead(url) {
    return fetch(url, { method: 'HEAD', credentials: 'include' }).then((res) => ({
      ok: res.ok, status: res.status, url: res.url,
      contentLength: res.headers.get('content-length')
    })).catch((err) => ({ ok: false, status: 0, error: String((err && err.message) || err) }));
  }

  const PAGE_FETCH_FUNCS = { text: __pifPageFetchText, bytes: __pifPageFetchBytes, head: __pifPageFetchHead };

  // Resolves to null (never rejects) whenever the bridge can't be used, so
  // callers always have a direct-fetch fallback to drop back to.
  async function pageFetch(kind, ctx, args) {
    const tabId = ctx && ctx.tabId;
    if (tabId == null || typeof chrome === 'undefined' || !chrome.scripting) return null;
    try {
      const target = { tabId };
      if (ctx.frameId != null) target.frameIds = [ctx.frameId];
      const [result] = await chrome.scripting.executeScript({ target, func: PAGE_FETCH_FUNCS[kind], args });
      return (result && result.result) || null;
    } catch (_) {
      return null; // tab closed, restricted page (chrome://…), frame gone, etc.
    }
  }

  function base64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function fetchText(url, ctx) {
    const bridged = await pageFetch('text', ctx, [url]);
    if (bridged && bridged.status !== 0) {
      if (!bridged.ok) throw new Error(`HTTP ${bridged.status}`);
      return { text: bridged.text || '', type: bridged.type || '', url: bridged.url || url };
    }
    const res = await fetch(url, { credentials: 'include', signal: signalFor(ctx && ctx.signal) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text(), type: res.headers.get('content-type') || '', url: res.url || url };
  }

  async function fetchBytes(url, range, ctx) {
    const bridged = await pageFetch('bytes', ctx, [url, range ? range.offset : null, range ? range.length : null]);
    if (bridged && bridged.status !== 0) {
      if (!bridged.ok) throw new Error(`HTTP ${bridged.status}`);
      const buf = bridged.data ? base64ToBuf(bridged.data) : new ArrayBuffer(0);
      if (range && buf.byteLength > range.length) return buf.slice(range.offset, range.offset + range.length);
      return buf;
    }
    const init = { credentials: 'include', signal: signalFor(ctx && ctx.signal) };
    if (range) init.headers = { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // A server that ignores Range gives back the whole file; cut it here.
    if (range && buf.byteLength > range.length) {
      return buf.slice(range.offset, range.offset + range.length);
    }
    return buf;
  }

  function absolute(ref, base) {
    try { return new URL(ref, base).href; } catch (_) { return null; }
  }

  function parseAttributes(line) {
    // KEY=value,KEY="value with, comma"
    const out = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(line)) !== null) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return out;
  }

  function parseByteRange(value, previousEnd) {
    if (!value) return null;
    const parts = String(value).split('@');
    const length = Number(parts[0]);
    if (!Number.isFinite(length) || length <= 0) return null;
    const offset = parts.length > 1 ? Number(parts[1]) : previousEnd;
    if (!Number.isFinite(offset)) return null;
    return { offset, length };
  }

  function hexToBytes(hex) {
    const clean = String(hex).replace(/^0x/i, '');
    const out = new Uint8Array(Math.ceil(clean.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  function sequenceIv(seq) {
    const iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    view.setUint32(12, seq >>> 0);
    return iv;
  }

  /* ------------------------------------------------------------------ HLS */

  function parseM3u8(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
    return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
  }

  function parseMaster(lines, baseUrl) {
    const variants = [];
    const audio = new Map(); // GROUP-ID -> rendition
    let pending = null;

    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttributes(line.slice(13));
        if ((a.TYPE || '').toUpperCase() === 'AUDIO' && a['GROUP-ID'] && !audio.has(a['GROUP-ID'])) {
          audio.set(a['GROUP-ID'], { url: a.URI ? absolute(a.URI, baseUrl) : null, name: a.NAME || '' });
        }
        continue;
      }
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const a = parseAttributes(line.slice(18));
        const res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '');
        pending = {
          bandwidth: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0) || 0,
          width: res ? Number(res[1]) : 0,
          height: res ? Number(res[2]) : 0,
          codecs: a.CODECS || '',
          audioGroup: a.AUDIO || null
        };
        continue;
      }
      if (!line || line.startsWith('#')) continue;
      if (pending) {
        pending.url = absolute(line, baseUrl);
        if (pending.url) variants.push(pending);
        pending = null;
      }
    }

    return { type: 'master', variants, audio };
  }

  function parseMedia(lines, baseUrl) {
    const segments = [];
    let duration = 0;
    let seq = 0;
    let live = true;
    let init = null;
    let key = null;            // { method, url, iv }
    let nextDuration = 0;
    let nextRange = null;
    let lastEnd = new Map();   // url -> end offset, for byteranges without an offset
    let targetDuration = 0;

    for (const line of lines) {
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        nextDuration = parseFloat(line.slice(8)) || 0;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        nextRange = line.slice(17).trim();
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        seq = Number(line.slice(22)) || 0;
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = Number(line.slice(22)) || 0;
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        live = false;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttributes(line.slice(11));
        const url = a.URI ? absolute(a.URI, baseUrl) : null;
        if (url) {
          init = { url, range: parseByteRange(a.BYTERANGE, 0) };
        }
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const a = parseAttributes(line.slice(11));
        const method = (a.METHOD || 'NONE').toUpperCase();
        if (method === 'NONE') {
          key = null;
        } else {
          key = {
            method,
            url: a.URI ? absolute(a.URI, baseUrl) : null,
            iv: a.IV ? hexToBytes(a.IV) : null
          };
        }
      } else if (!line.startsWith('#')) {
        const url = absolute(line, baseUrl);
        if (url) {
          const previousEnd = lastEnd.get(url) || 0;
          const range = parseByteRange(nextRange, previousEnd);
          if (range) lastEnd.set(url, range.offset + range.length);
          segments.push({
            url,
            range,
            duration: nextDuration,
            seq: seq + segments.length,
            key: key ? { ...key } : null
          });
          duration += nextDuration;
        }
        nextDuration = 0;
        nextRange = null;
      }

      if (segments.length > PROBE_SEGMENT_LIMIT) break;
    }

    return { type: 'media', segments, duration, live, init, targetDuration };
  }

  async function resolveHls(url, ctx) {
    const first = await fetchText(url, ctx);
    const parsed = parseM3u8(first.text, first.url);

    let mediaUrl = first.url;
    let variant = null;
    let audioSeparate = false;

    if (parsed.type === 'master') {
      if (!parsed.variants.length) throw new Error('This playlist lists no video streams.');
      // Best quality first: resolution, then bitrate.
      variant = parsed.variants.slice().sort((a, b) => {
        const ap = a.width * a.height;
        const bp = b.width * b.height;
        if (ap !== bp) return bp - ap;
        return b.bandwidth - a.bandwidth;
      })[0];
      const rendition = variant.audioGroup ? parsed.audio.get(variant.audioGroup) : null;
      audioSeparate = Boolean(rendition && rendition.url && rendition.url !== variant.url);
      mediaUrl = variant.url;
      const media = await fetchText(mediaUrl, ctx);
      const inner = parseM3u8(media.text, media.url);
      if (inner.type !== 'media') throw new Error('This playlist points at another playlist.');
      return buildHlsPlan(url, inner, variant, audioSeparate);
    }

    return buildHlsPlan(url, parsed, null, false);
  }

  function buildHlsPlan(sourceUrl, media, variant, audioSeparate) {
    if (!media.segments.length) throw new Error('This playlist contains no segments.');

    const encrypted = media.segments.some((s) => s.key);
    const unsupportedKey = media.segments.find((s) => s.key && s.key.method !== 'AES-128');
    if (unsupportedKey) {
      throw new Error(`This stream is protected (${unsupportedKey.key.method}) and cannot be saved.`);
    }

    const container = containerFor(media.init ? media.init.url : media.segments[0].url, variant);
    const bandwidth = variant ? variant.bandwidth : 0;
    const estBytes = bandwidth && media.duration ? Math.round((bandwidth / 8) * media.duration) : null;

    return {
      kind: 'hls',
      sourceUrl,
      container,
      width: variant ? variant.width : 0,
      height: variant ? variant.height : 0,
      duration: media.duration || null,
      estBytes,
      segments: media.segments,
      init: media.init,
      encrypted,
      audioSeparate,
      live: media.live,
      variants: variant ? 1 : 0
    };
  }

  function containerFor(url, variant) {
    const path = String(url || '').split(/[?#]/)[0].toLowerCase();
    if (/\.(mp4|m4s|m4v|cmf[vat])$/.test(path)) return 'mp4';
    if (/\.webm$/.test(path)) return 'webm';
    if (/\.ts$/.test(path)) return 'ts';
    if (variant && /^(avc1|hvc1|hev1|mp4a|av01)/i.test(variant.codecs || '')) return 'mp4';
    return 'ts';
  }

  /* ----------------------------------------------------------------- DASH */

  function isoDuration(value) {
    const m = /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/
      .exec(String(value || '').trim());
    if (!m) return null;
    const n = (x) => (x ? parseFloat(x) : 0);
    return n(m[1]) * 31536000 + n(m[2]) * 2592000 + n(m[3]) * 86400 +
           n(m[4]) * 3600 + n(m[5]) * 60 + n(m[6]);
  }

  function childrenNamed(node, name) {
    return Array.from(node.childNodes || []).filter(
      (c) => c.nodeType === 1 && (c.localName || c.nodeName).replace(/^.*:/, '') === name
    );
  }

  function firstNamed(node, name) {
    return childrenNamed(node, name)[0] || null;
  }

  function baseUrlOf(node, parentBase) {
    const b = firstNamed(node, 'BaseURL');
    const text = b && b.textContent ? b.textContent.trim() : '';
    return text ? (absolute(text, parentBase) || parentBase) : parentBase;
  }

  function fillTemplate(tpl, values) {
    return String(tpl).replace(/\$(\$|[A-Za-z]+)(?:%0(\d+)d)?\$/g, (all, name, pad) => {
      if (name === '$') return '$';
      const v = values[name];
      if (v === undefined || v === null) return all;
      const s = String(v);
      return pad ? s.padStart(Number(pad), '0') : s;
    });
  }

  function parseRange(value) {
    const m = /^(\d+)-(\d+)$/.exec(String(value || '').trim());
    if (!m) return null;
    const offset = Number(m[1]);
    const end = Number(m[2]);
    if (!Number.isFinite(offset) || !Number.isFinite(end) || end < offset) return null;
    return { offset, length: end - offset + 1 };
  }

  async function resolveDash(url, ctx) {
    const res = await fetchText(url, ctx);
    const doc = new DOMParser().parseFromString(res.text, 'application/xml');
    const mpd = doc.documentElement;
    if (!mpd || /parsererror/i.test(mpd.nodeName)) throw new Error('This manifest could not be read.');

    const mpdBase = baseUrlOf(mpd, res.url);
    const totalDuration = isoDuration(mpd.getAttribute('mediaPresentationDuration'));
    const live = (mpd.getAttribute('type') || 'static') === 'dynamic';

    const periods = childrenNamed(mpd, 'Period');
    if (!periods.length) throw new Error('This manifest contains no video.');
    const period = periods[0];
    const periodBase = baseUrlOf(period, mpdBase);
    const periodDuration = isoDuration(period.getAttribute('duration')) || totalDuration;

    let best = null;
    let hasSeparateAudio = false;

    for (const set of childrenNamed(period, 'AdaptationSet')) {
      const setMime = (set.getAttribute('mimeType') || set.getAttribute('contentType') || '').toLowerCase();
      const setBase = baseUrlOf(set, periodBase);
      const reps = childrenNamed(set, 'Representation');

      for (const rep of reps) {
        const mime = (rep.getAttribute('mimeType') || setMime || '').toLowerCase();
        if (mime.startsWith('audio')) { hasSeparateAudio = true; continue; }
        if (mime && !mime.startsWith('video')) continue;

        const width = Number(rep.getAttribute('width') || set.getAttribute('width') || 0) || 0;
        const height = Number(rep.getAttribute('height') || set.getAttribute('height') || 0) || 0;
        const bandwidth = Number(rep.getAttribute('bandwidth') || 0) || 0;
        const score = width * height * 1e6 + bandwidth;
        if (best && score <= best.score) continue;
        best = { score, rep, set, setBase, mime, width, height, bandwidth };
      }
    }

    if (!best) throw new Error('This manifest contains no downloadable video track.');

    const repBase = baseUrlOf(best.rep, best.setBase);
    const built = buildDashSegments(best, repBase, periodDuration);
    if (!built.segments.length) throw new Error('This manifest lists no video segments.');

    const estBytes = best.bandwidth && periodDuration
      ? Math.round((best.bandwidth / 8) * periodDuration)
      : null;

    return {
      kind: 'dash',
      sourceUrl: url,
      container: best.mime.includes('webm') ? 'webm' : 'mp4',
      width: best.width,
      height: best.height,
      duration: periodDuration || null,
      estBytes,
      segments: built.segments,
      init: built.init,
      encrypted: Boolean(firstNamed(best.set, 'ContentProtection') || firstNamed(best.rep, 'ContentProtection')),
      audioSeparate: hasSeparateAudio,
      live,
      variants: 1
    };
  }

  function buildDashSegments(best, base, periodDuration) {
    const { rep, set } = best;
    const template = firstNamed(rep, 'SegmentTemplate') || firstNamed(set, 'SegmentTemplate');
    const list = firstNamed(rep, 'SegmentList') || firstNamed(set, 'SegmentList');
    const segmentBase = firstNamed(rep, 'SegmentBase') || firstNamed(set, 'SegmentBase');
    const id = rep.getAttribute('id') || '';
    const bandwidth = rep.getAttribute('bandwidth') || '';
    const segments = [];
    let init = null;

    if (template) {
      const timescale = Number(template.getAttribute('timescale') || 1) || 1;
      const startNumber = Number(template.getAttribute('startNumber') || 1) || 1;
      const initTpl = template.getAttribute('initialization');
      const mediaTpl = template.getAttribute('media');

      if (initTpl) {
        const url = absolute(fillTemplate(initTpl, { RepresentationID: id, Bandwidth: bandwidth }), base);
        if (url) init = { url, range: null };
      }
      if (!mediaTpl) return { segments, init };

      const timeline = firstNamed(template, 'SegmentTimeline');
      if (timeline) {
        let number = startNumber;
        let time = 0;
        let first = true;
        for (const s of childrenNamed(timeline, 'S')) {
          const t = s.getAttribute('t');
          const d = Number(s.getAttribute('d') || 0) || 0;
          const r = Number(s.getAttribute('r') || 0) || 0;
          if (t !== null && t !== undefined && t !== '') time = Number(t) || 0;
          else if (!first) time += 0; // time already advanced below
          first = false;
          const repeats = r < 0 ? Math.max(0, Math.floor(((periodDuration || 0) * timescale - time) / (d || 1)) ) : r;
          for (let i = 0; i <= repeats; i++) {
            const url = absolute(
              fillTemplate(mediaTpl, { RepresentationID: id, Bandwidth: bandwidth, Number: number, Time: time }),
              base
            );
            if (url) segments.push({ url, range: null, duration: d / timescale, seq: number, key: null });
            number++;
            time += d;
            if (segments.length > PROBE_SEGMENT_LIMIT) break;
          }
          if (segments.length > PROBE_SEGMENT_LIMIT) break;
        }
      } else {
        const segDuration = Number(template.getAttribute('duration') || 0) || 0;
        if (!segDuration || !periodDuration) return { segments, init };
        const seconds = segDuration / timescale;
        const count = Math.ceil(periodDuration / seconds);
        for (let i = 0; i < count && i <= PROBE_SEGMENT_LIMIT; i++) {
          const number = startNumber + i;
          const url = absolute(
            fillTemplate(mediaTpl, {
              RepresentationID: id, Bandwidth: bandwidth, Number: number, Time: i * segDuration
            }),
            base
          );
          if (url) segments.push({ url, range: null, duration: seconds, seq: number, key: null });
        }
      }
      return { segments, init };
    }

    if (list) {
      const timescale = Number(list.getAttribute('timescale') || 1) || 1;
      const segDuration = Number(list.getAttribute('duration') || 0) || 0;
      const initEl = firstNamed(list, 'Initialization');
      if (initEl) {
        const url = absolute(initEl.getAttribute('sourceURL') || '', base) || base;
        init = { url, range: parseRange(initEl.getAttribute('range')) };
      }
      let n = 0;
      for (const s of childrenNamed(list, 'SegmentURL')) {
        const url = absolute(s.getAttribute('media') || '', base) || base;
        segments.push({
          url,
          range: parseRange(s.getAttribute('mediaRange')),
          duration: segDuration ? segDuration / timescale : 0,
          seq: n++,
          key: null
        });
      }
      return { segments, init };
    }

    // SegmentBase: the whole track is one file, so there is nothing to join.
    if (segmentBase || base) {
      const initEl = segmentBase ? firstNamed(segmentBase, 'Initialization') : null;
      const initRange = initEl ? parseRange(initEl.getAttribute('range')) : null;
      if (initRange) init = { url: base, range: initRange };
      segments.push({
        url: base,
        range: null,
        duration: periodDuration || 0,
        seq: 0,
        key: null,
        wholeFile: true
      });
      return { segments, init: null };
    }

    return { segments, init };
  }

  /* ------------------------------------------------------------- download */

  const keyCache = new Map();

  async function keyFor(url, ctx) {
    if (keyCache.has(url)) return keyCache.get(url);
    const promise = (async () => {
      const raw = await fetchBytes(url, null, ctx);
      if (raw.byteLength !== 16) throw new Error('Unexpected key length.');
      return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    })();
    keyCache.set(url, promise);
    return promise;
  }

  async function fetchSegment(segment, ctx) {
    let buf = await fetchBytes(segment.url, segment.range, ctx);
    if (segment.key && segment.key.method === 'AES-128') {
      if (!segment.key.url) throw new Error('This stream is encrypted but gives no key.');
      const key = await keyFor(segment.key.url, ctx);
      const iv = segment.key.iv || sequenceIv(segment.seq);
      buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buf);
    }
    return buf;
  }

  // A playlist that carries no bitrate leaves the file size unknown; one look
  // at the first segment is enough for a rough figure.
  async function estimateSize(plan, ctx) {
    if (plan.estBytes || !plan.segments.length) return plan;
    const first = plan.segments[0];
    if (first.range) {
      plan.estBytes = first.range.length * plan.segments.length;
      return plan;
    }
    try {
      const bridged = await pageFetch('head', ctx, [first.url]);
      let len = null;
      if (bridged && bridged.status !== 0) {
        if (bridged.ok) len = Number(bridged.contentLength);
      } else {
        const res = await fetch(first.url, {
          method: 'HEAD', credentials: 'include', signal: signalFor(ctx && ctx.signal)
        });
        if (res.ok) len = Number(res.headers.get('content-length'));
      }
      if (Number.isFinite(len) && len > 0) plan.estBytes = len * plan.segments.length;
    } catch (_) { /* size stays unknown */ }
    return plan;
  }

  // Resolve a playlist URL into a plan: what the video is and how to fetch it.
  // options.tabId/frameId (when known) route the network calls above through
  // the page itself instead of the extension — see the fetch bridge notes up top.
  async function probe(url, options = {}) {
    const kind = options.kind || streamKindFromUrl(url);
    const ctx = { signal: options.signal, tabId: options.tabId, frameId: options.frameId };
    if (kind === 'dash') return estimateSize(await resolveDash(url, ctx), ctx);
    if (kind === 'hls') return estimateSize(await resolveHls(url, ctx), ctx);

    // No extension: look at what the server sends back.
    const head = await fetchText(url, ctx);
    const byType = streamKindFromType(head.type);
    if (byType === 'dash' || /<MPD[\s>]/i.test(head.text.slice(0, 2000))) {
      const doc = new DOMParser().parseFromString(head.text, 'application/xml');
      if (doc.documentElement && /MPD/i.test(doc.documentElement.nodeName)) return resolveDash(head.url, ctx);
    }
    if (byType === 'hls' || head.text.trimStart().startsWith('#EXTM3U')) {
      const parsed = parseM3u8(head.text, head.url);
      if (parsed.type === 'master') return estimateSize(await resolveHls(head.url, ctx), ctx);
      return estimateSize(buildHlsPlan(url, parsed, null, false), ctx);
    }
    throw new Error('This address is not a stream playlist.');
  }

  // Fetch every segment and join them into one file.
  async function download(plan, options = {}) {
    const { onProgress, signal, tabId, frameId } = options;
    const ctx = { signal, tabId, frameId };
    const total = plan.segments.length;
    const parts = new Array(total);
    let bytes = 0;
    let done = 0;
    let initBytes = 0;

    const report = () => {
      if (!onProgress) return;
      const fraction = total ? done / total : 0;
      let estTotal = plan.estBytes || null;
      if (done >= 2 && fraction > 0) {
        // What the segments so far suggest, trusted more and more as the
        // download goes on, so the estimate lands on the real size at the end.
        const running = Math.round(bytes / fraction);
        estTotal = estTotal ? Math.round(running * fraction + estTotal * (1 - fraction)) : running;
      }
      if (estTotal && estTotal < bytes) estTotal = bytes;
      onProgress({ bytes, done, total, estTotal, fraction });
    };

    let initPart = null;
    if (plan.init) {
      const buf = await fetchBytes(plan.init.url, plan.init.range, ctx);
      initPart = buf;
      initBytes = buf.byteLength;
      bytes += initBytes;
      report();
    }

    let next = 0;
    let failed = 0;
    const worker = async () => {
      while (next < total) {
        if (signal && signal.aborted) throw abortError();
        const index = next++;
        try {
          const buf = await fetchSegment(plan.segments[index], ctx);
          parts[index] = buf;
          bytes += buf.byteLength;
        } catch (err) {
          if (signal && signal.aborted) throw abortError();
          // A single missing segment should not throw the whole video away.
          failed++;
          if (failed > Math.max(3, total * 0.02)) throw err;
          parts[index] = new ArrayBuffer(0);
        }
        done++;
        report();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(SEGMENT_CONCURRENCY, total) }, worker)
    );

    const pieces = initPart ? [initPart, ...parts] : parts;
    const blob = new Blob(pieces.filter(Boolean), { type: mimeFor(plan.container) });
    return { blob, bytes: blob.size, failed };
  }

  function abortError() {
    const err = new Error('Download cancelled.');
    err.name = 'AbortError';
    return err;
  }

  function mimeFor(container) {
    if (container === 'mp4') return 'video/mp4';
    if (container === 'webm') return 'video/webm';
    return 'video/mp2t';
  }

  function formatLabel(plan) {
    return plan.kind === 'dash' ? 'DASH' : 'HLS';
  }

  return {
    probe,
    download,
    streamKindFromUrl,
    streamKindFromType,
    mimeFor,
    formatLabel,
    // exposed for tests
    _parseM3u8: parseM3u8,
    _isoDuration: isoDuration,
    _fillTemplate: fillTemplate
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PIFStreams;
