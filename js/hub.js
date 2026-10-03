/* =========================================================================
   gfxs0da · utility hub — HUB controller
   Tool switching · active-tool tracking · ambient effects · smooth scroll.
   Loaded first; exposes window.Hub for the tool modules (incl. the
   send / inbox handoff between tools).
   ========================================================================= */
(function () {
  'use strict';

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  var TOOLS = ['update', 'mosaic', 'rocalc', 'frontpage', 'crop', 'gltf'];
  var DEFAULT_TOOL = 'update';
  var LS_KEY = 'hub.lastTool';
  var TITLES = {
    update: 'update icon — umbra',
    mosaic: 'mosaic — umbra',
    rocalc: 'rocalc — umbra',
    frontpage: 'frontpage — umbra',
    crop: 'crop — umbra',
    gltf: 'gltf → png — umbra'
  };

  var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isTouch = matchMedia('(hover: none)').matches;

  /* ---------- public API ---------- */
  var Hub = {
    activeTool: null,
    isActive: function (name) { return Hub.activeTool === name; },
    show: function (name) { switchTo(name); },
    // tool → tool handoff: queue the payload, announce it, then open the target.
    // receivers drain via takeInbox so nothing is processed twice.
    inbox: {},
    send: function (target, payload) {
      if (!target || payload == null) return;
      (Hub.inbox[target] = Hub.inbox[target] || []).push(payload);
      document.dispatchEvent(new CustomEvent('hub:receive', { detail: { target: target, payload: payload } }));
      switchTo(target);
    },
    takeInbox: function (target) {
      var list = Hub.inbox[target] || [];
      Hub.inbox[target] = [];
      return list;
    }
  };
  window.Hub = Hub;

  /* ---------- tool switching ---------- */
  var tabs = {};       // name -> button
  var panels = {};     // name -> .tool element
  var indicator = null;
  var tabsWrap = null;

  function moveIndicator(name) {
    if (!indicator) return;
    var tab = tabs[name];
    if (!tab) return;
    indicator.style.left = tab.offsetLeft + 'px';
    indicator.style.width = tab.offsetWidth + 'px';
  }

  function switchTo(name) {
    if (TOOLS.indexOf(name) === -1) name = DEFAULT_TOOL;
    if (Hub.activeTool === name) return;
    Hub.activeTool = name;

    TOOLS.forEach(function (t) {
      var on = (t === name);
      if (panels[t]) panels[t].classList.toggle('is-active', on);
      if (tabs[t]) {
        tabs[t].classList.toggle('is-active', on);
        tabs[t].setAttribute('aria-selected', on ? 'true' : 'false');
      }
    });

    document.body.dataset.tool = name;
    document.title = TITLES[name] || 'umbra';
    moveIndicator(name);
    try { localStorage.setItem(LS_KEY, name); } catch (e) {}
    // don't clobber a Mosaic config-share hash (#cfg=…) before Mosaic reads it
    if ((location.hash || '').indexOf('#cfg=') !== 0) {
      try { history.replaceState(null, '', '#' + name); } catch (e) {}
    }

    // tools that pause body scroll start at top
    window.scrollTo(0, 0);
    document.dispatchEvent(new CustomEvent('hub:show', { detail: { tool: name } }));
  }

  function initNav() {
    tabsWrap = document.querySelector('.hubnav__tabs');
    indicator = document.querySelector('.hubnav__indicator');

    Array.prototype.forEach.call(document.querySelectorAll('.hubnav__tab'), function (btn) {
      var name = btn.dataset.tool;
      tabs[name] = btn;
      btn.addEventListener('click', function () { switchTo(name); });
    });
    TOOLS.forEach(function (t) { panels[t] = document.getElementById('tool-' + t); });

    var brand = document.querySelector('.hubnav__brand');
    if (brand) brand.addEventListener('click', function (e) { e.preventDefault(); switchTo(DEFAULT_TOOL); });

    // keyboard shortcuts: 1 / 2 / 3 / 4 / 5 switch tools (ignored while typing)
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      var idx = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5 }[e.key];
      if (idx != null) switchTo(TOOLS[idx]);
    });

    // initial tool: hash > last used > default
    var fromHash = (location.hash || '').replace('#', '');
    var saved = null;
    try { saved = localStorage.getItem(LS_KEY); } catch (e) {}
    var start = TOOLS.indexOf(fromHash) !== -1 ? fromHash
              : (TOOLS.indexOf(saved) !== -1 ? saved : DEFAULT_TOOL);
    if ((location.hash || '').indexOf('#cfg=') === 0) start = 'mosaic';

    // force a switch (activeTool starts null so it always runs)
    switchTo(start);
    // re-place indicator once fonts/layout settle
    moveIndicator(start);
    setTimeout(function () { moveIndicator(Hub.activeTool); }, 120);
    window.addEventListener('load', function () { moveIndicator(Hub.activeTool); });
    window.addEventListener('resize', function () { moveIndicator(Hub.activeTool); });

    // back/forward between tool hashes
    window.addEventListener('hashchange', function () {
      var h = (location.hash || '').replace('#', '');
      if (TOOLS.indexOf(h) !== -1) switchTo(h);
    });
  }

  /* ---------- shared smooth scroll (lerp 0.10) ----------
     Active only when the body actually scrolls (Update Icon / RoCalc, and
     Mosaic on mobile). Never hijacks an internal scroll region (.controls,
     or a [data-native-scroll] element that currently scrolls). */
  function initSmoothScroll() {
    if (reduceMotion || isTouch) return;
    var target = window.scrollY, current = window.scrollY, raf = null;
    var EASE = 0.10;

    var bodyScrollable = function () { return document.documentElement.scrollHeight > window.innerHeight + 1; };
    var maxScroll = function () { return Math.max(0, document.documentElement.scrollHeight - window.innerHeight); };
    var clamp = function (v) { return Math.max(0, Math.min(v, maxScroll())); };

    function loop() {
      current += (target - current) * EASE;
      if (Math.abs(target - current) < 0.5) { current = target; window.scrollTo(0, current); raf = null; return; }
      window.scrollTo(0, current);
      raf = requestAnimationFrame(loop);
    }
    function start() { if (raf == null) raf = requestAnimationFrame(loop); }

    // a [data-native-scroll] ancestor only counts while it can really scroll
    // vertically (e.g. the update icon controls are a scroller only above 860px)
    function inNativeScroller(el) {
      var n = el.closest && el.closest('[data-native-scroll]');
      while (n) {
        var oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return true;
        n = n.parentElement && n.parentElement.closest('[data-native-scroll]');
      }
      return false;
    }

    window.addEventListener('wheel', function (e) {
      if (e.ctrlKey) return;
      if (!bodyScrollable()) return;
      if (e.target.closest && (e.target.closest('.controls') || inNativeScroller(e.target))) return; // inner scrollers
      e.preventDefault();
      target = clamp(target + e.deltaY);
      start();
    }, { passive: false });

    window.addEventListener('scroll', function () {
      if (raf != null) return;
      if (Math.abs(window.scrollY - current) > 4) target = current = window.scrollY;
    }, { passive: true });
    window.addEventListener('resize', function () { target = clamp(target); });
    document.addEventListener('hub:show', function () { target = current = 0; });
  }

  /* ---------- boot ---------- */
  function boot() {
    var t0 = performance.now();
    initNav();
    initSmoothScroll();

    // Warm every tool's layout/paint once while the opaque #boot overlay covers
    // the screen, so the first switch to each is served from the content-visibility
    // cache (no first-time freeze). Then fade the splash into the hub.
    var bootEl = document.getElementById('boot');
    function reveal() {
      document.body.classList.remove('warming');
      document.body.classList.add('ready');
      if (bootEl) setTimeout(function () { bootEl.style.display = 'none'; }, 650);
    }
    document.body.classList.add('warming');
    void document.body.offsetHeight;               // force layout of all warmed tools (sync)
    // setTimeout, not rAF — rAF is throttled in background tabs and would leave
    // the splash stuck. setTimeout always fires. ~1.2s lets the neon flicker land.
    setTimeout(reveal, Math.max(0, 1200 - (performance.now() - t0)));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
