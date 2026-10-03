/* =========================================================================
   HOME · landing page — typewriter hero ("stop … → just use umbra.") and
   the tool cards. Plays once per tab session; click / any key skips it.
   ========================================================================= */
(function () {
  'use strict';

  var PAINS = [
    'stop juggling ten tabs.',
    'stop cropping icons by hand.',
    'stop fighting gltf files.'
  ];
  var FINAL = 'just use umbra, bro.';
  var SS_KEY = 'home.typed';

  var hero, line, caret;
  var running = false, skipped = false, timer = null;

  var $ = function (id) { return document.getElementById(id); };
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function seen() { try { return sessionStorage.getItem(SS_KEY) === '1'; } catch (e) { return false; } }
  function markSeen() { try { sessionStorage.setItem(SS_KEY, '1'); } catch (e) {} }
  function wait(ms) { return new Promise(function (r) { timer = setTimeout(r, ms); }); }

  function setText(t) { line.textContent = t; }
  function showFinal(animateNeon) {
    clearTimeout(timer);
    running = false;
    line.innerHTML = 'just use <span class="hm-brand">umbra</span>, bro.';
    var brand = line.querySelector('.hm-brand');
    if (animateNeon) { void brand.offsetWidth; }
    brand.classList.add('is-lit');
    caret.classList.remove('is-typing');
    caret.classList.add('is-done');
    hero.classList.remove('is-typing');
    // the nav slides back in right after the line lands
    setTimeout(function () { document.body.classList.remove('nav-hidden'); }, animateNeon ? 450 : 0);
    markSeen();
  }

  // human-ish rhythm: a bit of jitter per key, deletes faster than typing
  function typeOut(text) {
    var i = 0;
    function step() {
      if (skipped) return Promise.resolve();
      i++;
      setText(text.slice(0, i));
      if (i >= text.length) return Promise.resolve();
      var ch = text.charAt(i - 1);
      return wait(38 + Math.random() * 46 + (ch === ' ' ? 30 : 0)).then(step);
    }
    return step();
  }
  function deleteOut() {
    function step() {
      if (skipped) return Promise.resolve();
      var t = line.textContent;
      if (!t.length) return Promise.resolve();
      setText(t.slice(0, -1));
      return wait(18 + Math.random() * 14).then(step);
    }
    return step();
  }

  function play() {
    if (running) return;
    if (skipped || seen()) { showFinal(false); return; }
    running = true; skipped = false;
    hero.classList.add('is-typing');
    document.body.classList.add('nav-hidden');
    caret.classList.remove('is-done');
    caret.classList.add('is-typing');
    setText('');
    var chain = wait(450);
    PAINS.forEach(function (p) {
      chain = chain
        .then(function () { return typeOut(p); })
        .then(function () { caret.classList.remove('is-typing'); return skipped ? null : wait(950); })
        .then(function () { caret.classList.add('is-typing'); return deleteOut(); })
        .then(function () { return skipped ? null : wait(260); });
    });
    chain
      .then(function () { return typeOut(FINAL); })
      .then(function () { if (!skipped) showFinal(true); });
  }
  function skip() {
    // also before the first key lands (splash still lifting): the hero is already in its typing state
    if (!running && !hero.classList.contains('is-typing')) return;
    skipped = true;
    showFinal(false);
  }


  function start() {
    if (!window.Hub || !Hub.isActive('home')) return;
    if (seen() || reduce) { showFinal(false); return; }
    play();
  }

  function init() {
    hero = $('hm-hero'); line = $('hm-line'); caret = $('hm-caret');
    if (!hero || !line || !caret) return;

    // cards + continue: switch tools in place (works on file:// too, no reload)
    document.getElementById('tool-home').addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-go]');
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      if (window.Hub) Hub.show(a.dataset.go);
    });
    var explore = $('hm-explore');
    // hero cta = react bits' SpecularButton (same props as their example)
    if (explore && window.UmbraSpecular) {
      UmbraSpecular.enhance(explore, { radius: 18, lineColor: '#ffffff', baseColor: '#525252', intensity: 1, shineSize: 10, shineFade: 40, thickness: 1, speed: 0.35, followMouse: true, proximity: 250, autoAnimate: false });
    }
    if (explore) explore.addEventListener('click', function (e) {
      e.preventDefault();
      skip();
      var tools = $('hm-tools');
      if (tools) tools.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
    hero.addEventListener('click', function (e) { if (!e.target.closest('a')) skip(); });
    document.addEventListener('keydown', function (e) {
      if (running && window.Hub && Hub.isActive('home') && /^(Escape|Enter| )$/.test(e.key)) skip();
    });

    // leaving mid-animation → land on the final line next time
    document.addEventListener('hub:show', function (e) {
      var tool = e.detail && e.detail.tool;
      if (tool === 'home') { if (!running && !seen()) start(); }
      else if (running) skip();
    });

    // about to play → keep the nav out of sight from the very first frame
    if (window.Hub && Hub.isActive('home') && !seen() && !reduce) {
      document.body.classList.add('nav-hidden');
      hero.classList.add('is-typing');
      setText('');
    }

    // wait for the boot splash to lift before typing (setTimeout: rAF stalls in background tabs)
    (function whenReady(n) {
      if (document.body.classList.contains('ready') || n > 60) start();
      else setTimeout(function () { whenReady(n + 1); }, 100);
    })(0);
  }

  /* ---------- "what's inside" demos ----------
     css runs the looping bits; js drives the ones that change content.
     a card only animates while it is on screen (.is-live). */
  function initDemos() {
    var cards = document.querySelectorAll('#tool-home .hm-bento .hm-card');
    if (!cards.length) return;
    var live = function (el) { return el && el.classList.contains('is-live') && !document.hidden; };

    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) { e.target.classList.toggle('is-live', e.isIntersecting); });
      }, { threshold: 0.25 });
      Array.prototype.forEach.call(cards, function (c) { io.observe(c); });
    } else {
      Array.prototype.forEach.call(cards, function (c) { c.classList.add('is-live'); });
    }
    initFlow(); initStats(); initEnd();
    // the update icon demo shows the tool's real hourglass glyph (even with reduced motion)
    var hgImg = $('bx-hg-img');
    if (hgImg && window.__HOURGLASS_DATAURI) hgImg.src = window.__HOURGLASS_DATAURI;
    Array.prototype.forEach.call(document.querySelectorAll('#tool-home .fs-hg'), function (im) { if (window.__HOURGLASS_DATAURI) im.src = window.__HOURGLASS_DATAURI; });
    if (reduce) return;

    // 1 · update icon: the tool's real hourglass glyph + countdown cycling
    var count = document.querySelector('#tool-home .bx-count');
    if (count) {
      var steps = count.getAttribute('data-cycle').split('|'), ci = 0;
      setInterval(function () {
        if (!live(count.closest('.hm-card'))) return;
        count.classList.add('is-swap');
        setTimeout(function () {
          ci = (ci + 1) % steps.length;
          count.textContent = steps[ci];
          count.classList.remove('is-swap');
        }, 250);
      }, 1800);
    }

    // 2 · mosaic: shuffle the tiles, FLIP-animate them into their new spots
    var grid = document.querySelector('#tool-home .bx-mosaic');
    if (grid) {
      setInterval(function () {
        if (!live(grid.closest('.hm-card'))) return;
        var tiles = Array.prototype.slice.call(grid.children);
        var first = tiles.map(function (t) { return t.getBoundingClientRect(); });   // F: where they are
        var order = tiles.slice();
        for (var i = order.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
        }
        order.forEach(function (t) { grid.appendChild(t); });                          // L: new layout
        tiles.forEach(function (t, k) {                                                // I + P
          var last = t.getBoundingClientRect();
          var dx = first[k].left - last.left, dy = first[k].top - last.top;
          if (!dx && !dy) return;
          t.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }],
            { duration: 650, easing: 'cubic-bezier(.65,0,.35,1)' });
        });
      }, 2200);
    }

    // 3 · rocalc: cycle amounts, numbers roll to the new value
    var rIn = document.querySelector('#tool-home .bx-rc-in'),
        rTax = document.querySelector('#tool-home .bx-rc-tax'),
        rUsd = document.querySelector('#tool-home .bx-rc-usd');
    if (rIn && rTax && rUsd) {
      var amounts = [1000, 2500, 400, 10000], ai = 0, shown = 1000;
      var fmt = function (n) { return Math.round(n).toLocaleString('en-US'); };
      setInterval(function () {
        if (!live(rIn.closest('.hm-card'))) return;
        ai = (ai + 1) % amounts.length;
        var from = shown, to = amounts[ai], t0 = performance.now();
        (function tick() {
          var u = Math.min(1, (performance.now() - t0) / 700), e = 1 - Math.pow(1 - u, 3);
          var v = from + (to - from) * e;
          rIn.textContent = fmt(v);
          rTax.textContent = fmt(v * 0.7);
          rUsd.textContent = '$' + (v * 0.7 * 0.0035).toFixed(2);
          if (u < 1) setTimeout(tick, 16); else shown = to;
        })();
      }, 2600);
    }
  }

  /* ---------- from studio to front page: rail fills + steps light up with scroll ---------- */
  function initFlow() {
    var sec = $('hm-flow');
    if (!sec) return;
    var track = sec.querySelector('.hm-flow-track');
    var steps = sec.querySelectorAll('.hm-step');
    function update() {
      if (!window.Hub || !Hub.isActive('home')) return;
      var r = track.getBoundingClientRect(), vh = window.innerHeight || 800;
      var p = reduce ? 1 : Math.max(0, Math.min(1, (vh * 0.88 - r.top) / (vh * 0.5)));
      track.style.setProperty('--p', p.toFixed(3));
      Array.prototype.forEach.call(steps, function (s, i) { s.classList.toggle('is-on', p >= i / steps.length + 0.02 || p >= 0.999); });
    }
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; update(); });
    }, { passive: true });
    window.addEventListener('resize', update);
    document.addEventListener('hub:show', update);
    update();
  }

  /* ---------- numbers count up once when they scroll in ---------- */
  function initStats() {
    var sec = $('hm-stats');
    if (!sec || !('IntersectionObserver' in window)) return;
    var done = false;
    var io = new IntersectionObserver(function (es) {
      if (done || !es[0].isIntersecting) return;
      done = true; io.disconnect();
      Array.prototype.forEach.call(sec.querySelectorAll('[data-count]'), function (b) {
        var to = +b.getAttribute('data-count'), suf = b.getAttribute('data-suffix') || '', t0 = performance.now();
        var unit = b.getAttribute('data-unit');
        var show = function (n) { if (unit) b.innerHTML = n + ' <small>' + unit + '</small>'; else b.textContent = n + suf; };
        if (reduce || !to) { show(to); return; }
        (function tick() {
          var u = Math.min(1, (performance.now() - t0) / 1100), e = 1 - Math.pow(1 - u, 3);
          show(Math.round(to * e));
          if (u < 1) setTimeout(tick, 16);
        })();
      });
    }, { threshold: 0.5 });
    io.observe(sec);
  }

  /* ---------- final cta: strike "stop wasting time.", then the line lands ---------- */
  function initEnd() {
    var sec = $('hm-end'), btn = $('hm-end-btn');
    if (btn && window.UmbraSpecular) {
      UmbraSpecular.enhance(btn, { radius: 18, lineColor: '#ffffff', baseColor: '#525252', intensity: 1, shineSize: 10, shineFade: 40, thickness: 1, speed: 0.35, followMouse: true, proximity: 250, autoAnimate: false });
    }
    if (btn) btn.addEventListener('click', function (e) {
      e.preventDefault();
      var tools = $('hm-tools');
      if (tools) tools.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
    if (!sec) return;
    if (reduce || !('IntersectionObserver' in window)) { sec.classList.add('is-on'); return; }
    var io = new IntersectionObserver(function (es) {
      if (es[0].isIntersecting) { sec.classList.add('is-on'); io.disconnect(); }
    }, { threshold: 0.45 });
    io.observe(sec);
  }

  function boot() { init(); initDemos(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
