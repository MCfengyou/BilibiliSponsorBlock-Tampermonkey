// ==UserScript==
// @license MIT
// @name         BilibiliSponsorBlock-Tampermonkey
// @namespace    https://github.com/MCfengyou/BilibiliSponsorBlock-Tampermonkey
// @version      1.2
// @description  使用 bsbsb.top API 跳过标注片段，并以绿色在进度条上标注广告时段
// @author       NeoGe_and_GPT-5
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/medialist/play/*
// @grant        none
// @run-at       document-idle
// @downloadURL https://update.greasyfork.org/scripts/553623/BilibiliSponsorBlock-Tampermonkey.user.js
// @updateURL https://update.greasyfork.org/scripts/553623/BilibiliSponsorBlock-Tampermonkey.meta.js
// ==/UserScript==

(function() {
  'use strict';
  const LOG = (...a)=>console.log('[BSB+ FIX6R7]',...a);
  const API = 'https://bsbsb.top/api/skipSegments?videoID=';

  // state
  let currentBV = null;
  let segmentRequestId = 0;
  let segments = [];
  let videoEl = null;
  let progressEl = null;
  let markerLayer = null;
  let observer = null;
  let pendingPrompt = null; // { seg, rule, key, action, fromTime, video, deadline }
  let promptTimer = null;

  // control flags
  let manualInSegment = false;
  let userSeeking = false;
  let suppressedSegmentKey = null;
  let lastTime = 0;

  // throttle
  let renderScheduled = false;
  let lastProgressCheck = 0;

  const CATEGORY_RULES = {
    intro:       { label: '过场/开场动画', color: 'rgb(0,255,255)', mode: 'manual' },
    selfpromo:   { label: '无偿/自我推广', color: 'rgb(255,255,0)', mode: 'manual' },
    sponsor:     { label: '赞助/恰饭', color: 'rgb(0,212,0)', mode: 'auto' },
    interaction: { label: '三连/互动提醒', color: 'rgb(204,0,255)', mode: 'manual' },
    preview:     { label: '回顾/概要', color: 'rgb(0,143,214)', mode: 'marker' },
    outro:       { label: '鸣谢/结束画面', color: 'rgb(2,2,237)', mode: 'manual' }
  };

  // ---------- helpers ----------
  function getBV(){ const m = location.href.match(/BV[0-9A-Za-z]+/); return m ? m[0] : null; }

  async function fetchSegments(bv) {
    if (!bv) return [];
    try {
      const res = await fetch(API + bv);
      if (!res.ok) { LOG('segment API status', res.status); return []; }
      const json = await res.json();
      if (!Array.isArray(json)) return [];
      return json.map(item => ({
        start: Number(item.segment?.[0] ?? item.start ?? 0),
        end: Number(item.segment?.[1] ?? item.end ?? 0),
        category: item.category ?? 'sponsor'
      })).filter(s => CATEGORY_RULES[s.category] && isFinite(s.start) && isFinite(s.end) && s.end > s.start);
    } catch (e) {
      LOG('fetchSegments error', e);
      return [];
    }
  }

  function findVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    for (const v of vids) if (v.offsetParent !== null || v.getClientRects().length) return v;
    return vids[0] || null;
  }

  function findProgress() {
    const candidates = [
      '.bpx-player-progress-wrap',
      '.bpx-player-progress',
      '.bilibili-player-video-progress',
      '.bilibili-player-progress',
      '.bui-progress'
    ];
    for (const s of candidates) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    const ctrl = document.querySelector('.bilibili-player-video-control-bottom') || document.querySelector('.bpx-player-container');
    if (ctrl) {
      const el = ctrl.querySelector('.bpx-player-progress-wrap, .bpx-player-progress, .bilibili-player-video-progress');
      if (el) return el;
    }
    return null;
  }

  function ensureMarkerLayerAttached() {
    const p = findProgress();
    if (!p) return null;
    progressEl = p;
    if (markerLayer && markerLayer.parentElement && markerLayer.parentElement !== progressEl) {
      markerLayer.remove();
      markerLayer = null;
    }
    if (!markerLayer) {
      markerLayer = document.createElement('div');
      markerLayer.className = 'bsb-marker-layer';
      Object.assign(markerLayer.style, {
        position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 9
      });
    }
    const cs = getComputedStyle(progressEl);
    if (cs.position === 'static') progressEl.style.position = 'relative';
    if (!progressEl.contains(markerLayer)) progressEl.appendChild(markerLayer);
    return markerLayer;
  }

  function renderMarkers() {
    if (!videoEl) return;
    const p = findProgress();
    if (!p) return;
    ensureMarkerLayerAttached();
    const dur = videoEl.duration || 0;
    if (!dur || !isFinite(dur) || dur <= 0) return;
    const html = segments.map(seg => {
      const rule = CATEGORY_RULES[seg.category];
      if (!rule) return '';
      const left = (seg.start / dur) * 100;
      const width = ((seg.end - seg.start) / dur) * 100;
      return `<div style="position:absolute;left:${left}%;width:${width}%;height:100%;background:${rule.color};opacity:.45;border-radius:2px;"></div>`;
    }).join('');
    markerLayer.innerHTML = html;
    LOG('Markers rendered (count=' + segments.length + ')');
  }

  function scheduleRenderThrottled() {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => { try { renderMarkers(); } catch (e) { LOG('renderMarkers e', e); } renderScheduled = false; }, 500);
  }

  function delayedMarkerAttempts(times = 3, interval = 800) {
    for (let i = 1; i <= times; i++) {
      setTimeout(() => scheduleRenderThrottled(), i * interval);
    }
  }

  // ---------- prompt and skip / undo management ----------
  function segKeyFor(seg){ return `${seg.start}-${seg.end}`; }

  const UNDO_SECONDS = 5;
  const RESKIP_SECONDS = 3;
  let ownSeekTime = null;

  const uiRoot = () => document.fullscreenElement || document.webkitFullscreenElement || document.body;
  function movePrompt() {
    const prompt = document.getElementById('bsb-prompt');
    if (prompt && !uiRoot().contains(prompt)) uiRoot().appendChild(prompt);
  }
  document.addEventListener('fullscreenchange', movePrompt);
  document.addEventListener('webkitfullscreenchange', movePrompt);

  function performSkip(seg, rule) {
    if (!videoEl) return false;
    const fromTime = videoEl.currentTime;
    if (fromTime < seg.start - 0.15 || fromTime >= seg.end) return false;
    const target = Math.min(seg.end + 0.05, videoEl.duration || seg.end + 0.05);
    ownSeekTime = target;
    videoEl.currentTime = target;
    showPrompt(seg, rule, 'undo', UNDO_SECONDS, fromTime);
    return true;
  }

  function runPromptAction() {
    const prompt = pendingPrompt;
    if (!prompt || Date.now() >= prompt.deadline || prompt.video !== videoEl || getBV() !== currentBV) {
      removePrompt(false);
      return false;
    }
    if (prompt.action === 'undo') {
      const { seg, rule, fromTime } = prompt;
      removePrompt(false);
      suppressedSegmentKey = segKeyFor(seg);
      manualInSegment = true;
      const gap = Math.min(0.05, (seg.end - seg.start) / 4);
      const returnTime = Math.max(seg.start + gap, Math.min(fromTime, seg.end - gap));
      lastTime = returnTime;
      ownSeekTime = returnTime;
      videoEl.currentTime = returnTime;
      showPrompt(seg, rule, 'skip', RESKIP_SECONDS);
      return true;
    }
    const { seg, rule } = prompt;
    removePrompt(true);
    return performSkip(seg, rule);
  }

  function removePrompt(suppressForCurrentSegment = true) {
    try {
      const el = document.getElementById('bsb-prompt');
      if (el) {
        el.style.transition = 'opacity .18s ease';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 200);
      }
      if (promptTimer) { clearInterval(promptTimer); promptTimer = null; }
      if (pendingPrompt && suppressForCurrentSegment && pendingPrompt.action === 'skip') {
        suppressedSegmentKey = pendingPrompt.key;
      }
      pendingPrompt = null;
    } catch (e) { LOG('removePrompt error', e); }
  }

  function showPrompt(seg, rule, action = 'skip', seconds = 5, fromTime = null) {
    try {
      removePrompt(false);
      document.getElementById('bsb-prompt')?.remove();

      const div = document.createElement('div');
      div.id = 'bsb-prompt';
      div.style.cssText = `
        position:fixed; right:40px; bottom:120px; background:rgba(0,0,0,0.78);
        color:#fff; padding:10px 14px; border-radius:10px; font-size:14px;
        z-index:2147483647; display:flex; align-items:center; gap:8px;
        pointer-events:auto; user-select:none; opacity:0;
      `;

      const span = document.createElement('span');
      span.style.color = rule.color;
      span.style.cursor = 'pointer';
      span.innerHTML = `[${rule.label}] ｜ 按 Enter ${action === 'undo' ? '撤销' : '跳过'} (<span id="bsb-count">${seconds}</span>s)`;
      span.addEventListener('click', ev => {
        ev.stopPropagation();
        runPromptAction();
      });

      const closeBtn = document.createElement('span');
      closeBtn.id = 'bsb-close';
      closeBtn.textContent = '✕';
      closeBtn.style.cssText = 'cursor:pointer;margin-left:8px;pointer-events:auto;';
      closeBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        removePrompt(true);
      });

      div.appendChild(span);
      div.appendChild(closeBtn);
      uiRoot().appendChild(div);
      requestAnimationFrame(() => { div.style.transition='opacity .18s'; div.style.opacity='1'; });

      pendingPrompt = {
        seg, rule, key: segKeyFor(seg), action, fromTime, video: videoEl,
        deadline: Date.now() + seconds * 1000
      };
      const countSpan = div.querySelector('#bsb-count');
      promptTimer = setInterval(() => {
        if (!pendingPrompt || pendingPrompt.video !== videoEl) return;
        const remain = Math.ceil((pendingPrompt.deadline - Date.now()) / 1000);
        if (remain <= 0) removePrompt(true);
        else if (countSpan) countSpan.textContent = String(remain);
      }, 1000);
    } catch (e) { LOG('showPrompt error', e); }
  }

  function showNotice(text, color='rgba(0,212,0,0.92)') {
    try {
      const el = document.createElement('div');
      el.textContent = text;
      Object.assign(el.style, {
        position: 'fixed', right: '28px', bottom: '120px',
        background: color, color: '#fff', padding: '8px 12px',
        borderRadius: '8px', fontSize: '14px', zIndex: 2147483647,
        pointerEvents: 'none', opacity: '0', transition: 'opacity .2s'
      });
      const target = uiRoot();
      target.appendChild(el);
      requestAnimationFrame(() => el.style.opacity='1');
      setTimeout(() => el.style.opacity='0', 1600);
      setTimeout(() => el.remove(), 2000);
    } catch (e) { LOG('showNotice error', e); }
  }

  // ---------- key handling: Enter skip / undo, Delete close ----------
  if (!window.__bsb_keys_attached) {
    window.addEventListener('keydown', (ev) => {
      try {
        const target = ev.target;
        if (target?.isContentEditable || target?.closest?.('input,textarea,select,[contenteditable=\"true\"]')) return;
        if (ev.key === 'Enter' && !ev.repeat && !ev.isComposing &&
            !ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
          if (pendingPrompt && runPromptAction()) {
            ev.preventDefault();
            ev.stopPropagation();
          }
        } else if (pendingPrompt && (ev.key === 'Delete' || ev.key === 'Backspace')) {
          removePrompt(true);
          showNotice('已关闭提示', 'rgba(120,120,120,0.9)');
        }
      } catch (e) { LOG('keydown handler error', e); }
    }, { passive: false });
    window.__bsb_keys_attached = true;
  }

  // ---------- playback handlers ----------
  function syncPlaybackContext() {
    if (getBV() === currentBV) return true;
    initializeForBV();
    return false;
  }

  function inSegmentAtTime(t) {
    return segments.find(s => t >= s.start && t < s.end);
  }

  function onTimeUpdate() {
    if (!videoEl || !syncPlaybackContext()) return;
    const t = videoEl.currentTime;
    const seg = inSegmentAtTime(t);

    if (!seg) {
      if (suppressedSegmentKey) suppressedSegmentKey = null;
      manualInSegment = false;
      if (pendingPrompt?.action === 'skip') removePrompt(false);
      lastTime = t;
      return;
    }

    const key = segKeyFor(seg);
    if (pendingPrompt?.action === 'skip' && pendingPrompt.key !== key) removePrompt(false);
    const rule = CATEGORY_RULES[seg.category];
    if (!rule) { lastTime = t; return; }
    if (suppressedSegmentKey === key) { lastTime = t; return; }

    const delta = t - lastTime;
    const naturalPlay = delta > 0 && delta < 2 && !userSeeking && !manualInSegment;
    lastTime = t;

    if (rule.mode === 'auto' && naturalPlay) {
      performSkip(seg, rule);
    } else if (rule.mode === 'manual' && naturalPlay && !pendingPrompt) {
      showPrompt(seg, rule);
    }
  }

  function onSeeking() {
    if (!videoEl || !syncPlaybackContext()) return;
    userSeeking = true;
    try {
      const t = videoEl.currentTime;
      const seg = inSegmentAtTime(t);
      if (seg) manualInSegment = true;
    } catch (e) { LOG('onSeeking error', e); }
  }

  function onSeeked() {
    if (!videoEl || !syncPlaybackContext()) return;
    const requestId = segmentRequestId;
    try {
      const t = videoEl.currentTime;
      const ownSeek = ownSeekTime !== null && Math.abs(ownSeekTime - t) < 0.25;
      ownSeekTime = null;
      if (!ownSeek && pendingPrompt?.action === 'undo') removePrompt(false);
      const seg = inSegmentAtTime(t);
      if (seg) {
        manualInSegment = true;
        const rule = CATEGORY_RULES[seg.category];
        if (rule && rule.mode !== 'marker' && !ownSeek && !pendingPrompt) {
          const seekingVideo = videoEl;
          setTimeout(() => {
            if (requestId !== segmentRequestId || pendingPrompt || videoEl !== seekingVideo) return;
            if (videoEl.currentTime >= seg.start && videoEl.currentTime < seg.end) showPrompt(seg, rule);
          }, 60);
        }
      } else {
        manualInSegment = false;
      }
    } catch (e) { LOG('onSeeked error', e); }
    setTimeout(() => { if (requestId === segmentRequestId) userSeeking = false; }, 700);
  }

  function attachVideoHandlers(v) {
    if (!v || videoEl === v) return;
    if (videoEl && videoEl !== v) {
      try {
        removePrompt(false);
        ownSeekTime = null;
        videoEl.removeEventListener('timeupdate', onTimeUpdate);
        videoEl.removeEventListener('seeking', onSeeking);
        videoEl.removeEventListener('seeked', onSeeked);
        videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
      } catch (e) { /* ignore */ }
    }
    videoEl = v;
    videoEl.addEventListener('timeupdate', onTimeUpdate, { passive: true });
    videoEl.addEventListener('seeking', onSeeking);
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
    LOG('Attached video handlers.');
  }

  function onLoadedMetadata() {
    delayedMarkerAttempts(3, 700);
  }

  // progress observer
  function attachProgressObserver() {
    try {
      if (observer) { observer.disconnect(); observer = null; }
      const target = findProgress();
      if (!target) return;
      observer = new MutationObserver(() => scheduleRenderThrottled());
      observer.observe(target, { childList: true, subtree: true });
      LOG('Progress observer attached.');
    } catch (e) { LOG('attachProgressObserver error', e); }
  }

  // pollers to detect replacements
  function checkVideoChange() {
    try {
      const v = findVideo();
      if (v && v !== videoEl) {
        LOG('Detected video element change -> reattach');
        attachVideoHandlers(v);
        scheduleRenderThrottled();
        delayedMarkerAttempts(3,700);
        attachProgressObserver();
      }
    } catch (e) { LOG('checkVideoChange error', e); }
  }

  function checkProgressAndMarkers() {
    const now = Date.now();
    if (now - lastProgressCheck < 900) return;
    lastProgressCheck = now;
    try {
      if (!videoEl) {
        const v = findVideo();
        if (v) attachVideoHandlers(v);
      }
      if (!videoEl || !segments.length) return;
      const p = findProgress();
      if (!p) { delayedMarkerAttempts(3,800); return; }
      if (!markerLayer || !p.contains(markerLayer)) {
        LOG('Marker layer missing -> reattach');
        ensureMarkerLayerAttached();
        scheduleRenderThrottled();
        delayedMarkerAttempts(3,700);
      } else if (markerLayer.children.length === 0 && segments.length > 0) {
        scheduleRenderThrottled();
      }
      if (!observer) attachProgressObserver();
    } catch (e) { LOG('checkProgressAndMarkers error', e); }
  }

  // init for BV
  async function initializeForBV() {
    const bv = getBV();
    if (bv === currentBV) return;
    const requestId = ++segmentRequestId;
    removePrompt(false);
    ownSeekTime = null;
    currentBV = bv;
    LOG('Initialize for', bv);
    segments = [];
    if (markerLayer) markerLayer.innerHTML = '';
    suppressedSegmentKey = null;
    manualInSegment = false;
    userSeeking = false;
    lastTime = 0;
    if (!bv) return;

    const fetchedSegments = await fetchSegments(bv);
    if (requestId !== segmentRequestId || getBV() !== bv) return;
    segments = fetchedSegments;
    LOG('Segments loaded', segments.length);

    const v = findVideo();
    if (v) attachVideoHandlers(v);
    scheduleRenderThrottled();
    delayedMarkerAttempts(3, 700);
    attachProgressObserver();
  }

  // SPA detection + pollers
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      LOG('URL changed -> init');
      initializeForBV();
    }
    try { checkVideoChange(); checkProgressAndMarkers(); } catch (e) {}
  }, 800);

  // light global observer to detect heavy DOM churn
  const globalObserver = new MutationObserver((muts) => {
    if (muts.length > 8) setTimeout(initializeForBV, 900);
  });
  globalObserver.observe(document.body, { childList: true, subtree: true });

  // start
  setTimeout(initializeForBV, 1200);

  // Expose debug helper
  window.__bsb_debug_state = () => ({
    currentBV, segmentsCount: segments.length, videoExists: !!videoEl, progressExists: !!findProgress(), markerExists: !!markerLayer, suppressedSegmentKey
  });

  LOG('BSB+ FIX6R7 loaded.');
})();