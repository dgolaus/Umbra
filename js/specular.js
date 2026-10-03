/* =========================================================================
   UMBRA SPECULAR — vanilla WebGL2 port of React Bits' <SpecularButton />
   (same shader; OGL replaced by raw GL). A thin edge stroke plus a specular
   streak that turns toward the cursor and fades in as it gets close.
   window.UmbraSpecular.enhance(el, opts) → { destroy }
   el gets .specular-button; opts mirror the component props.
   ========================================================================= */
(function () {
  'use strict';

  var PAD = 20;
  var VERT = '#version 300 es\nin vec2 position;\nvoid main(){ gl_Position = vec4(position, 0.0, 1.0); }';
  var FRAG = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec2 uCenter;',
    'uniform vec2 uHalfSize;',
    'uniform float uRadius;',
    'uniform float uAngle;',
    'uniform float uPx;',
    'uniform vec3 uLineColor;',
    'uniform vec3 uBaseColor;',
    'uniform float uIntensity;',
    'uniform float uShineSize;',
    'uniform float uShineFade;',
    'uniform float uThickness;',
    'uniform float uBaseWidth;',
    'out vec4 fragColor;',
    'float sdRoundedRect(vec2 p, vec2 b, float r) {',
    '  vec2 q = abs(p) - b + r;',
    '  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;',
    '}',
    'float gaussianLine(float d, float sigma) {',
    '  float x = d / (sigma + 1e-6);',
    '  float k = mix(1.0, 1.6, smoothstep(0.0, 1.5, x));',
    '  return exp(-k * x * x);',
    '}',
    'void main() {',
    '  vec2 p = gl_FragCoord.xy - uCenter;',
    '  float d = sdRoundedRect(p, uHalfSize, uRadius);',
    '  vec2 L = vec2(cos(uAngle), sin(uAngle));',
    '  float base = (1.0 - smoothstep(0.0, uBaseWidth, abs(d))) * 0.45;',
    '  vec2 nEll = normalize(p / (uHalfSize * uHalfSize) + 1e-6);',
    '  float phi = acos(clamp(abs(dot(nEll, L)), 0.0, 1.0));',
    '  float rim = 1.0 - smoothstep(uShineSize - uShineFade, uShineSize + uShineFade + 1e-4, phi);',
    '  float line = gaussianLine(d, uThickness);',
    '  float edgeClamp = 1.0 - smoothstep(0.5 * uPx, 3.0 * uPx, abs(d));',
    '  float hi = line * rim * edgeClamp * uIntensity;',
    '  vec3 col = uBaseColor * base + uLineColor * hi;',
    '  float a = clamp(base + hi, 0.0, 1.0);',
    '  fragColor = vec4(col, a);',
    '}'
  ].join('\n');

  function rgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1];
  }
  function sh(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function enhance(btn, o) {
    o = o || {};
    var P = {
      radius: o.radius == null ? 18 : o.radius,
      lineColor: rgb(o.lineColor || '#ffffff'),
      baseColor: rgb(o.baseColor || '#525252'),
      intensity: o.intensity == null ? 1 : o.intensity,
      shineSize: o.shineSize == null ? 10 : o.shineSize,
      shineFade: o.shineFade == null ? 40 : o.shineFade,
      thickness: o.thickness == null ? 1 : o.thickness,
      speed: o.speed == null ? 0.35 : o.speed,
      followMouse: o.followMouse !== false,
      proximity: o.proximity == null ? 250 : o.proximity,
      autoAnimate: !!o.autoAnimate
    };
    btn.classList.add('specular-button');
    btn.style.setProperty('--sb-radius', P.radius + 'px');

    var fx = document.createElement('span');
    fx.className = 'specular-button__fx';
    fx.setAttribute('aria-hidden', 'true');
    var label = document.createElement('span');
    label.className = 'specular-button__label';
    while (btn.firstChild) label.appendChild(btn.firstChild);
    btn.appendChild(fx);
    btn.appendChild(label);

    var canvas = document.createElement('canvas');
    var gl = null;
    try { gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true }); } catch (e) {}
    if (!gl) { btn.classList.add('specular-button--nogl'); return { destroy: function () {} }; }   // css fallback border
    fx.appendChild(canvas);

    var prog = gl.createProgram();
    try {
      gl.attachShader(prog, sh(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { fx.removeChild(canvas); btn.classList.add('specular-button--nogl'); return { destroy: function () {} }; }
    gl.useProgram(prog);
    var vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    var U = {};
    ['uCenter', 'uHalfSize', 'uRadius', 'uAngle', 'uPx', 'uLineColor', 'uBaseColor', 'uIntensity', 'uShineSize',
      'uShineFade', 'uThickness', 'uBaseWidth'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });

    var dpr = window.devicePixelRatio || 1, W = 1, H = 1;
    gl.uniform1f(U.uPx, dpr);
    gl.uniform1f(U.uBaseWidth, dpr);
    gl.uniform3fv(U.uLineColor, P.lineColor);
    gl.uniform3fv(U.uBaseColor, P.baseColor);
    gl.uniform1f(U.uShineSize, P.shineSize * Math.PI / 180);
    gl.uniform1f(U.uShineFade, P.shineFade * Math.PI / 180);
    gl.uniform1f(U.uThickness, P.thickness * dpr);

    function resize() {
      // fractional size + explicit centre keep the sdf pinned to the css border
      var r = btn.getBoundingClientRect();
      if (!r.width || !r.height) return;
      dpr = window.devicePixelRatio || 1;
      W = r.width; H = r.height;
      canvas.width = Math.round((W + PAD * 2) * dpr);
      canvas.height = Math.round((H + PAD * 2) * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(U.uPx, dpr);
      gl.uniform1f(U.uBaseWidth, dpr);
      gl.uniform1f(U.uThickness, P.thickness * dpr);
      gl.uniform2f(U.uCenter, (PAD + W / 2) * dpr, (PAD + H / 2) * dpr);
      gl.uniform2f(U.uHalfSize, (W / 2) * dpr, (H / 2) * dpr);
      gl.uniform1f(U.uRadius, Math.min(P.radius, Math.min(W, H) / 2) * dpr);
      kick();
    }
    var ro = new ResizeObserver(resize);
    ro.observe(btn);

    // light steers toward the pointer anywhere on the page; fades in with proximity
    var pointerAngle = null, proximityT = 0;
    function onMove(e) {
      var r = btn.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
      var dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
      var dist = Math.hypot(dx, dy);
      if (dist === 0) {
        var nx = (e.clientX - cx) / (r.width / 2), ny = (cy - e.clientY) / (r.height / 2);
        pointerAngle = Math.atan2(2 / r.height, -2 / r.width) + nx * 0.3 + ny * 0.15;
      } else {
        pointerAngle = Math.atan2(cy - e.clientY, e.clientX - cx);
      }
      var t = Math.max(0, 1 - dist / Math.max(P.proximity, 1));
      proximityT = t * t * (3 - 2 * t);
      kick();
    }
    window.addEventListener('pointermove', onMove, { passive: true });

    var angle = 2.4, idle = 2.4, bright = 0, last = performance.now(), raf = 0, visible = true;
    function frame(now) {
      raf = 0;
      var dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      idle += P.speed * dt;
      var steer = P.followMouse && pointerAngle != null && (!P.autoAnimate || proximityT > 0);
      var target = steer ? pointerAngle : idle;
      var diff = ((target - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      angle += diff * (1 - Math.exp(-dt * 7));
      var bT = P.autoAnimate ? 1 : proximityT;
      bright += (bT - bright) * (1 - Math.exp(-dt * 8));
      gl.uniform1f(U.uAngle, angle);
      gl.uniform1f(U.uIntensity, P.intensity * bright);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // keep going while something is still moving; idle otherwise (saves the gpu)
      var settling = Math.abs(diff) > 0.002 || Math.abs(bT - bright) > 0.002 || (P.autoAnimate && bright > 0.001) || (!steer && bright > 0.001);
      if (settling && visible && !document.hidden) raf = requestAnimationFrame(frame);
    }
    function kick() {
      if (raf || !visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    var io = new IntersectionObserver(function (es) { visible = es[0].isIntersecting; if (visible) kick(); });
    io.observe(btn);
    function onVis() { if (!document.hidden) kick(); }
    document.addEventListener('visibilitychange', onVis);
    resize();

    return {
      destroy: function () {
        cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
        window.removeEventListener('pointermove', onMove);
        document.removeEventListener('visibilitychange', onVis);
        try { fx.removeChild(canvas); } catch (e) {}
        var ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
      }
    };
  }

  window.UmbraSpecular = { enhance: enhance };
})();
