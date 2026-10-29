/**
 * mediaAutoplay.js
 * ============================================================================
 * JS-driven feature — Media Autoplay + GIF Originals + Aggressive Autoplay Bypass.
 *
 * Разбито на три независимые под-фичи (все живут в этом файле):
 *
 *   GIF Autoplay   (htmlClass: `pt-autoplay-gif`)   → GifAutoplayFeature
 *     1. GIF pins that Pinterest serves as a static jpg with the original .gif
 *        in `srcset` — we swap `src` for the original and drop `srcset`.
 *
 *   Video Autoplay (htmlClass: `pt-autoplay-video`) → VideoAutoplayFeature
 *     1. Autoplay every <video> inside pins (muted + loop + playsinline).
 *     2. Force-reveal the "placeholders" — until hover Pinterest renders only
 *        a jpg (pinrep-video--placeholder) and never creates a <video>. We
 *        dispatch synthetic pointer/mouse events into the center of the pin
 *        so Pinterest injects the <video>, and the MutationObserver autoplays
 *        it right away.
 *     3. Aggressive autoplay bypass — overrides HTMLMediaElement.prototype.pause,
 *        force-plays every feed video that is ≥15% visible, keeps muted/loop/
 *        playsinline pinned via MutationObserver, and runs a 600 ms heartbeat
 *        so videos keep playing even if Pinterest tries to pause them. Open
 *        closeup pins are excluded so the user keeps full player control.
 *
 *   Carousel Autoplay (htmlClass: `pt-autoplay-carousel`) → CarouselAutoplayFeature
 *     1. Advances carousel pins one slide forward (wraps last→first) on a
 *        timer — the interval is a user setting (0.1–1000 s slider).
 *
 * Performance:
 *   - Every element is processed at most once (data marker).
 *   - IntersectionObserver defers work until the element enters the viewport.
 *   - MutationObserver only walks the added subtrees.
 *
 * Selectors maintenance:
 *   Pinterest changes class names on every deploy — all selectors live in
 *   GIF_SELECTORS / MEDIA_SELECTORS / CLOSEUP_SELECTORS / CAROUSEL_SELECTORS.
 * ============================================================================
 */

import { BaseFeature } from '../core/registry.js';
import { DomObserver } from '../core/observer.js';

// ─── GIF selectors ───────────────────────────────────────────────────────────

export const GIF_SELECTORS = {
  pin: '[data-test-id="pin"]',
  video: 'video',

  gifImg:
    'img[src*=".gif"], img[data-src*=".gif"], ' +
    'img[srcset*=".gif"], img[data-srcset*=".gif"]',
};

// ─── Video selectors ─────────────────────────────────────────────────────────

