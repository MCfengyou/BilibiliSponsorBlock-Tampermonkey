// ==UserScript==
// @license MIT
// @name         BilibiliSponsorBlock-Tampermonkey
// @namespace    https://github.com/MCfengyou/BilibiliSponsorBlock-Tampermonkey/
// @version      0.3
// @description  使用 bsbsb.top API 跳过标注片段，并以绿色在进度条上标注广告时段
// @author       NeoGe
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ====== 配置 ======
  const API_BASE = 'https://bsbsb.top/api/skipSegments';
  const EXT_VERSION_HEADER = 'tampermonkey-bsb-0.3';
  const POLL_INTERVAL = 1200;
  const LOG_PREFIX = '[BSB-TM]';

  let segments = [];
  let enabled = true;
  let activeVideo = null;
  let skipCooldown = false;
  let currentBVID = null;
  let markersContainer = null;
  let observer = null;

  function log(...args) { console.log(LOG_PREFIX, ...args); }

  // ====== 获取视频 ID ======
  function getBVIDFromUrl() {
    const m1 = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    const m2 = location.search.match(/[?&]bvid=(BV[0-9A-Za-z]+)/);
    return (m1 && m1[1]) || (m2 && m2[1]) || null;
  }
  function getCIDFromPage() {
    try {
      const st = window.__INITIAL_STATE__;
      if (st?.videoData?.cid) return String(st.videoData.cid);
      if (st?.epInfo?.cid) return String(st.epInfo.cid);
      if (st?.pages?.[0]?.cid) return String(st.pages[0].cid);
    } catch {}
    return null;
  }

  // ====== 调用 SponsorBlock API ======
  async function fetchSegments(bvid) {
    if (!bvid) return [];
    try {
      const cid = getCIDFromPage();
      const url = new URL(API_BASE);
      url.searchParams.set('videoID', bvid);
      if (cid) url.searchParams.set('cid', cid);
      const res = await fetch(url, {
        headers: { 'x-ext-version': EXT_VERSION_HEADER, 'origin': location.origin },
      });
      if (!res.ok) return [];
      const data = await res.json();
      const out = [];
      if (Array.isArray(data)) {
        for (const it of data) {
          if (it.segment) {
            out.push({ start: +it.segment[0], end: +it.segment[1], category: it.category || '' });
          } else if (it.segments) {
            for (const s of it.segments)
              out.push({ start: +s.segment[0], end: +s.segment[1], category: s.category || '' });
          }
        }
      }
      out.sort((a, b) => a.start - b.start);
      log('Loaded segments:', out.length);
      return out;
    } catch (e) {
      console.error(LOG_PREFIX, e);
      return [];
    }
  }

  // ====== 查找视频元素 ======
  function findVideo() {
    const v = [...document.querySelectorAll('video')].find(v => v.offsetParent);
    return v || document.querySelector('video');
  }

  // ====== 查找进度条元素 ======
  function findProgressBar() {
    const sel = [
      '.bpx-player-progress',
      '.bilibili-player-progress',
      '.bilibili-player-video-control-bottom .bui-progress',
      '.bui-progress',
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  // ====== 渲染绿色标记 ======
  function renderMarkers() {
    if (!markersContainer || !activeVideo || !segments?.length) return;
    markersContainer.innerHTML = '';
    const dur = activeVideo.duration || 0;
    if (!dur) return;
    for (const s of segments) {
      if (isNaN(s.start) || isNaN(s.end) || s.end <= s.start) continue;
      const left = (s.start / dur) * 100;
      const width = Math.max(0.25, ((s.end - s.start) / dur) * 100);
      const div = document.createElement('div');
      Object.assign(div.style, {
        position: 'absolute',
        left: left + '%',
        width: width + '%',
        top: 0,
        height: '100%',
        background: 'rgba(0,255,0,0.5)', // 绿色标记
        borderRadius: '2px',
        pointerEvents: 'auto',
        cursor: 'pointer',
      });
      div.title = `广告段 ${formatTime(s.start)}-${formatTime(s.end)}`;
      div.onclick = e => {
        e.stopPropagation();
        activeVideo.currentTime = s.start + 0.05;
      };
      markersContainer.appendChild(div);
    }
  }

  // ====== 进度条容器 ======
  function ensureMarkersContainer(progressEl) {
    if (!progressEl) return null;
    if (markersContainer && progressEl.contains(markersContainer)) return markersContainer;
    const c = document.createElement('div');
    Object.assign(c.style, {
      position: 'absolute',
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      pointerEvents: 'none',
      zIndex: 9999,
    });
    if (getComputedStyle(progressEl).position === 'static') progressEl.style.position = 'relative';
    progressEl.appendChild(c);
    markersContainer = c;
    return c;
  }

  // ====== 自动跳过逻辑 ======
  function findSegment(t) {
    return segments.find(s => t >= s.start && t < s.end - 0.05);
  }
  function onTimeUpdate(e) {
    if (!enabled || skipCooldown) return;
    const v = e.currentTarget;
    if (v.paused || v.seeking) return;
    const t = v.currentTime;
    const seg = findSegment(t);
    if (seg) {
      skipCooldown = true;
      v.currentTime = Math.min(seg.end + 0.05, v.duration);
      log(`Skipped ${formatTime(seg.start)}→${formatTime(seg.end)}`);
      setTimeout(() => (skipCooldown = false), 700);
    }
  }

  // ====== 附加到 video ======
  function attachVideo(v) {
    if (!v || v === activeVideo) return;
    activeVideo = v;
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('seeked', () => (skipCooldown = false));
    const p = findProgressBar();
    ensureMarkersContainer(p);
    renderMarkers();
  }

  // ====== 主循环 ======
  async function loop() {
    const bvid = getBVIDFromUrl();
    if (!bvid) return;
    if (bvid !== currentBVID) {
      currentBVID = bvid;
      segments = await fetchSegments(bvid);
      const p = findProgressBar();
      ensureMarkersContainer(p);
      renderMarkers();
    }
    const v = findVideo();
    if (v) attachVideo(v);
  }
  setInterval(loop, POLL_INTERVAL);

  function formatTime(s) {
    s = Math.floor(s);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  log('Bilibili SponsorBlock green marker script loaded.');
})();
