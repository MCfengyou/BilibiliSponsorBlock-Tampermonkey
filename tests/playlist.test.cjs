const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'main.js'), 'utf8');
const firstBV = 'BV1xx411c7mD';
const secondBV = 'BV1fS421A7Nj';
const watchlater = bv => `https://www.bilibili.com/list/watchlater${bv ? `?bvid=${bv}` : ''}`;
const sponsor = (start = 1, end = 5) => ({ segment: [start, end], category: 'sponsor' });

// Run the complete userscript with controlled media events, timers and HTTP responses.
function createPage(href) {
  const timeouts = new Map();
  const intervals = new Map();
  const requests = [];
  let nextTimer = 0;

  function createElement(tagName) {
    const element = Object.assign(new EventTarget(), {
      tagName, style: {}, children: [], parentElement: null, innerHTML: '',
      appendChild(child) {
        child.remove();
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      remove() {
        if (this.parentElement) {
          const siblings = this.parentElement.children;
          siblings.splice(siblings.indexOf(this), 1);
          this.parentElement = null;
        }
      },
      contains(child) {
        return this === child || this.children.some(node => node.contains(child));
      },
      querySelector(selector) {
        return this.children.find(child => `#${child.id}` === selector)
          || this.children.map(child => child.querySelector(selector)).find(Boolean)
          || null;
      },
      getClientRects: () => [{}]
    });
    return element;
  }

  const body = createElement('body');
  const video = createElement('video');
  Object.assign(video, { currentTime: 0, duration: 100, offsetParent: body });
  const progress = createElement('div');
  body.appendChild(video);
  body.appendChild(progress);
  const document = {
    body,
    createElement,
    querySelectorAll: selector => selector === 'video' ? [video] : [],
    querySelector: selector => selector === '.bpx-player-progress-wrap' ? progress : null,
    getElementById: id => body.querySelector(`#${id}`)
  };
  const window = new EventTarget();
  const location = { href };
  vm.runInNewContext(source, {
    window, document, location,
    console: { log() {} },
    getComputedStyle: element => ({ position: element.style.position || 'static' }),
    requestAnimationFrame: callback => callback(),
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timeouts.set(id, { callback, delay });
      return id;
    },
    setInterval(callback, delay) {
      const id = ++nextTimer;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: id => intervals.delete(id),
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: url => new Promise(resolve => requests.push({ url, resolve }))
  });

  return {
    document, window, video, location, progress, requests,
    state: () => window.__bsb_debug_state(),
    runTimeout(delay) {
      for (const [id, timer] of [...timeouts]) {
        if (timer.delay === delay) {
          timeouts.delete(id);
          timer.callback();
        }
      }
    },
    poll() {
      for (const timer of intervals.values()) {
        if (timer.delay === 800) timer.callback();
      }
    },
    async respond(index, segments, ok = true) {
      assert.ok(requests[index], `Expected request ${index}`);
      requests[index].resolve({ ok, status: ok ? 200 : 404, json: async () => segments });
      await new Promise(setImmediate);
    },
    playAt(time) {
      video.currentTime = time;
      video.dispatchEvent(new Event('timeupdate'));
    }
  };
}

async function load(page, segments = [sponsor()]) {
  page.runTimeout(1200);
  await page.respond(0, segments);
  page.runTimeout(500);
}

test('matches watch later, favorites and legacy playback URLs', () => {
  const patterns = [...source.matchAll(/^\/\/ @match\s+(\S+)/gm)].map(match => (
    new RegExp(`^${match[1].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  ));
  const urls = [
    watchlater(), watchlater(firstBV),
    `https://www.bilibili.com/list/ml123456?oid=170001&bvid=${firstBV}`,
    `https://www.bilibili.com/list/123456?bvid=${firstBV}`,
    `https://www.bilibili.com/medialist/play/watchlater/${firstBV}`,
    `https://www.bilibili.com/medialist/play/ml123456/${firstBV}`,
    `https://www.bilibili.com/video/${firstBV}/`,
    'https://www.bilibili.com/bangumi/play/ep123456'
  ];
  for (const url of urls) assert.ok(patterns.some(pattern => pattern.test(url)), url);
  assert.ok(!patterns.some(pattern => pattern.test('https://www.bilibili.com/')));
});

test('playlist BV parameters and legacy paths request the correct video', async () => {
  for (const url of [watchlater(firstBV),
    `https://www.bilibili.com/list/ml123456?oid=170001&bvid=${firstBV}`,
    `https://www.bilibili.com/medialist/play/watchlater/${firstBV}`,
    `https://www.bilibili.com/video/${firstBV}/`]) {
    const page = createPage(url);
    await load(page);
    assert.equal(page.requests[0].url, `https://bsbsb.top/api/skipSegments?videoID=${firstBV}`);
    assert.equal(page.state().segmentsCount, 1);
    assert.match(page.progress.children[0].innerHTML, /left:1%;width:4%/);
    page.playAt(0.5);
    page.playAt(1.25);
    assert.equal(page.video.currentTime, 5.05);
  }
});

test('waits for the playlist to select a BV after opening its bare URL', async () => {
  const page = createPage(watchlater());
  page.runTimeout(1200);
  assert.equal(page.requests.length, 0);
  page.location.href = watchlater(firstBV);
  page.poll();
  await page.respond(0, [sponsor()]);
  assert.equal(page.state().currentBV, firstBV);
  assert.equal(page.state().segmentsCount, 1);
});

test('clears old markers and segments before the next request finishes', async () => {
  const page = createPage(watchlater(firstBV));
  await load(page);
  const marker = page.progress.children[0];
  page.location.href = watchlater(secondBV);
  page.poll();
  assert.equal(page.state().currentBV, secondBV);
  assert.equal(page.state().segmentsCount, 0);
  assert.equal(marker.innerHTML, '');
  page.playAt(1.25);
  assert.equal(page.video.currentTime, 1.25);
  await page.respond(1, [sponsor(20, 25)]);
  assert.equal(page.state().segmentsCount, 1);
});

test('media events detect a playlist switch before the URL poll', async () => {
  const page = createPage(watchlater(firstBV));
  await load(page);
  page.playAt(0.5);
  page.location.href = watchlater(secondBV);
  page.playAt(1.25);
  assert.equal(page.video.currentTime, 1.25);
  assert.equal(page.state().currentBV, secondBV);
  assert.equal(page.state().segmentsCount, 0);
  assert.equal(page.requests.length, 2);
});

test('a late response cannot overwrite the current playlist video', async () => {
  const page = createPage(watchlater(firstBV));
  page.runTimeout(1200);
  page.location.href = watchlater(secondBV);
  page.poll();
  await page.respond(1, [sponsor(20, 25), sponsor(30, 35)]);
  await page.respond(0, [sponsor()]);
  assert.equal(page.state().currentBV, secondBV);
  assert.equal(page.state().segmentsCount, 2);
});

test('a late response is ignored even before the URL poll runs', async () => {
  const page = createPage(watchlater(firstBV));
  page.runTimeout(1200);
  page.location.href = watchlater(secondBV);
  await page.respond(0, [sponsor()]);
  assert.equal(page.state().segmentsCount, 0);
  page.poll();
  await page.respond(1, [sponsor(20, 25)]);
  assert.equal(page.state().currentBV, secondBV);
  assert.equal(page.state().segmentsCount, 1);
});

test('returning to the same BV still discards its earlier request', async () => {
  const page = createPage(watchlater(firstBV));
  page.runTimeout(1200);
  page.location.href = watchlater(secondBV);
  page.poll();
  page.location.href = watchlater(firstBV);
  page.poll();
  await page.respond(2, [sponsor(20, 25), sponsor(30, 35)]);
  await page.respond(0, [sponsor()]);
  await page.respond(1, []);
  assert.equal(page.state().currentBV, firstBV);
  assert.equal(page.state().segmentsCount, 2);
});

test('resets playback timing and seeking state for the next video', async () => {
  const page = createPage(watchlater(firstBV));
  await load(page);
  page.playAt(80);
  page.video.dispatchEvent(new Event('seeking'));
  page.location.href = watchlater(secondBV);
  page.poll();
  await page.respond(1, [sponsor()]);
  page.playAt(1.25);
  assert.equal(page.video.currentTime, 5.05);
});

test('removing the current BV clears state and invalidates pending responses', async () => {
  const page = createPage(watchlater(firstBV));
  page.runTimeout(1200);
  page.location.href = watchlater();
  page.poll();
  await page.respond(0, [sponsor()]);
  assert.equal(page.state().currentBV, null);
  assert.equal(page.state().segmentsCount, 0);
  assert.equal(page.requests.length, 1);
});

test('does not show a delayed manual prompt from the previous video', async () => {
  const page = createPage(watchlater(firstBV));
  await load(page, [{ segment: [10, 15], category: 'intro' }]);
  page.video.currentTime = 10;
  page.video.dispatchEvent(new Event('seeked'));
  page.location.href = watchlater(secondBV);
  page.runTimeout(60);
  assert.equal(page.document.getElementById('bsb-prompt'), null);
});

test('Enter cannot skip a new video using a previous manual prompt', async () => {
  const page = createPage(watchlater(firstBV));
  await load(page, [{ segment: [1, 5], category: 'intro' }]);
  page.playAt(0.5);
  page.playAt(1.25);
  assert.ok(page.document.getElementById('bsb-prompt'));
  page.location.href = watchlater(secondBV);
  const event = new Event('keydown');
  event.key = 'Enter';
  page.window.dispatchEvent(event);
  assert.equal(page.video.currentTime, 1.25);
  assert.equal(page.state().currentBV, secondBV);
  assert.equal(page.state().segmentsCount, 0);
});

test('a missing segment response leaves the next video free of old markers', async () => {
  const page = createPage(watchlater(firstBV));
  await load(page);
  page.location.href = watchlater(secondBV);
  page.poll();
  await page.respond(1, [], false);
  assert.equal(page.state().segmentsCount, 0);
  assert.equal(page.progress.children[0].innerHTML, '');
});