export const MEDIA_SELECTORS = {
  pin: '[data-test-id="pin"]',
  video: 'video',

  // Стабильная метка видео-пина — длительность "0:XX"
  videoPinMarker: '[data-test-id="PinTypeIdentifier"]',

  // Плейсхолдер: атрибут вида "9eb7584-vp" — хеш меняется, суффикс -vp стабилен
  videoPlaceholder: '[data-test-id$="-vp"]',

  // Загруженный плеер
  videoPlayer: '.player_1r video',

  media: 'video, [data-test-id$="-vp"]',
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

const MARK = 'ptMediaDone';           // element already processed
const GIF_MARK = 'ptGifOriginal';     // src swapped to the .gif
const HOVER_MARK = 'ptHoverNudged';   // pin already received a synthetic hover
const AGGRESSIVE_MARK = 'ptAggressiveHooked'; // video already hooked by bypass

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

// ============================================================================
// Feature configs — registry entries
// ============================================================================

export const gifAutoplay = {
  id: 'gifAutoplay',
  title: 'GIF autoplay',
  type: 'js',
  htmlClass: 'pt-autoplay-gif',
  defaultValue: false,
  description: 'Replaces static GIF-pin thumbnails with the original animated .gif',
};

export const videoAutoplay = {
  id: 'videoAutoplay',
  title: 'Video autoplay',
  type: 'js',
  htmlClass: 'pt-autoplay-video',
  defaultValue: false,
  description: 'Autoplays pin videos and aggressively bypasses Pinterest pause in the feed',
};

// ============================================================================
// GIF Autoplay
// ============================================================================

export class GifAutoplayFeature extends BaseFeature {
  constructor(config = gifAutoplay) {
    super(config);
    /** @type {DomObserver|null} */
    this._observer = null;

    logDebug('GifAutoplayFeature constructed');
  }

  init() {
    this._observer = new DomObserver();
    this._observer.on((mutations) => this._onMutations(mutations));
  }

  onEnable() {
    logDebug('GifAutoplayFeature onEnable — starting');
    this._observer?.observe();
    this._scan(document);
    logDebug('GifAutoplayFeature onEnable — done');
  }

  onDisable() {
    logDebug('GifAutoplayFeature onDisable — tearing down');
    this._observer?.disconnect();
    this._revert();
    logDebug('GifAutoplayFeature onDisable — done');
  }

  // ─── Mutation plumbing ────────────────────────────────────────────────────

  _onMutations(mutations) {
    logDebug('gif _onMutations — mutations:', mutations.length);
    for (const mutation of mutations) {
      if (mutation.type !== 'childList' || !mutation.addedNodes.length) continue;
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        this._scan(node);
      }
    }
  }

  /** Collect GIF images inside root and process them immediately. */
  _scan(root) {
    const found = [];
    if (root instanceof Element && root.matches?.(GIF_SELECTORS.gifImg)) {
      found.push(root);
    }
    const nested = root.querySelectorAll?.(GIF_SELECTORS.gifImg);
    if (nested?.length) found.push(...nested);

    for (const gif of found) {
      if (gif.dataset[GIF_MARK] === '1') continue;
      logDebug('gif _scan — processing gif:', gif);
      this._gifToOriginal(gif);
    }
  }

  // ─── GIF → animated original ─────────────────────────────────────────────

  _gifToOriginal(img) {
    if (!(img instanceof HTMLImageElement)) return;
    if (img.dataset[GIF_MARK] === '1') return;
    if (img.closest(GIF_SELECTORS.video)) return;
    if (!img.closest(GIF_SELECTORS.pin)) return;

    const gifUrl = this._findGifUrl(img);
    if (!gifUrl) return;

    const current = (img.currentSrc || img.getAttribute('src') || '').trim();
    if (current === gifUrl) {
      img.dataset[GIF_MARK] = '1';
      return;
    }

    logDebug('gif _gifToOriginal — swap:', gifUrl);
    img.dataset[GIF_MARK] = '1';
    if (img.hasAttribute('src')) img.dataset.ptPrevSrc = img.getAttribute('src');
    else delete img.dataset.ptPrevSrc;
    if (img.hasAttribute('srcset')) img.dataset.ptPrevSrcset = img.getAttribute('srcset');
    else delete img.dataset.ptPrevSrcset;

    // Remove srcset first — otherwise the browser may pick the jpg variant.
    img.removeAttribute('srcset');
    img.src = gifUrl;
  }

  /** @returns {string|null} */
  _findGifUrl(img) {
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    if (srcset) {
      for (const entry of srcset.split(',')) {
        const url = entry.trim().split(/\s+/)[0];
        if (url && /\.gif(\?|#|$)/i.test(url)) return url;
      }
    }
    const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
    if (/\.gif(\?|#|$)/i.test(src)) return src;
    return null;
  }

  // ─── Revert ──────────────────────────────────────────────────────────────

  _revert() {
    document.querySelectorAll('img[data-pt-gif-original="1"]').forEach((img) => {
      const prevSrc = img.dataset.ptPrevSrc;
      const prevSrcset = img.dataset.ptPrevSrcset;

      delete img.dataset.ptGifOriginal;
      delete img.dataset.ptPrevSrc;
      delete img.dataset.ptPrevSrcset;

      if (prevSrcset != null) img.setAttribute('srcset', prevSrcset);
      if (prevSrc != null) img.setAttribute('src', prevSrc);
    });
  }
}

// ============================================================================
// Video Autoplay (+ Aggressive bypass)
// ============================================================================

export class VideoAutoplayFeature extends BaseFeature {
  constructor(config = videoAutoplay) {
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

    logDebug('VideoAutoplayFeature constructed');
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
    logDebug('VideoAutoplayFeature onEnable — starting');
    this._observer?.observe();
    this._scan(document);
    this._installAggressiveAutoplay();
    logDebug('VideoAutoplayFeature onEnable — done');
  }

  onDisable() {
    logDebug('VideoAutoplayFeature onDisable — tearing down');
    this._observer?.disconnect();
    this._io?.disconnect();
    this._clearPendingLeave();
    this._teardownAggressiveAutoplay();
    this._revert();
    logDebug('VideoAutoplayFeature onDisable — done');
  }

  _clearPendingLeave() {
    for (const tid of this._pendingLeave.values()) clearTimeout(tid);
    this._pendingLeave.clear();
  }

  // ─── Mutation plumbing ────────────────────────────────────────────────────

  _onMutations(mutations) {
    logDebug('video _onMutations — mutations:', mutations.length);
    for (const mutation of mutations) {
      if (mutation.type !== 'childList' || !mutation.addedNodes.length) continue;
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        this._scan(node);
      }
    }
  }

  /** Collect video / placeholder elements inside root and defer them to IO. */
  _scan(root) {
    const found = [];
    if (root instanceof Element && root.matches?.(MEDIA_SELECTORS.media)) {
      found.push(root);
    }
    const nested = root.querySelectorAll?.(MEDIA_SELECTORS.media);
    if (nested?.length) found.push(...nested);

    for (const el of found) {
      if (el.dataset?.[MARK] === '1') continue;
      this._io?.observe(el);
    }
  }

  // ─── Processing ──────────────────────────────────────────────────────────

  _processOne(el) {
    if (!(el instanceof Element)) return;

    if (el.matches(MEDIA_SELECTORS.video)) {
      if (el.dataset[MARK] === '1') return;
      el.dataset[MARK] = '1';
      this._autoplayVideo(el);
      this._processAggressiveVideo(el);
      return;
    }

    if (el.matches(MEDIA_SELECTORS.videoPlaceholder)) {
      const pin = el.closest(MEDIA_SELECTORS.pin);
      if (!pin || pin.dataset[HOVER_MARK] === '1') return;
      pin.dataset[HOVER_MARK] = '1';
      logDebug('_processOne — nudging pin to reveal video', pin);
      this._nudgePinToRevealVideo(pin);
      return;
    }
  }

  /**
   * Pinterest only creates the <video> on hover. We dispatch synthetic
   * pointer/mouse enter events into the center of the pin anchor, wait for the
   * <video> to appear and release the hover right away so the pin does not get
   * stuck in the hover state.
   */
  _nudgePinToRevealVideo(pin) {
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
      } catch { /* ignore */ }
    }
  }

  // ─── Video autoplay ──────────────────────────────────────────────────────

  _autoplayVideo(video) {
    if (video.dataset?.ptAutoplayed === '1') return;
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
  }

  _tryPlay(video) {
    try {
      const r = video.play();
      if (r && typeof r.catch === 'function') {
        r.catch(() => { logDebug('_tryPlay — play() rejected', video); });
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
      _originalPause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.pause = function () {
        const isForcePlayed = this.hasAttribute(FORCE_PLAY_ATTR);
        const tabVisible = !document.hidden;
        const inViewport = VideoAutoplayFeature._isElementInViewport(this);
        if (isForcePlayed && tabVisible && inViewport) {
          logDebug('[pause] BLOCKED — force-played & visible', this);
          return; // block Pinterest's pause() on force-played, visible videos
        }
        return _originalPause.call(this);
      };
      _pausePatched = true;
    }

    // Anti-React: keep muted / loop / playsinline pinned on force-played videos.
    this._attrObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        if (mut.type !== 'attributes') continue;
        const video = mut.target;
        if (!(video instanceof HTMLMediaElement)) continue;
        if (video.hasAttribute(FORCE_PLAY_ATTR)) {
          this._enforceAttributes(video);
        }
      }
    });

    // Visibility: force-play when ≥15% in viewport, release when it leaves.
    this._aggressiveIo = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const video = entry.target;
        if (!(video instanceof HTMLMediaElement)) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0.15) {
          video.setAttribute(FORCE_PLAY_ATTR, 'true');
          this._aggressiveVideos.add(video);
          this._enforceAttributes(video);
          if (video.paused && video.currentSrc) this._tryPlay(video);
        } else {
          video.removeAttribute(FORCE_PLAY_ATTR);
          this._aggressiveVideos.delete(video);
          if (_originalPause) _originalPause.call(video);
        }
      }
    }, { threshold: [0.15, 0.5, 0.8] });

    // Scan newly added DOM for videos.
    this._aggressiveMo = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          this._scanAggressive(node);
        }
      }
    });

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
      this._fallbackScan();
      this._scanVideoPins();
    }, 2000);

    logDebug('_installAggressiveAutoplay — done');
  }

  /** Tear down the aggressive bypass (called on disable / unload). */
  _teardownAggressiveAutoplay() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    if (this._fallbackScanInterval) {
      clearInterval(this._fallbackScanInterval);
      this._fallbackScanInterval = null;
    }
    this._attrObserver?.disconnect();
    this._aggressiveIo?.disconnect();
    this._aggressiveMo?.disconnect();
    document.removeEventListener('visibilitychange', this._onVisibilityChange);

    // Release every force-played video so Pinterest can pause it again.
    this._aggressiveVideos.forEach((video) => {
      video.removeAttribute(FORCE_PLAY_ATTR);
    });
    this._aggressiveVideos.clear();

    document.querySelectorAll(`video[${FORCE_PLAY_ATTR}]`).forEach((video) => {
      video.removeAttribute(FORCE_PLAY_ATTR);
    });

    // Restore original pause() prototype — prevents patch chains on re-enable.
    if (_pausePatched && _originalPause) {
      HTMLMediaElement.prototype.pause = _originalPause;
    }
    _pausePatched = false;
    _originalPause = null;
  }

  /** Recursively scan root for <video> elements and hook them. */
  _scanAggressive(root) {
    if (!root) return;
    if (root.tagName === 'VIDEO') {
      this._processAggressiveVideo(root);
    }
    if (root.querySelectorAll) {
      root.querySelectorAll('video').forEach((video) => this._processAggressiveVideo(video));
    }
  }

  /** Hook a single <video> into the aggressive bypass. */
  _processAggressiveVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.dataset[AGGRESSIVE_MARK] === 'true') return;

    // Never aggressively autoplay inside an open closeup (pin detail view).
    if (video.closest(CLOSEUP_SELECTORS)) return;

    video.dataset[AGGRESSIVE_MARK] = 'true';

    this._attrObserver?.observe(video, {
      attributes: true,
      attributeFilter: ['muted', 'loop', 'playsinline', 'src'],
    });

    video.addEventListener('canplay', this._onAggressiveCanPlay, true);
    this._aggressiveIo?.observe(video);
  }

  /** Instant start on canplay when the video is force-played. */
  _onAggressiveCanPlay(event) {
    const video = event.target;
    if (!(video instanceof HTMLMediaElement)) return;
    if (video.hasAttribute(FORCE_PLAY_ATTR) && video.paused) {
      this._tryPlay(video);
    }
  }

  /** Force muted / loop / playsinline attributes (anti-React). */
  _enforceAttributes(video) {
    if (!video.muted) video.muted = true;
    if (!video.playsInline) video.playsInline = true;
    if (!video.loop) video.loop = true;
    if (!video.hasAttribute('muted')) video.setAttribute('muted', '');
    if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', '');
    if (!video.hasAttribute('loop')) video.setAttribute('loop', '');
  }

  /** Heartbeat — keeps force-played, visible videos playing. */
  _startHeartbeat() {
    if (this._heartbeatInterval) return;
    this._heartbeatInterval = setInterval(() => {
      if (document.hidden) return;
      this._aggressiveVideos.forEach((video) => {
        if (video.paused && video.currentSrc) this._tryPlay(video);
      });
    }, 600); // 2 checks per second
  }

  /** Fallback scan — walks all <video> in DOM and hooks any missed by observers. */
  _fallbackScan() {
    try {
      document.querySelectorAll('video').forEach((video) => {
        if (video.dataset[AGGRESSIVE_MARK] === 'true') return;
        if (video.closest(CLOSEUP_SELECTORS)) return;
        this._processAggressiveVideo(video);
      });
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
      let nudgedCount = 0;

      for (const pin of pins) {
        // Уже нудили (через IO или через этот таймер) — пропускаем.
        const nudgeState = pin.dataset[HOVER_MARK];
        if (nudgeState === '1') continue;                    // ещё в процессе — не трогаем
        if (nudgeState === '2') {
          const lastAt = Number(pin.dataset.ptNudgeAt || 0);
          if (Date.now() - lastAt < 10_000) continue;        // 10 сек кулдаун
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
        pin.dataset.ptNudgeAt = String(Date.now());
        this._nudgePinToRevealVideo(pin);
        nudgedCount++;
      }

      if (nudgedCount > 0) logDebug('_scanVideoPins — nudged:', nudgedCount);
    } catch (err) {
      logDebug('_scanVideoPins — error:', err);
    }
  }

  /** visibilitychange handler — pause when tab hides, resume when it shows. */
  _onVisibilityChange() {
    if (document.hidden) {
      this._aggressiveVideos.forEach((video) => {
        if (_originalPause) _originalPause.call(video);
      });
    } else {
      this._aggressiveVideos.forEach((video) => {
        if (video.paused && video.currentSrc) this._tryPlay(video);
      });
    }
  }

  /** Viewport check (≥15% from top/bottom edges). */
  static _isElementInViewport(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    return (
      rect.top < window.innerHeight * 0.85 &&
      rect.bottom > window.innerHeight * 0.15 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );
  }

  // ─── Revert ──────────────────────────────────────────────────────────────

  _revert() {
    document.querySelectorAll('video[data-pt-autoplayed="1"]').forEach((video) => {
      delete video.dataset.ptAutoplayed;
      video.removeAttribute('autoplay');
      try { video.pause?.(); } catch { /* noop */ }
    });

    document.querySelectorAll('video[data-pt-aggressive-hooked="true"]').forEach((video) => {
      delete video.dataset.ptAggressiveHooked;
      video.removeAttribute(FORCE_PLAY_ATTR);
    });

    document.querySelectorAll('[data-pt-hover-nudged]').forEach((el) => {
      delete el.dataset.ptHoverNudged;
      delete el.dataset.ptNudgeAt;
    });
    document.querySelectorAll('[data-pt-media-done="1"]').forEach((el) => {
      delete el.dataset.ptMediaDone;
    });
  }
}

