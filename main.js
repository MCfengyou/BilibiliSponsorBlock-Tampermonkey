// ==UserScript==
// @license MIT
// @name         BilibiliSponsorBlock-Tampermonkey
// @namespace    https://github.com/MCfengyou/BilibiliSponsorBlock-Tampermonkey
// @version      0.3
// @description  使用 bsbsb.top API 跳过标注片段，并以绿色在进度条上标注广告时段
// @author       NeoGe_and_GPT-5
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
 
 
(function() {
  'use strict';
  console.log('[BSB+ FIX3 v3.1] loaded');
 
  let video = null;
  let segments = [];
  let currentBVID = null;
  let markersContainer = null;
  let manualWhitelist = new Set();
  let userInteracting = false;
  let skipCooldown = false;
 
  const POLL_INTERVAL = 1000;
  const SEGMENT_COLOR = 'rgba(0,255,0,0.52)';
  const LOG = (...a)=>console.log('[BSB+ FIX3]',...a);
 
  // --- helpers ---
  function getBVIDFromUrl() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return m ? m[1] : null;
  }
  function getCID() {
    try {
      const s = window.__INITIAL_STATE__;
      return s?.videoData?.cid || s?.epInfo?.cid || s?.pages?.[0]?.cid || null;
    } catch (e) { return null; }
  }
 
  // --- robust fetch with multiple endpoints and content-type check ---
  async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 6000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(resource, { ...options, signal: controller.signal });
      clearTimeout(id);
      return res;
    } finally {
      clearTimeout(id);
    }
  }
 
  async function fetchSegments(bvid) {
    if (!bvid) return [];
    const cid = getCID();
    // endpoint templates to try (note: real project uses /api/skipSegments?videoID=BV..)
    const endpoints = [
      { base: 'https://bsbsb.top/api/skipSegments', paramName: 'videoID' },
      { base: 'https://bsbsb.top/api/skipSegments', paramName: 'bvid' }, // try alternative
      { base: 'https://bsbsb.top/api/segments', paramName: 'videoID' },
      { base: 'https://bsbsb.top/api/segments', paramName: 'bvid' }
    ];
 
    for (const ep of endpoints) {
      try {
        const url = new URL(ep.base);
        url.searchParams.set(ep.paramName, bvid);
        if (cid) url.searchParams.set('cid', cid);
        LOG('Trying SponsorBlock API:', url.toString());
        let res;
        try {
          res = await fetchWithTimeout(url.toString(), { timeout: 7000, credentials: 'omit' });
        } catch (e) {
          LOG('Fetch failed/timeout for', url.toString(), e && e.name ? e.name : e);
          continue;
        }
        if (!res.ok) {
          LOG('Non-ok status', res.status, 'for', url.toString());
          continue;
        }
        const ctype = res.headers.get('content-type') || '';
        if (!ctype.includes('application/json')) {
          LOG('Response not JSON (content-type=', ctype, '), skipping this endpoint');
          // avoid trying to parse HTML error page
          continue;
        }
        const data = await res.json();
        // parse returned structure (two common shapes)
        const parsed = [];
        if (Array.isArray(data)) {
          // array might be segments directly or wrapper with segments
          for (const item of data) {
            if (item.segment && Array.isArray(item.segment)) {
              parsed.push({ start: Number(item.segment[0]), end: Number(item.segment[1]), category: item.category || '' });
            } else if (item.segments && Array.isArray(item.segments)) {
              for (const s of item.segments) {
                if (s.segment) parsed.push({ start: Number(s.segment[0]), end: Number(s.segment[1]), category: s.category || '' });
              }
            }
          }
        } else if (data && typeof data === 'object') {
          // some APIs return { segments: [...] }
          if (data.segments && Array.isArray(data.segments)) {
            for (const s of data.segments) {
              if (s.segment) parsed.push({ start: Number(s.segment[0]), end: Number(s.segment[1]), category: s.category || '' });
            }
          }
        }
        parsed.sort((a,b)=>a.start-b.start);
        LOG('Parsed segments count:', parsed.length, 'from', url.toString());
        return parsed;
      } catch (err) {
        LOG('Error while trying endpoint', err);
        continue;
      }
    }
    LOG('All endpoints tried, no valid JSON segments returned.');
    return [];
  }
 
  // --- DOM utilities ---
  function findVideo() {
    return document.querySelector('video');
  }
  function findProgressBar() {
    // try several selectors; B 站 UI differs by skin
    const candidates = [
      '.bpx-player-progress', '.bpx-player-progress-wrapper',
      '.bilibili-player-video-progress', '.bilibili-player-progress',
      '.bui-progress', '.bilibili-player-video-control-bottom .bui-progress'
    ];
    for (const s of candidates) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    // fallback: find element that looks like a progress bar (role=slider)
    const slider = document.querySelector('[role="slider"]');
    if (slider) return slider;
    return null;
  }
 
  function ensureMarkerContainer(progressEl) {
    if (!progressEl) return;
    if (markersContainer && progressEl.contains(markersContainer)) return markersContainer;
    // remove old if exists
    if (markersContainer && markersContainer.parentElement) markersContainer.parentElement.removeChild(markersContainer);
    const node = document.createElement('div');
    node.className = 'bsb-marker-container';
    Object.assign(node.style, {
      position: 'absolute',
      left: 0, top: 0, width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: 9999,
    });
    // make sure parent is positioned
    const computed = getComputedStyle(progressEl);
    if (computed.position === 'static') progressEl.style.position = 'relative';
    progressEl.appendChild(node);
    markersContainer = node;
    return node;
  }
 
  function renderMarkers() {
    if (!markersContainer || !video) return;
    markersContainer.innerHTML = '';
    const dur = video.duration || 0;
    if (!dur || !isFinite(dur) || dur <= 0) return;
    for (const s of segments) {
      if (s.end <= s.start) continue;
      const left = (s.start / dur) * 100;
      const width = ((s.end - s.start) / dur) * 100;
      const mark = document.createElement('div');
      Object.assign(mark.style, {
        position: 'absolute',
        left: left + '%',
        width: width + '%',
        top: 0,
        height: '100%',
        background: SEGMENT_COLOR,
        pointerEvents: 'none' // do not capture clicks
      });
      markersContainer.appendChild(mark);
    }
  }
 
  // --- skip logic (natural play only) ---
  function findSegmentAtTime(t) {
    for (const s of segments) if (t >= s.start && t < s.end) return s;
    return null;
  }
 
  function showSkipNotice(text) {
    const existing = document.getElementById('bsb-skip-notice');
    if (existing) existing.remove();
    const notice = document.createElement('div');
    notice.id = 'bsb-skip-notice';
    notice.innerText = text;
    Object.assign(notice.style, {
      position: 'fixed',
      right: '18px',
      bottom: '86px', // slightly higher to avoid controls
      padding: '10px 14px',
      background: 'rgba(0,170,0,0.92)',
      color: '#fff',
      borderRadius: '8px',
      zIndex: 2147483647,
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity .25s ease'
    });
    const target = document.fullscreenElement || document.body;
    target.appendChild(notice);
    requestAnimationFrame(()=> notice.style.opacity = '1');
    setTimeout(()=> notice.style.opacity = '0', 2200);
    setTimeout(()=> notice.remove(), 2600);
  }
 
  function attachVideoEvents(v) {
    if (!v) return;
    video = v;
    LOG('attached to video element');
 
    // track lastTime to detect natural play (forward small increments)
    let lastTime = 0;
    v.addEventListener('timeupdate', () => {
      if (!video) return;
      const t = video.currentTime;
      // clean manual whitelist entries that are past
      for (const k of Array.from(manualWhitelist)) {
        const [st, ed] = k.split('-').map(Number);
        if (t >= ed) manualWhitelist.delete(k);
      }
      const seg = findSegmentAtTime(t);
      const delta = t - lastTime;
      const naturalPlay = (delta > 0 && delta < 2 && !userInteracting);
      if (seg) {
        const key = `${seg.start}-${seg.end}`;
        if (manualWhitelist.has(key)) {
          // user manually entered this segment -> do not auto skip
        } else if (naturalPlay && !skipCooldown) {
          skipCooldown = true;
          try {
            video.currentTime = Math.min(seg.end + 0.05, video.duration || seg.end + 0.05);
            showSkipNotice('赞助/恰饭段已跳过 ✓');
            LOG('auto-skipped segment', seg);
          } catch (e) {
            LOG('seek failed', e);
          }
          setTimeout(()=> skipCooldown = false, 900);
        }
      }
      lastTime = t;
    });
 
    // seeking handlers: mark manual interactions and add whitelist on seeked if inside a segment
    v.addEventListener('seeking', ()=> { userInteracting = true; });
    v.addEventListener('seeked', ()=> {
      setTimeout(()=>{
        const t = video.currentTime;
        const seg = findSegmentAtTime(t);
        if (seg) {
          const key = `${seg.start}-${seg.end}`;
          manualWhitelist.add(key);
          LOG('用户手动进入广告段，加入白名单:', key);
        }
        // keep userInteracting true briefly to avoid racing with timeupdate
        setTimeout(()=> userInteracting = false, 500);
      }, 20);
    });
 
    v.addEventListener('loadedmetadata', ()=> {
      // re-render markers when duration becomes available
      const p = findProgressBar();
      ensureMarkerContainer(p);
      renderMarkers();
    });
  }
 
  // --- main loop ---
  async function mainLoop() {
    const bvid = getBVIDFromUrl();
    if (!bvid) return;
 
    if (bvid !== currentBVID) {
      currentBVID = bvid;
      LOG('BV changed ->', bvid);
      // fetch segments robustly
      segments = await fetchSegments(bvid);
      // normalize (some API shapes might differ); ensure numeric
      segments = (segments || []).map(s=>({ start: Number(s.start), end: Number(s.end), category: s.category || '' })).filter(s=>isFinite(s.start) && isFinite(s.end) && s.end > s.start);
      LOG('segments after normalize:', segments.length);
      manualWhitelist.clear();
 
      // attach or refresh markers
      const p = findProgressBar();
      ensureMarkerContainer(p);
      renderMarkers();
    }
 
    // detect progress bar re-creation and reattach markers
    const progressEl = findProgressBar();
    if (progressEl && (!markersContainer || !progressEl.contains(markersContainer))) {
      ensureMarkerContainer(progressEl);
      renderMarkers();
      LOG('Detected progress rebuild -> reattached markers.');
    }
 
    // attach video element if changed
    const v = findVideo();
    if (v && v !== video) attachVideoEvents(v);
  }
 
  setInterval(mainLoop, POLL_INTERVAL);
 
})();
