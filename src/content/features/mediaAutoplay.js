/**
 * mediaAutoplay.js
 * ============================================================================
 * JS-driven feature — Media Autoplay + GIF Originals + Aggressive Autoplay Bypass.
 * HTML class: `pt-autoplay-media`
 *
 * 1. Autoplay every <video> inside pins (muted + loop + playsinline).
 * 2. Force-reveal the "placeholders" — until hover Pinterest renders only a jpg
 *    (pinrep-video--placeholder) and never creates a <video>. We dispatch
 *    synthetic pointer/mouse events into the center of the pin so Pinterest
 *    injects the <video>, and the MutationObserver autoplays it right away.
 * 3. GIF pins that Pinterest serves as a static jpg with the original .gif in
 *    `srcset` — we swap `src` for the original and drop `srcset`.
 * 4. Aggressive autoplay bypass — overrides HTMLMediaElement.prototype.pause,
 *    force-plays every feed video that is ≥15% visible, keeps muted/loop/
 *    playsinline pinned via MutationObserver, and runs a 600 ms heartbeat so
 *    videos keep playing even if Pinterest tries to pause them. Open closeup
 *    pins are excluded so the user keeps full player control.
 *
 * Performance:
 *   - Every element is processed at most once (data marker).
 *   - IntersectionObserver defers work until the element enters the viewport.
 *   - MutationObserver only walks the added subtrees.
 *
 * Selectors maintenance:
 *   Pinterest changes class names on every deploy — all selectors live in
 *   MEDIA_SELECTORS / CLOSEUP_SELECTORS.
 * ============================================================================
 */

import { BaseFeature } from '../core/registry.js';
import { DomObserver } from '../core/observer.js';

export const MEDIA_SELECTORS = {
  pin: '[data-test-id="pin"]',
  video: 'video',

  // Стабильная метка видео-пина — длительность "0:XX"
  videoPinMarker: '[data-test-id="PinTypeIdentifier"]',

  // Плейсхолдер: атрибут вида "9eb7584-vp" — хеш меняется, суффикс -vp стабилен
  videoPlaceholder: '[data-test-id$="-vp"]',

  // Загруженный плеер
  videoPlayer: '.player_1r video',

  gifImg:
    'img[src*=".gif"], img[data-src*=".gif"], ' +
    'img[srcset*=".gif"], img[data-srcset*=".gif"]',

  media:
    'video, [data-test-id$="-vp"], ' +
    'img[src*=".gif"], img[data-src*=".gif"], ' +
    'img[srcset*=".gif"], img[data-srcset*=".gif"]',
};

// ─── Aggressive autoplay bypass constants ────────────────────────────────────

/** Attribute set on videos that must keep playing regardless of Pinterest. */
const FORCE_PLAY_ATTR = 'data-pt-force-play';

/** Selectors of open closeup (pin detail) — never aggressively autoplay there
 *  so the user retains full player control. */
const CLOSEUP_SELECTORS = [
  '[data-test-id="closeup-visual-container"]',
  '[data-test-id="closeup-video-with-visibility"]',
  '[data-test-id="story-pin-video-block"]',
  '[data-test-id="pin-closeup-image"]',
  '[data-video-signature]'
].join(',');

/** Patched once per page — the pause() override lives for the page lifetime. */
let _pausePatched = false;
/** Captured original pause() — the override falls through to it whenever the
 *  force-play attribute is absent, so leaving the patch installed is safe. */
let _originalPause = null;

const MARK = 'ptMediaDone';    // element already processed
const GIF_MARK = 'ptGifOriginal';  // src swapped to the .gif
const HOVER_MARK = 'ptHoverNudged';  // pin already received a synthetic hover
const AGGRESSIVE_MARK = 'ptAggressiveHooked';  // video already hooked by bypass

/** Set to `true` to enable verbose trace logging for debugging. */
const DEBUG = false;

/** Debug-only logger — silent when DEBUG is false. */
function logDebug(...args) {
  if (!DEBUG) return;
  console.debug('[pt-tweaker] [DEBUG]', ...args);
}