// ============================================================================
// Carousel Autoplay
// ============================================================================

/** Interval between automatic swipes, seconds — number input in the popup. */
const INTERVAL_SETTING = {
  id: 'interval',
  label: 'Interval',
  type: 'number',
  defaultValue: 3,
  min: 0.1,
  max: 1000,
  step: 0.1,
  unit: 's',
};

export const carouselAutoplay = {
  id: 'carouselAutoplay',
  title: 'Carousel autoplay',
  type: 'js',
  htmlClass: 'pt-autoplay-carousel',
  defaultValue: false,
  description: 'Automatically advances carousel pins in the feed',
  settings: [INTERVAL_SETTING],
};

export const CAROUSEL_SELECTORS = {
  pin: '[data-test-id="pin"]',
  swiper: '[data-test-id^="carousel-swiper-"]',
};

/** Slides are 100% of the row wide; Pinterest shifts all of them via transform. */
const SLIDE_STEP_PCT = 100;

/**
 * Advance a pin's carousel one slide forward (wraps last → first).
 *
 * Pinterest renders slides as `[data-test-id^="carousel-swiper-"]` (min-width
 * 100%) in a flex row and positions them with `transform: translate(-N00%, 0%)`
 * on EVERY slide simultaneously. "Next slide" = +100%; at 0% wrap to
 * -(total-1)*100%. There are no public next/prev buttons in the DOM
 * (pointer-events: none on the slider rail), hence the direct style edit.
 *
 * @param {Element} pin root `[data-test-id="pin"]`
 * @returns {boolean} true if the slide actually moved
 */
