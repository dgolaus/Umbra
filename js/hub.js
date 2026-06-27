/* =========================================================================
   gfxs0da · utility hub — HUB controller
   Tool switching · active-tool tracking · ambient effects · smooth scroll.
   Loaded first; exposes window.Hub for the three tool modules.
   ========================================================================= */
(function () {
  'use strict';

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  var TOOLS = ['update', 'mosaic', 'rocalc'];
  var DEFAULT_TOOL = 'update';
  var LS_KEY = 'hub.lastTool';
  var TITLES = {
    update: 'update icon — umbra',
    mosaic: 'mosaic — umbra',
    rocalc: 'rocalc — umbra'
  };

  var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isTouch = matchMedia('(hover: none)').matches;

  /* ---------- public API ---------- */
  var Hub = {
    activeTool: null,
    isActive: function (name) { return Hub.activeTool === name; },
    show: function (name) { switchTo(name); }
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

    // keyboard shortcuts: 1 / 2 / 3 switch tools (ignored while typing)
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      var idx = { '1': 0, '2': 1, '3': 2 }[e.key];
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
     Mosaic on mobile). Never hijacks an internal scroll region (.controls). */
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

    window.addEventListener('wheel', function (e) {
      if (e.ctrlKey) return;
      if (!bodyScrollable()) return;
      if (e.target.closest && e.target.closest('.controls')) return; // mosaic internal scroll
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
