// ==UserScript==
// @name         Niconico Enhance and Fix
// @namespace    https://www.nicovideo.jp/
// @version      0.5.0
// @description  Skip or accelerate Niconico watch-page video ads and click skip UI in ad iframes.
// @author       Codex, Grok, SoizoKtantas
// @match        https://www.nicovideo.jp/watch/*
// @match        https://nicovideo.jp/watch/*
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
  const AD_PLAYBACK_RATE = 2048;
  const OVERLAY_ALPHA = 0.45;
  const OVERLAY_CLASS = 'ad-dim-overlay-canvas';
  const SKIP_SELECTORS = [
    '#request_skip',
    '.videoAdUiSkipButton',
    '.videoAdUiSkipContainer button',
    'button[aria-label*="Skip" i]',
    'button[id*="skip" i]',
    '[role="button"][aria-label*="Skip" i]',
  ];

  if (AD_HOST_RE.test(location.hostname) && AD_PATH_RE.test(location.pathname)) {
    runAdFrameSkipper();
  } else {
    runWatchSkipper();
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