export function autoSwipe(pin) {
  if (!(pin instanceof Element)) return false;
  const swipers = pin.querySelectorAll(CAROUSEL_SELECTORS.swiper);
  if (swipers.length < 2) return false; // not a carousel

  // All slides share one transform — read the position from the first.
  const m = (swipers[0].style.transform || '').match(/translate\(\s*(-?\d+(?:\.\d+)?)%/);
  if (!m) return false;

  let nextPct = parseFloat(m[1]) + SLIDE_STEP_PCT;
  const wrap = nextPct > 0;
  if (wrap) nextPct = -(swipers.length - 1) * SLIDE_STEP_PCT;
  const transform = `translate(${nextPct}%, 0%)`;

  for (const s of swipers) {
    if (!wrap) {
      s.style.transform = transform;
      continue;
    }
    // 0% → -(n-1)*100% must NOT animate (it would sweep through every slide).
    const prev = s.style.transition;
    s.style.transition = 'none';
    s.style.transform = transform;
    void s.offsetWidth; // force reflow so 'none' applies to this frame
    s.style.transition = prev; // '' restores the stylesheet transition
  }
  return true;
}

export class CarouselAutoplayFeature extends BaseFeature {
  constructor(config = carouselAutoplay) {
    super(config);
    /** @type {number|null} */
    this._timer = null;
    this._tick = this._tick.bind(this);
  }

  onEnable() {
    this._tick(); // first pass right away
    this._timer = setInterval(this._tick, this._intervalMs());
  }

  onDisable() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /** Persisted swipe interval, seconds → ms (clamped to the 0.1–1000 range). */
  _intervalMs() {
    const n = Number(this.settingValues.interval);
    const sec = Number.isFinite(n) ? n : INTERVAL_SETTING.defaultValue;
    return Math.min(Math.max(sec, INTERVAL_SETTING.min), INTERVAL_SETTING.max) * 1000;
  }

  /** Popup changed the interval — restart the running timer with it. */
  onSettings() {
    if (this._timer == null) return;
    clearInterval(this._timer);
    this._timer = setInterval(this._tick, this._intervalMs());
  }

  /** One timer for all pins; hover pauses, offscreen pins are skipped. */
  _tick() {
    if (document.hidden) return;
    for (const pin of document.querySelectorAll(CAROUSEL_SELECTORS.pin)) {
      if (pin.matches(':hover')) continue;
      const r = pin.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
      autoSwipe(pin); // false for non-carousels — that IS the filter
    }
  }
}