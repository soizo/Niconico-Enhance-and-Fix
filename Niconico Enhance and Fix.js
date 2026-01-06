// ==UserScript==
// @name         Niconico Enhance and Fix
// @namespace    https://www.nicovideo.jp/
// @version      0.5.7
// @description  Skip or accelerate Niconico watch-page video ads and click skip UI in ad iframes.
// @author       Codex, Grok, SoizoKtantas
// @match        https://www.nicovideo.jp/watch/*
// @match        https://nicovideo.jp/watch/*
// @match        https://embed.nicovideo.jp/watch/*
// @match        https://ads.nicovideo.jp/vast/script/simid/video/*
// @match        https://*.ads.nicovideo.jp/vast/script/simid/video/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const AD_HOST_RE = /(^|\.)ads\.nicovideo\.jp$/i;
  const AD_PATH_RE = /\/vast\/script\/simid\/video\//i;
  const AD_CONTAINER_SELECTOR = '#nv_watch_VideoAdContainer';
  const AD_SRC_RE = /(^https?:)?\/\/[^/]*ads\.nicovideo\.jp\/|\/vast\//i;
  const EMBED_HOST = 'embed.nicovideo.jp';
  const COMMENT_IFRAME_CLASS = 'nico-comment-embed-iframe';
  const COMMENT_OVERLAY_CLASS = 'nico-comment-embed-overlay';
  const COMMENT_QUERY =
    'persistence=1&oldScript=1&referer=&from=0&allowProgrammaticFullScreen=1';
  const EMBED_ORIGIN = `https://${EMBED_HOST}`;
  const COMMENT_SYNC_TYPE = 'nico-comment-sync';
  const COMMENT_SYNC_INTERVAL = 1024;
  const COMMENT_SYNC_DRIFT = 0.4;
  const COMMENT_SEEK_BACK_THRESHOLD = 0.1;
  const COMMENT_SEEK_FORWARD_THRESHOLD = 0.8;
  const COMMENT_FORCE_SEEK_WINDOW = 1600;
  const PLAYER_CONTROL_SELECTOR = '.f187xx8z';
  const PLAYER_CONTROL_ACTIVE_CLASS = 'controlling';
  const PLAYER_SWAP_INTERVAL = 1200;
  const EMBED_PARENT_ORIGINS = ['https://www.nicovideo.jp', 'https://nicovideo.jp'];
  const EMBED_PLAY_TITLE_JP = '\u518d\u751f';
  const EMBED_PLAY_TITLE_JP_ALT = '\u958b\u59cb';
  const EMBED_PLAY_TITLE_EN = 'play';
  const AD_PLAYBACK_RATE = 2048;
  const OVERLAY_ALPHA = 0.45;
  const OVERLAY_CLASS = 'ad-dim-overlay-canvas';
  const DEBUG_LOGS = true;
  const SKIP_SELECTORS = [
    '#request_skip',
    '.videoAdUiSkipButton',
    '.videoAdUiSkipContainer button',
    'button[aria-label*="Skip" i]',
    'button[id*="skip" i]',
    '[role="button"][aria-label*="Skip" i]',
  ];

  if (location.hostname === EMBED_HOST) {
    runEmbedCommentFrame();
  } else if (AD_HOST_RE.test(location.hostname) && AD_PATH_RE.test(location.pathname)) {
    runAdFrameSkipper();
  } else {
    runWatchSkipper();
    runCommentOverlay();
    runPlayerChromeLock();
    runPlayerSwap();
  }

  // Ad UI lives in a cross-origin iframe; handle skip inside the ad frame itself.
  function runAdFrameSkipper() {
    const overlayState = new WeakMap();

    const trySkip = () => {
      clickSkipButtons(document);
      const videos = Array.from(document.querySelectorAll('video'));
      for (const video of videos) {
        ensureAdOverlay(video, true, overlayState);
      }
    };

    const observer = observeDom(trySkip, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'aria-hidden'],
    });
    const intervalId = window.setInterval(trySkip, 500);

    window.addEventListener(
      'pagehide',
      () => {
        if (observer) observer.disconnect();
        clearInterval(intervalId);
      },
      { once: true }
    );

    whenReady(trySkip);
  }

  function runWatchSkipper() {
    const state = new WeakMap();
    const overlayState = new WeakMap();

    const scan = () => {
      const videos = Array.from(document.querySelectorAll('video'));
      for (const video of videos) {
        const isAd = isAdVideo(video);
        ensureAdState(video, isAd, state);
        ensureAdOverlay(video, isAd, overlayState);
      }

      if (document.querySelector(AD_CONTAINER_SELECTOR)) {
        clickSkipButtons(document);
      }
    };

    const observer = observeDom(scan, { childList: true, subtree: true });
    const intervalId = window.setInterval(scan, 800);

    window.addEventListener(
      'pagehide',
      () => {
        if (observer) observer.disconnect();
        clearInterval(intervalId);
      },
      { once: true }
    );

    whenReady(scan);
  }

  function runCommentOverlay() {
    const state = {
      overlay: null,
      iframe: null,
      container: null,
      video: null,
      src: '',
      lastTime: null,
      forceSeekUntil: 0,
      forceSeekDirection: null,
    };

    const sendSync = () => {
      const iframe = state.iframe;
      if (!iframe || !iframe.contentWindow) return;

      const video = findMainVideo();
      if (!video) return;

      const now = Date.now();
      const active = isContentReady(video);
      const time = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const rate = Number.isFinite(video.playbackRate) ? video.playbackRate : 1;
      const seeking = Boolean(video.seeking);
      const paused = !active || video.paused || video.ended || seeking;
      let seekBack = false;
      let seekForward = false;
      if (Number.isFinite(time) && Number.isFinite(state.lastTime)) {
        const delta = time - state.lastTime;
        seekBack = delta < -COMMENT_SEEK_BACK_THRESHOLD;
        const expected = rate * (COMMENT_SYNC_INTERVAL / 1000);
        seekForward = delta > expected + COMMENT_SEEK_FORWARD_THRESHOLD;
      }
      if (seeking && (seekBack || seekForward)) {
        state.forceSeekDirection = seekBack ? 'back' : 'forward';
        state.forceSeekUntil = now + COMMENT_FORCE_SEEK_WINDOW;
      }
      const forceBack = state.forceSeekDirection === 'back' && now < state.forceSeekUntil;
      const forceForward = state.forceSeekDirection === 'forward' && now < state.forceSeekUntil;
      if (!forceBack && !forceForward && state.forceSeekDirection) {
        state.forceSeekDirection = null;
      }
      seekBack = seekBack || forceBack;
      seekForward = seekForward || forceForward;
      if (Number.isFinite(time)) {
        state.lastTime = time;
      } else {
        state.lastTime = null;
      }

      iframe.contentWindow.postMessage(
        {
          type: COMMENT_SYNC_TYPE,
          time,
          rate,
          paused,
          active,
          seeking,
          seekBack,
          seekForward,
        },
        EMBED_ORIGIN
      );
    };

    const ensureOverlay = () => {
      const video = findMainVideo();
      if (!video) return;

      const container = video.parentElement;
      if (!container) return;

      const watchId = getWatchId();
      if (!watchId) return;

      const src = `https://${EMBED_HOST}/watch/${watchId}?${COMMENT_QUERY}`;
      if (state.container !== container || state.video !== video) {
        removeCommentOverlay(state);
      }

      if (!state.overlay) {
        if (container.style.position === '' || container.style.position === 'static') {
          container.style.position = 'relative';
        }

        const overlay = document.createElement('div');
        overlay.className = COMMENT_OVERLAY_CLASS;
        overlay.style.position = 'absolute';
        overlay.style.inset = '0';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '10';
        overlay.style.overflow = 'hidden';

        const iframe = document.createElement('iframe');
        iframe.className = COMMENT_IFRAME_CLASS;
        iframe.src = src;
        iframe.title = 'Niconico Comment Overlay';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = '0';
        iframe.style.display = 'block';
        iframe.style.background = 'transparent';
        iframe.setAttribute('allow', 'autoplay; fullscreen');

        overlay.appendChild(iframe);
        container.appendChild(overlay);

        state.overlay = overlay;
        state.iframe = iframe;
        state.container = container;
        state.video = video;
        state.src = src;
      } else if (state.iframe && state.src !== src) {
        state.iframe.src = src;
        state.src = src;
      }

      sendSync();
    };

    const observer = observeDom(ensureOverlay, { childList: true, subtree: true });
    const intervalId = window.setInterval(ensureOverlay, 1000);
    const syncIntervalId = window.setInterval(sendSync, COMMENT_SYNC_INTERVAL);

    window.addEventListener(
      'pagehide',
      () => {
        if (observer) observer.disconnect();
        clearInterval(intervalId);
        clearInterval(syncIntervalId);
      },
      { once: true }
    );

    whenReady(() => {
      ensureOverlay();
      sendSync();
    });
  }

  function logDebug(message, data) {
    if (!DEBUG_LOGS) return;
    if (data !== undefined) {
      console.log(`[NEF] ${message}`, data);
    } else {
      console.log(`[NEF] ${message}`);
    }
  }

  function runPlayerChromeLock() {
    const styleId = 'nef-player-chrome-lock';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        ${PLAYER_CONTROL_SELECTOR}.${PLAYER_CONTROL_ACTIVE_CLASS} {
          opacity: 0 !important;
          pointer-events: none !important;
        }
      `;
      document.documentElement.appendChild(style);
    }

    const scrub = () => {
      let removed = 0;
      const controls = Array.from(document.querySelectorAll(PLAYER_CONTROL_SELECTOR));
      for (const control of controls) {
        if (control.classList.contains(PLAYER_CONTROL_ACTIVE_CLASS)) {
          control.classList.remove(PLAYER_CONTROL_ACTIVE_CLASS);
          removed += 1;
        }
      }
      if (controls.length > 0 || removed > 0) {
        logDebug('chrome-lock scrub', { controls: controls.length, removed });
      }
    };

    const observer = observeDom(scrub, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    const intervalId = window.setInterval(scrub, 500);

    window.addEventListener(
      'pagehide',
      () => {
        if (observer) observer.disconnect();
        clearInterval(intervalId);
      },
      { once: true }
    );

    whenReady(scrub);
  }

  function runPlayerSwap() {
    const swap = () => {
      logDebug('swap tick');
      const videos = Array.from(document.querySelectorAll('video')).filter((video) => !isAdVideo(video));
      if (videos.length < 2) {
        logDebug('swap skip: not enough videos', { count: videos.length });
        return;
      }

      const mainVideo = findMainVideo();
      if (!mainVideo) {
        logDebug('swap skip: no main video');
        return;
      }

      const mainContainer = mainVideo.parentElement;
      if (!mainContainer) {
        logDebug('swap skip: no main container');
        return;
      }

      let targetContainer = null;
      for (const video of videos) {
        if (video === mainVideo) continue;
        const container = video.parentElement;
        if (!container) continue;
        if (!targetContainer) targetContainer = container;
        if (container.querySelector('button')) {
          targetContainer = container;
          break;
        }
      }

      if (!targetContainer) {
        logDebug('swap skip: no target container');
        return;
      }
      if (targetContainer === mainContainer) {
        logDebug('swap skip: already in target');
        return;
      }

      logDebug('swap target picked', {
        mainVideo: mainVideo.currentSrc || mainVideo.src || '',
        targetButtons: targetContainer.querySelectorAll('button').length,
      });

      let removed = 0;
      const targetVideo = targetContainer.querySelector('video');
      if (targetVideo && targetVideo !== mainVideo && targetVideo.parentNode) {
        targetVideo.parentNode.removeChild(targetVideo);
        removed += 1;
      }

      for (const video of videos) {
        if (video === mainVideo || video === targetVideo) continue;
        if (video.parentNode) {
          video.parentNode.removeChild(video);
          removed += 1;
        }
      }

      if (!targetContainer.contains(mainContainer)) {
        targetContainer.insertBefore(mainContainer, targetContainer.firstChild);
        logDebug('swap moved main container', { removed });
      }
    };

    const observer = observeDom(swap, { childList: true, subtree: true });
    const intervalId = window.setInterval(swap, PLAYER_SWAP_INTERVAL);

    window.addEventListener(
      'pagehide',
      () => {
        if (observer) observer.disconnect();
        clearInterval(intervalId);
      },
      { once: true }
    );

    whenReady(swap);
  }

  function ensureAdState(video, isAd, stateMap) {
    let state = stateMap.get(video);
    if (!state) {
      state = { isAd: false, playbackRate: 1, muted: false };
      stateMap.set(video, state);
    }

    if (isAd) {
      if (!state.isAd) {
        state.isAd = true;
        state.playbackRate = Number.isFinite(video.playbackRate) ? video.playbackRate : 1;
        state.muted = video.muted;
      }
      skipAdVideo(video);
    } else if (state.isAd) {
      video.playbackRate = Number.isFinite(state.playbackRate) ? state.playbackRate : 1;
      video.muted = state.muted;
      state.isAd = false;
    }
  }

  function isAdVideo(video) {
    if (!video) return false;
    if (video.closest(AD_CONTAINER_SELECTOR)) return true;
    const title = (video.getAttribute('title') || '').toLowerCase();
    if (title === 'advertisement') return true;
    const src = video.currentSrc || video.src || '';
    return AD_SRC_RE.test(src);
  }

  function isContentReady(video) {
    if (!video) return false;
    if (isAdVideo(video)) return false;
    return video.readyState >= 2;
  }

  function findMainVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    let best = null;
    let bestArea = 0;
    for (const video of videos) {
      if (isAdVideo(video)) continue;
      const area = (video.clientWidth || 0) * (video.clientHeight || 0);
      if (area > bestArea) {
        bestArea = area;
        best = video;
      }
    }
    return best;
  }

  function getWatchId() {
    const match = location.pathname.match(/\/watch\/([a-z0-9]+)/i);
    return match ? match[1] : '';
  }

  function removeCommentOverlay(state) {
    if (state.overlay && state.overlay.parentNode) {
      state.overlay.parentNode.removeChild(state.overlay);
    }
    state.overlay = null;
    state.iframe = null;
    state.container = null;
    state.video = null;
    state.src = '';
    state.lastTime = null;
  }

  function skipAdVideo(video) {
    if (!video) return;
    try {
      video.muted = true;
      video.playbackRate = AD_PLAYBACK_RATE;

      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        const target = Math.max(duration - 0.1, 0);
        if (video.currentTime < target) {
          video.currentTime = target;
        }
      } else if (video.seekable && video.seekable.length) {
        const end = video.seekable.end(video.seekable.length - 1);
        if (Number.isFinite(end) && video.currentTime < end) {
          video.currentTime = end;
        }
      }

      if (video.paused) {
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
      }
    } catch (err) {
      // Ignore failures caused by timing or media state.
    }
  }

  function clickSkipButtons(root) {
    if (!root) return false;
    let clicked = false;
    for (const selector of SKIP_SELECTORS) {
      const nodes = root.querySelectorAll(selector);
      for (const node of nodes) {
        if (node.id === 'request_skip') {
          node.style.visibility = 'visible';
          node.style.display = 'flex';
          node.style.pointerEvents = 'auto';
        }
        if (!isClickable(node)) continue;
        clickNode(node);
        clicked = true;
      }
    }
    return clicked;
  }

  function isClickable(node) {
    if (!node) return false;
    const style = window.getComputedStyle(node);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.pointerEvents === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function clickNode(node) {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (typeof node.click === 'function') {
      node.click();
    }
  }

  function ensureAdOverlay(video, isAd, overlayMap) {
    if (!video) return;
    let canvas = overlayMap.get(video);
    const container = video.closest(AD_CONTAINER_SELECTOR) || video.parentElement;

    if (!isAd || !container) {
      if (canvas && canvas.parentNode) {
        canvas.parentNode.removeChild(canvas);
      }
      overlayMap.delete(video);
      return;
    }

    if (!canvas || canvas.parentNode !== container) {
      if (canvas && canvas.parentNode) {
        canvas.parentNode.removeChild(canvas);
      }
      canvas = document.createElement('canvas');
      canvas.className = OVERLAY_CLASS;
      canvas.style.position = 'absolute';
      canvas.style.top = '0';
      canvas.style.left = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = 'none';
      canvas.style.zIndex = '9999';
      if (container.style.position === '' || container.style.position === 'static') {
        container.style.position = 'relative';
      }
      container.appendChild(canvas);
      overlayMap.set(video, canvas);
    }

    updateOverlayCanvas(canvas, container, video);
  }

  function runEmbedCommentFrame() {
    const style = document.createElement('style');
    style.textContent = `
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: transparent !important;
        overflow: hidden;
      }
      body, body * {
        background-color: transparent !important;
        background-image: none !important;
      }
      #rootElementId, #rootElementId > div {
        width: 100%;
        height: 100%;
        background: transparent !important;
      }
      video, #video, #video video {
        opacity: 0 !important;
        pointer-events: none !important;
      }
      #comment {
        position: absolute !important;
        inset: 0 !important;
        width: 100% !important;
        height: 100% !important;
        background: transparent !important;
        pointer-events: none !important;
        z-index: 2 !important;
      }
      #comment canvas {
        width: 100% !important;
        height: 100% !important;
        pointer-events: none !important;
      }
      #comment ~ * {
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    document.documentElement.appendChild(style);

    setupEmbedChromeStripper();
    setupEmbedSync();
  }

  function setupEmbedChromeStripper() {
    const apply = () => {
      const comment = document.getElementById('comment');
      if (!comment) return;

      const parent = comment.parentElement;
      if (parent && (parent.style.position === '' || parent.style.position === 'static')) {
        parent.style.position = 'relative';
      }

      let node = comment;
      while (node && node.parentElement && node !== document.body) {
        const container = node.parentElement;
        const siblings = Array.from(container.children);
        for (const child of siblings) {
          if (child === node) continue;
          child.style.opacity = '0';
          child.style.pointerEvents = 'none';
          child.style.background = 'transparent';
        }
        node = container;
      }
    };

    const observer = observeDom(apply, { childList: true, subtree: true });
    const intervalId = window.setInterval(apply, 1000);

    window.addEventListener(
      'pagehide',
      () => {
        if (observer) observer.disconnect();
        clearInterval(intervalId);
      },
      { once: true }
    );

    apply();
  }

  function setupEmbedSync() {
    const state = { pending: null };

    const applyPending = () => {
      if (!state.pending) return;
      if (applyEmbedSync(state.pending)) {
        state.pending = null;
      }
    };

    const onMessage = (event) => {
      if (!isAllowedEmbedParent(event.origin)) return;
      const data = event.data;
      if (!data || data.type !== COMMENT_SYNC_TYPE) return;
      state.pending = data;
      applyPending();
    };

    window.addEventListener('message', onMessage);

    const observer = observeDom(applyPending, { childList: true, subtree: true });
    const intervalId = window.setInterval(applyPending, 500);

    window.addEventListener(
      'pagehide',
      () => {
        window.removeEventListener('message', onMessage);
        if (observer) observer.disconnect();
        clearInterval(intervalId);
      },
      { once: true }
    );
  }

  function isAllowedEmbedParent(origin) {
    return EMBED_PARENT_ORIGINS.includes(origin);
  }

  function applyEmbedSync(data) {
    const video = findEmbedVideo();
    if (!video) return false;
    let needsRetry = false;

    if (video.muted !== true) {
      video.muted = true;
    }
    if (video.volume !== 0) {
      video.volume = 0;
    }

    if (Number.isFinite(data.rate) && video.playbackRate !== data.rate) {
      video.playbackRate = data.rate;
    }

    const targetTime = Number.isFinite(data.time) ? data.time : null;
    const forceSeekBack = data.seekBack === true;
    const forceSeekForward = data.seekForward === true;
    if (targetTime !== null) {
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const delta = Math.abs(currentTime - targetTime);
      const shouldSeek = delta > COMMENT_SYNC_DRIFT || forceSeekBack || forceSeekForward;
      if (shouldSeek) {
        try {
          if (forceSeekBack && !video.paused) {
            video.pause();
          }
          if (typeof video.fastSeek === 'function') {
            video.fastSeek(Math.max(targetTime, 0));
          } else {
            video.currentTime = Math.max(targetTime, 0);
          }
          try {
            video.dispatchEvent(new Event('timeupdate'));
            video.dispatchEvent(new Event('seeked'));
          } catch (err) {
            // Ignore synthetic event failures.
          }
          const updatedTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
          if (Math.abs(updatedTime - targetTime) > COMMENT_SYNC_DRIFT) {
            needsRetry = true;
          }
        } catch (err) {
          // Ignore seek errors while buffering.
          needsRetry = true;
        }
      }
    }

    if (!data.active || data.paused) {
      if (!video.paused) {
        video.pause();
      }
      return !needsRetry;
    }

    ensureEmbedPlay(video);
    return !needsRetry;
  }

  function findEmbedVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length <= 1) return videos[0] || null;
    let best = null;
    let bestArea = 0;
    for (const video of videos) {
      const area = (video.clientWidth || 0) * (video.clientHeight || 0);
      if (area > bestArea) {
        bestArea = area;
        best = video;
      }
    }
    return best;
  }

  function ensureEmbedPlay(video) {
    if (!video || !video.paused) return;
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {});
    }
    window.setTimeout(() => {
      if (!video.paused || video.ended) return;
      if (clickEmbedPlayButton()) {
        const retry = video.play();
        if (retry && typeof retry.catch === 'function') {
          retry.catch(() => {});
        }
      }
    }, 300);
  }

  function clickEmbedPlayButton() {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const button of buttons) {
      const title = (button.getAttribute('data-title') || button.getAttribute('aria-label') || '').trim();
      if (title) {
        const lower = title.toLowerCase();
        if (
          title === EMBED_PLAY_TITLE_JP ||
          title === EMBED_PLAY_TITLE_JP_ALT ||
          lower === EMBED_PLAY_TITLE_EN
        ) {
          clickNode(button);
          return true;
        }
      }

      if (button.closest('.unplayed')) {
        const svg = button.querySelector('svg');
        const viewBox = svg ? svg.getAttribute('viewBox') : '';
        if (viewBox === '0 0 100 100') {
          clickNode(button);
          return true;
        }
      }
    }
    return false;
  }

  function updateOverlayCanvas(canvas, container, video) {
    if (!canvas || !container) return;
    const width = Math.max(container.clientWidth || 0, video ? video.clientWidth || 0 : 0);
    const height = Math.max(container.clientHeight || 0, video ? video.clientHeight || 0 : 0);
    if (width === 0 || height === 0) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = `rgba(0, 0, 0, ${OVERLAY_ALPHA})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function observeDom(callback, options) {
    const root = document.documentElement || document.body;
    if (!root) {
      window.setTimeout(() => observeDom(callback, options), 50);
      return null;
    }
    const observer = new MutationObserver(callback);
    observer.observe(root, options);
    return observer;
  }
})();