/** Fallback release delay for the synthetic hover, ms (if no <video> appears). */
const HOVER_RELEASE_MS = 500;
/** Hover release delay after the <video> appears, ms. */
const HOVER_RELEASE_AFTER_VIDEO_MS = 100;

export const mediaAutoplay = {
  id: 'mediaAutoplay',
  title: 'Media Autoplay',
  type: 'js',
  htmlClass: 'pt-autoplay-media',
  defaultValue: false,
  description: 'Autoplays videos and GIF pins with aggressive feed-video bypass.',
};

export class MediaAutoplayFeature extends BaseFeature {
  constructor(config = mediaAutoplay) {
    super(config);
    /** @type {DomObserver|null} */
    this._observer = null;
    /** @type {IntersectionObserver|null} */
    this._io = null;
    /** @type {Map<Element, number>} pin → delayed hover-release timer id */
    this._pendingLeave = new Map();

    // Aggressive autoplay bypass state
    /** @type {Set<HTMLVideoElement>} videos currently force-playing */
    this._aggressiveVideos = new Set();
    /** @type {number|null} heartbeat interval id */
    this._heartbeatInterval = null;
    /** @type {MutationObserver|null} anti-React attribute observer */
    this._attrObserver = null;
    /** @type {IntersectionObserver|null} visibility observer for force-play */
    this._aggressiveIo = null;
    /** @type {MutationObserver|null} DOM scan observer for new videos */
    this._aggressiveMo = null;
    /** @type {number|null} fallback scan interval id */
    this._fallbackScanInterval = null;

    // Bound handlers (so they can be removed later)
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    this._onAggressiveCanPlay = this._onAggressiveCanPlay.bind(this);
    this._fallbackScan = this._fallbackScan.bind(this);

    logDebug('MediaAutoplayFeature constructed');
  }

  init() {
    this._observer = new DomObserver();
    this._observer.on((mutations) => this._onMutations(mutations));

    this._io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this._processOne(entry.target);
          this._io.unobserve(entry.target);
        }
      },
      { rootMargin: '300px 0px', threshold: 0 }
    );
  }

  onEnable() {
    logDebug('onEnable — starting feature');
    this._observer?.observe();
    this._scan(document);
    this._installAggressiveAutoplay();
    logDebug('onEnable — done');
  }

  onDisable() {
    logDebug('onDisable — tearing down feature');
    this._observer?.disconnect();
    this._io?.disconnect();
    this._clearPendingLeave();
    this._teardownAggressiveAutoplay();
    this._revert();
    logDebug('onDisable — done');
  }

  /** Clear every pending hover-release timer (so none fire after disable). */
  _clearPendingLeave() {
    for (const tid of this._pendingLeave.values()) clearTimeout(tid);
    this._pendingLeave.clear();
  }

  // ─── Mutation plumbing ────────────────────────────────────────────────────

  _onMutations(mutations) {
    logDebug('_onMutations — mutations:', mutations.length);
    for (const mutation of mutations) {
      if (mutation.type !== 'childList' || !mutation.addedNodes.length) continue;
      logDebug('_onMutations — addedNodes:', mutation.addedNodes.length);
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        this._scan(node);
      }
    }
  }

  /** Collect media elements inside root — GIFs processed immediately, video/placeholders via IO. */
  _scan(root) {
    if (root instanceof Element) {
      logDebug('_scan — node:', root.tagName, root.className?.slice(0, 80),
        'test-id:', root.dataset?.testId || '');
    }

    const found = [];
    if (root instanceof Element && root.matches?.(MEDIA_SELECTORS.media)) {
      found.push(root);
    }
    const nested = root.querySelectorAll?.(MEDIA_SELECTORS.media);
    if (nested?.length) found.push(...nested);

    logDebug('_scan — found media elements:', found.length);

    // GIFs: process immediately, no need to wait for intersection.
    const gifs = found.filter((el) => el.matches(MEDIA_SELECTORS.gifImg));
    for (const gif of gifs) {
      if (gif.dataset[GIF_MARK] === '1') continue;
      logDebug('_scan — processing gif immediately:', gif);
      this._gifToOriginal(gif);
    }

    // Video / placeholders: defer to IntersectionObserver.
    for (const el of found) {
      if (el.dataset?.[MARK] === '1') continue;
      if (el.matches(MEDIA_SELECTORS.gifImg)) continue; // already handled above
      logDebug('_scan — observing:', el);
      this._io?.observe(el);
    }
  }

  // ─── Processing ──────────────────────────────────────────────────────────

  _processOne(el) {
    if (!(el instanceof Element)) {
      logDebug('_processOne — not an element, skipping');
      return;
    }

    logDebug('_processOne — processing:', el);

    if (el.matches(MEDIA_SELECTORS.video)) {
      if (el.dataset[MARK] === '1') {
        logDebug('_processOne — video already marked, skipping');
        return;
      }
      el.dataset[MARK] = '1';
      this._autoplayVideo(el);
      this._processAggressiveVideo(el);
      return;
    }

    if (el.matches(MEDIA_SELECTORS.videoPlaceholder)) {
      logDebug('_processOne — found videoPlaceholder', el);
      const pin = el.closest(MEDIA_SELECTORS.pin);
      if (!pin || pin.dataset[HOVER_MARK] === '1') {
        logDebug('_processOne — placeholder skipped (no pin or already nudged)', el);
        return;
      }
      pin.dataset[HOVER_MARK] = '1';
      logDebug('_processOne — nudging pin to reveal video', pin);
      this._nudgePinToRevealVideo(pin);
      return;
    }

    if (el.matches(MEDIA_SELECTORS.gifImg)) {
      if (el.dataset[GIF_MARK] === '1') {
        logDebug('_processOne — gif already marked, skipping');
        return;
      }
      logDebug('_processOne — processing gif img', el);
      this._gifToOriginal(el);
    }
  }


  /**
   * Pinterest only creates the <video> on hover. We dispatch synthetic
   * pointer/mouse enter events into the center of the pin anchor, wait for the
   * <video> to appear and release the hover right away so the pin does not get
   * stuck in the hover state.
   */
  _nudgePinToRevealVideo(pin) {
    logDebug('_nudgePinToRevealVideo — start', pin);

    const target = pin.querySelector('a[href*="/pin/"]') || pin;

    // ⚠️ НЕТ scrollIntoView! Он и вызывал бесконечный автоскролл.
    // Пин уже в viewport (это гарантирует вызывающий код),
    // поэтому dispatch событий прямо по текущим координатам.

    // Клампим координаты в границы viewport — иначе события на нулевых
    // координатах не считаются "наведением".
    const r = target.getBoundingClientRect();
    const x = Math.max(1, Math.min(window.innerWidth - 1, r.left + r.width / 2));
    const y = Math.max(1, Math.min(window.innerHeight - 1, r.top + r.height / 2));

    for (const type of ['pointerover', 'pointermove', 'mouseover', 'mousemove']) {
      try {
        const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        const init = {
          bubbles: true, cancelable: true, composed: true, view: window,
          clientX: x, clientY: y,
        };
        if (type.startsWith('pointer')) {
          init.pointerId = 1; init.pointerType = 'mouse'; init.isPrimary = true;
        }
        target.dispatchEvent(new Ctor(type, init));
      } catch { /* ignore */ }
    }

    pin.dataset[HOVER_MARK] = '2';
    logDebug('_nudgePinToRevealVideo — done');
  }

  _releasePin(pin) {
    // Kept for API compatibility — no longer used by scrollIntoView path.
    // The pin is marked '2' immediately in _nudgePinToRevealVideo.
    logDebug('_releasePin — deprecated, skipping:', pin);
  }

  _centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  /**
   * Single dispatcher for synthetic pointer/mouse events.
   * - pointerover/out + mouseover/out — bubble and carry relatedTarget;
   * - pointerenter/leave + mouseenter/leave — do NOT bubble (as in the browser).
   */
  _dispatchPointer(target, phase, point) {
    const isEnter = phase === 'enter';

    // [type, bubbles]
    const events = isEnter
      ? [
        ['pointerover', true],
        ['pointerenter', false],
        ['pointermove', true],
        ['mouseover', true],
        ['mouseenter', false],
        ['mousemove', true],
      ]
      : [
        ['pointerout', true],
        ['pointerleave', false],
        ['mouseout', true],
        ['mouseleave', false],
      ];

    const PointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;

    for (const [type, bubbles] of events) {
      const isPointer = type.startsWith('pointer');
      const Ctor = isPointer ? PointerCtor : MouseEvent;

      const init = {
        bubbles,
        cancelable: true,
        composed: true,
        view: window,
        clientX: point.x,
        clientY: point.y,
        // relatedTarget only makes sense for non-enter/move events:
        relatedTarget: isEnter ? null : document.body,
      };

      if (isPointer) {
        init.pointerId = 1;
        init.pointerType = 'mouse';
        init.isPrimary = true;
      }

      try {
        target.dispatchEvent(new Ctor(type, init));
      } catch {
        /* ignore */
      }
    }
  }

  // ─── Video autoplay ──────────────────────────────────────────────────────

  _autoplayVideo(video) {
    if (video.dataset?.ptAutoplayed === '1') {
      logDebug('_autoplayVideo — already autoplayed, skipping', video);
      return;
    }
    logDebug('_autoplayVideo — starting', video);
    video.dataset.ptAutoplayed = '1';

    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('autoplay', '');
    video.setAttribute('loop', '');
    video.setAttribute('playsinline', '');
    if (!video.hasAttribute('preload') || video.preload === 'none') {
      video.preload = 'auto';
    }

    const kick = () => this._tryPlay(video);
    kick();

    // Pinterest often swaps the blob: src after mounting — this resets
    // playbackState. Restart on every key event.
    video.addEventListener('loadeddata', kick, { once: true });
    video.addEventListener('canplay', kick, { once: true });
    video.addEventListener('loadedmetadata', kick, { once: true });
    video.addEventListener('loadstart', kick, { once: true });

    const pin = video.closest(MEDIA_SELECTORS.pin);
    if (pin && pin.dataset[HOVER_MARK] === '1') {
      // Small delay so Pinterest has time to "bind" the video to the pin.
      setTimeout(() => this._releasePin(pin), HOVER_RELEASE_AFTER_VIDEO_MS);
    }
    logDebug('_autoplayVideo — done', video);
  }

  _tryPlay(video) {
    logDebug('_tryPlay — calling video.play()', video);
    try {
      const r = video.play();
      if (r && typeof r.catch === 'function') {
        r.catch(() => {
          logDebug('_tryPlay — play() promise rejected', video);
        });
      }
    } catch (err) {
      logDebug('_tryPlay — play() threw', err, video);
    }
  }

  // ─── Aggressive autoplay bypass ──────────────────────────────────────────

  /** Install the global pause() override and start observing videos. */
  _installAggressiveAutoplay() {
    logDebug('_installAggressiveAutoplay — start');

    // Patch the prototype exactly once per page.
    if (!_pausePatched) {
      logDebug('_installAggressiveAutoplay — patching HTMLMediaElement.prototype.pause');
      _originalPause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.pause = function () {
        const isForcePlayed = this.hasAttribute(FORCE_PLAY_ATTR);
        const tabVisible = !document.hidden;
        const inViewport = MediaAutoplayFeature._isElementInViewport(this);
        if (isForcePlayed && tabVisible && inViewport) {
          logDebug('[pause] BLOCKED — force-played & visible', this);
          return; // block Pinterest's pause() on force-played, visible videos
        }
        logDebug('[pause] PASSTHROUGH', {
          isForcePlayed,
          tabVisible,
          inViewport,
          video: this,
        });
        return _originalPause.call(this);
      };
      _pausePatched = true;
    } else {
      logDebug('_installAggressiveAutoplay — pause already patched, skipping');
    }

    // Anti-React: keep muted / loop / playsinline pinned on force-played videos.
    this._attrObserver = new MutationObserver((mutations) => {
      logDebug('_attrObserver callback — mutations:', mutations.length);
      for (const mut of mutations) {
        if (mut.type !== 'attributes') continue;
        const video = mut.target;
        if (!(video instanceof HTMLMediaElement)) continue;
        if (video.hasAttribute(FORCE_PLAY_ATTR)) {
          logDebug('_attrObserver — enforcing attributes on', video);
          this._enforceAttributes(video);
        }
      }
    });

    // Visibility: force-play when ≥15% in viewport, release when it leaves.
    this._aggressiveIo = new IntersectionObserver((entries) => {
      logDebug('_aggressiveIo callback — entries:', entries.length);
      for (const entry of entries) {
        const video = entry.target;
        if (!(video instanceof HTMLMediaElement)) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0.15) {
          logDebug('_aggressiveIo — INTERSECTING ≥15%, force-play', video);
          video.setAttribute(FORCE_PLAY_ATTR, 'true');
          this._aggressiveVideos.add(video);
          this._enforceAttributes(video);
          if (video.paused && video.currentSrc) {
            logDebug('_aggressiveIo — paused & has src, trying play', video);
            this._tryPlay(video);
          }
        } else {
          logDebug('_aggressiveIo — LEFT viewport, release', video);
          video.removeAttribute(FORCE_PLAY_ATTR);
          this._aggressiveVideos.delete(video);
          if (_originalPause) _originalPause.call(video);
        }
      }
    }, { threshold: [0.15, 0.5, 0.8] });

    // Scan newly added DOM for videos.
    this._aggressiveMo = new MutationObserver((mutations) => {
      logDebug('_aggressiveMo callback — mutations:', mutations.length);
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          this._scanAggressive(node);
        }
      }
    });

    logDebug('_installAggressiveAutoplay — scanning document.body');
    this._scanAggressive(document.body);
    this._aggressiveMo.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    this._startHeartbeat();

    document.addEventListener('visibilitychange', this._onVisibilityChange);

    // Fallback scan — catches videos React reuses without addedNodes,
    // and nudges video pins that still lack a <video>.
    this._fallbackScanInterval = setInterval(() => {
      logDebug('[fallbackScan] tick');
      this._fallbackScan();
      this._scanVideoPins();
    }, 2000);

    logDebug('_installAggressiveAutoplay — done');
  }

  /** Tear down the aggressive bypass (called on disable / unload). */
  _teardownAggressiveAutoplay() {
    logDebug('_teardownAggressiveAutoplay — start, force-played videos:', this._aggressiveVideos.size);

    if (this._heartbeatInterval) {
      logDebug('_teardownAggressiveAutoplay — clearing heartbeat');
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    if (this._fallbackScanInterval) {
      logDebug('_teardownAggressiveAutoplay — clearing fallback scan');
      clearInterval(this._fallbackScanInterval);
      this._fallbackScanInterval = null;
    }
    this._attrObserver?.disconnect();
    this._aggressiveIo?.disconnect();
    this._aggressiveMo?.disconnect();
    document.removeEventListener('visibilitychange', this._onVisibilityChange);

    // Release every force-played video so Pinterest can pause it again.
    this._aggressiveVideos.forEach((video) => {
      logDebug('_teardownAggressiveAutoplay — releasing', video);
      video.removeAttribute(FORCE_PLAY_ATTR);
    });
    this._aggressiveVideos.clear();

    document.querySelectorAll(`video[${FORCE_PLAY_ATTR}]`).forEach((video) => {
      logDebug('_teardownAggressiveAutoplay — releasing stray', video);
      video.removeAttribute(FORCE_PLAY_ATTR);
    });

    // Restore original pause() prototype — prevents patch chains on re-enable.
    if (_pausePatched && _originalPause) {
      HTMLMediaElement.prototype.pause = _originalPause;
      logDebug('_teardownAggressiveAutoplay — restored HTMLMediaElement.prototype.pause');
    }
    _pausePatched = false;
    _originalPause = null;

    logDebug('_teardownAggressiveAutoplay — done');
  }

  /** Recursively scan root for <video> elements and hook them. */
  _scanAggressive(root) {
    if (!root) {
      logDebug('_scanAggressive — root is null/undefined, skipping');
      return;
    }
    if (root.tagName === 'VIDEO') {
      logDebug('_scanAggressive — root is VIDEO', root);
      this._processAggressiveVideo(root);
    }
    if (root.querySelectorAll) {
      const videos = root.querySelectorAll('video');
      logDebug('_scanAggressive — found videos:', videos.length);
      videos.forEach((video) => this._processAggressiveVideo(video));
    }
  }

  /** Hook a single <video> into the aggressive bypass. */
  _processAggressiveVideo(video) {
    if (!(video instanceof HTMLVideoElement)) {
      logDebug('_processAggressiveVideo — not HTMLVideoElement, skipping');
      return;
    }
    if (video.dataset[AGGRESSIVE_MARK] === 'true') {
      logDebug('_processAggressiveVideo — already hooked, skipping', video);
      return;
    }

    // Never aggressively autoplay inside an open closeup (pin detail view).
    if (video.closest(CLOSEUP_SELECTORS)) {
      logDebug('_processAggressiveVideo — inside closeup, skipping', video);
      return;
    }

    logDebug('_processAggressiveVideo — hooking', video);
    video.dataset[AGGRESSIVE_MARK] = 'true';

    this._attrObserver?.observe(video, {
      attributes: true,
      attributeFilter: ['muted', 'loop', 'playsinline', 'src'],
    });

    video.addEventListener('canplay', this._onAggressiveCanPlay, true);
    this._aggressiveIo?.observe(video);
    logDebug('_processAggressiveVideo — hooked, observing attr+io', video);
  }

  /** Instant start on canplay when the video is force-played. */
  _onAggressiveCanPlay(event) {
    const video = event.target;
    if (!(video instanceof HTMLMediaElement)) return;
    if (video.hasAttribute(FORCE_PLAY_ATTR) && video.paused) {
      logDebug('_onAggressiveCanPlay — force-played & paused, trying play', video);
      this._tryPlay(video);
    }
  }

  /** Force muted / loop / playsinline attributes (anti-React). */
  _enforceAttributes(video) {
    const changed = [];
    if (!video.muted) { video.muted = true; changed.push('muted'); }
    if (!video.playsInline) { video.playsInline = true; changed.push('playsInline'); }
    if (!video.loop) { video.loop = true; changed.push('loop'); }
    if (!video.hasAttribute('muted')) { video.setAttribute('muted', ''); changed.push('attr:muted'); }
    if (!video.hasAttribute('playsinline')) { video.setAttribute('playsinline', ''); changed.push('attr:playsinline'); }
    if (!video.hasAttribute('loop')) { video.setAttribute('loop', ''); changed.push('attr:loop'); }
    if (changed.length) {
      logDebug('_enforceAttributes — applied:', changed.join(', '), video);
    }
  }

  /** Heartbeat — keeps force-played, visible videos playing. */
  _startHeartbeat() {
    if (this._heartbeatInterval) {
      logDebug('_startHeartbeat — already running, skipping');
      return;
    }
    logDebug('_startHeartbeat — starting (600ms interval)');
    this._heartbeatInterval = setInterval(() => {
      if (document.hidden) {
        logDebug('[heartbeat] tab hidden — skipping');
        return;
      }
      logDebug('[heartbeat] tick — force-played videos:', this._aggressiveVideos.size);
      this._aggressiveVideos.forEach((video) => {
        if (video.paused && video.currentSrc) {
          logDebug('[heartbeat] video paused & has src — trying play', video);
          this._tryPlay(video);
        }
      });
    }, 600); // 2 checks per second
  }

  /** Fallback scan — walks all <video> in DOM and hooks any missed by observers. */
  _fallbackScan() {
    try {
      const videos = document.querySelectorAll('video');
      logDebug('[fallbackScan] found videos in DOM:', videos.length);
      let hooked = 0;
      for (const video of videos) {
        if (video.dataset[AGGRESSIVE_MARK] === 'true') continue;
        if (video.closest(CLOSEUP_SELECTORS)) continue;
        this._processAggressiveVideo(video);
        hooked++;
      }
      if (hooked > 0) {
        logDebug('[fallbackScan] newly hooked videos:', hooked);
      }
    } catch (err) {
      logDebug('[fallbackScan] error:', err);
    }
  }

  /** Scans all pin cards for video pins that still lack a <video> element.
   *  Uses PinTypeIdentifier (duration marker) to detect video pins, then
   *  nudges the placeholder to trigger lazy video injection by Pinterest.
   */
  _scanVideoPins() {
    try {
      const pins = document.querySelectorAll(MEDIA_SELECTORS.pin);
      let nudged = 0;

      for (const pin of pins) {
        // Уже нудили (через IO или через этот таймер) — пропускаем.
        const nudged = pin.dataset[HOVER_MARK];
        if (nudged === '1') continue;                       // ещё в процессе — не трогаем
        if (nudged === '2') {
          const lastAt = Number(pin.dataset.ptNudgeAt || 0);
          if (Date.now() - lastAt < 10_000) continue;       // 10 сек кулдаун
        }

        // Это видео-пин? (метка длительности)
        if (!pin.querySelector(MEDIA_SELECTORS.videoPinMarker)) continue;

        // <video> уже создан — не трогаем.
        if (pin.querySelector(MEDIA_SELECTORS.video)) continue;

        // Есть плейсхолдер? Если нет — пин ещё не отрендерился.
        if (!pin.querySelector(MEDIA_SELECTORS.videoPlaceholder)) continue;

        // КРИТИЧНО: нудим только то, что уже видно. Иначе:
        //   scrollIntoView → infinite scroll → бесконечный цикл.
        //   Без scrollIntoView — Pinterest всё равно проигнорирует
        //   события за пределами viewport (его IO не видит пин).
        const rect = pin.getBoundingClientRect();
        const inViewport =
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth;
        if (!inViewport) continue;

        pin.dataset[HOVER_MARK] = '1';
        logDebug('_scanVideoPins — nudging visible video pin:',
          pin.dataset.testPinId || pin);
        pin.dataset.ptNudgeAt = String(Date.now());
        this._nudgePinToRevealVideo(pin);
        nudged++;
      }

      if (nudged > 0) logDebug('_scanVideoPins — nudged:', nudged);
    } catch (err) {
      logDebug('_scanVideoPins — error:', err);
    }
  }
  /** visibilitychange handler — pause when tab hides, resume when it shows. */
  _onVisibilityChange() {
    logDebug('_onVisibilityChange — document.hidden:', document.hidden, 'force-played:', this._aggressiveVideos.size);
    if (document.hidden) {
      this._aggressiveVideos.forEach((video) => {
        logDebug('_onVisibilityChange — pausing (tab hidden)', video);
        if (_originalPause) _originalPause.call(video);
      });
    } else {
      this._aggressiveVideos.forEach((video) => {
        if (video.paused && video.currentSrc) {
          logDebug('_onVisibilityChange — resuming (tab visible)', video);
          this._tryPlay(video);
        }
      });
    }
  }

  /** Viewport check (≥15% from top/bottom edges). */
  static _isElementInViewport(el) {
    if (!el || !el.getBoundingClientRect) {
      logDebug('_isElementInViewport — invalid element', el);
      return false;
    }
    const rect = el.getBoundingClientRect();
    const result = (
      rect.top < window.innerHeight * 0.85 &&
      rect.bottom > window.innerHeight * 0.15 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );
    logDebug('_isElementInViewport —', result, { rect, innerHeight: window.innerHeight, innerWidth: window.innerWidth });
    return result;
  }

  // ─── GIF → animated original ─────────────────────────────────────────────

  _gifToOriginal(img) {
    logDebug('_gifToOriginal — start', img);
    if (!(img instanceof HTMLImageElement)) {
      logDebug('_gifToOriginal — not HTMLImageElement, skipping');
      return;
    }
    if (img.dataset[GIF_MARK] === '1') {
      logDebug('_gifToOriginal — already processed, skipping');
      return;
    }
    if (img.closest(MEDIA_SELECTORS.video)) {
      logDebug('_gifToOriginal — inside video element, skipping');
      return;
    }
    if (!img.closest(MEDIA_SELECTORS.pin)) {
      logDebug('_gifToOriginal — not inside a pin, skipping');
      return;
    }

    const gifUrl = this._findGifUrl(img);
    if (!gifUrl) {
      logDebug('_gifToOriginal — no gif url found, skipping');
      return;
    }

    const current = (img.currentSrc || img.getAttribute('src') || '').trim();
    if (current === gifUrl) {
      logDebug('_gifToOriginal — src already is the gif, marking done');
      img.dataset[GIF_MARK] = '1';
      return;
    }

    logDebug('_gifToOriginal — swapping src to gif:', gifUrl, 'on', img);
    img.dataset[GIF_MARK] = '1';
    if (img.hasAttribute('src')) img.dataset.ptPrevSrc = img.getAttribute('src');
    else delete img.dataset.ptPrevSrc;
    if (img.hasAttribute('srcset')) img.dataset.ptPrevSrcset = img.getAttribute('srcset');
    else delete img.dataset.ptPrevSrcset;

    // Remove srcset first — otherwise the browser may pick the jpg variant.
    img.removeAttribute('srcset');
    img.src = gifUrl;
    logDebug('_gifToOriginal — done', img);
  }

  /** @returns {string|null} */
  _findGifUrl(img) {
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    if (srcset) {
      for (const entry of srcset.split(',')) {
        const url = entry.trim().split(/\s+/)[0];
        if (url && /\.gif(\?|#|$)/i.test(url)) {
          logDebug('_findGifUrl — found in srcset:', url);
          return url;
        }
      }
    }
    const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
    if (/\.gif(\?|#|$)/i.test(src)) {
      logDebug('_findGifUrl — found in src:', src);
      return src;
    }
    logDebug('_findGifUrl — no gif found');
    return null;
  }

  // ─── Revert on disable ───────────────────────────────────────────────────

  _revert() {
    logDebug('_revert — start');

    document.querySelectorAll('img[data-pt-gif-original="1"]').forEach((img) => {
      logDebug('_revert — restoring gif img', img);
      const prevSrc = img.dataset.ptPrevSrc;
      const prevSrcset = img.dataset.ptPrevSrcset;

      delete img.dataset.ptGifOriginal;
      delete img.dataset.ptPrevSrc;
      delete img.dataset.ptPrevSrcset;

      if (prevSrcset != null) img.setAttribute('srcset', prevSrcset);
      if (prevSrc != null) img.setAttribute('src', prevSrc);
    });

    document.querySelectorAll('video[data-pt-autoplayed="1"]').forEach((video) => {
      logDebug('_revert — restoring autoplayed video', video);
      delete video.dataset.ptAutoplayed;
      video.removeAttribute('autoplay');
      try { video.pause?.(); } catch { /* noop */ }
    });

    document.querySelectorAll('video[data-pt-aggressive-hooked="true"]').forEach((video) => {
      logDebug('_revert — restoring aggressive video', video);
      delete video.dataset.ptAggressiveHooked;
      video.removeAttribute(FORCE_PLAY_ATTR);
    });

    document.querySelectorAll('[data-pt-hover-nudged="1"]').forEach((el) => {
      logDebug('_revert — clearing hover-nudged', el);
      delete el.dataset.ptHoverNudged;
    });
    document.querySelectorAll('[data-pt-media-done="1"]').forEach((el) => {
      logDebug('_revert — clearing media-done', el);
      delete el.dataset.ptMediaDone;
    });

    logDebug('_revert — done');
  }
}