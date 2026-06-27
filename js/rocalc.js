/* =========================================================================
   TOOL 3 · ROCALC — Robux calculator suite
   Ported from dgolaus/RoCalc, wrapped in an IIFE so its top-level globals
   (state, $, toast, parseNumber, constants, …) don't leak into the hub or
   collide with the other tools. Logic is unchanged except one try/catch
   guard on the boot-time hash deep-link (the hub uses #tool-style hashes).
   All features preserved: tax · gamepass · devex · black market · live
   USD→BRL with fallback + manual override · precision mode · localStorage.
   ========================================================================= */
(function () {
/* =========================================================
   Robux Calculator Suite — script
   Vanilla JS, zero deps. Reads constants below for rates.

   Sections:
     1. Constants (UPDATE WHEN OFFICIAL VALUES CHANGE)
     2. State
     3. Parse / format helpers
     4. Calc: tax · devex · blackmarket
     5. Live USD→BRL fetch
     6. Animation: counter + last-value cache
     7. Storage helpers
     8. UI wiring: tax · devex · blackmarket · copy · stats
     9. Mouse glow + 3D tilt
    10. Boot
   ========================================================= */

'use strict';


/* ---------- 1. Constants — verificadas em 2026-05-09 ---------- */

/* Roblox marketplace fee — 30% (criador recebe 70%).
   Aplica-se a game passes, dev products e classic clothing.
   Fonte: create.roblox.com/docs/marketplace/marketplace-fees-and-commissions
   (Itens 3D avatar usam revenue share progressivo 30%→70% — não modelado aqui.) */
const FEE_RATE       = 0.30;
const CREATOR_SHARE  = 1 - FEE_RATE;

/* DevEx — taxa nova vigente desde 2025-09-05 (10am PT).
   Robux ganhos antes saem na taxa antiga ($0.0035). 100k Robux = $380.
   Fonte: en.help.roblox.com/hc/en-us/articles/27984458742676 */
const DEVEX_RATE_USD_PER_ROBUX     = 0.0038;
const DEVEX_RATE_OLD_USD_PER_ROBUX = 0.0035;

/* Mínimo para pedido DevEx (1 envio por mês).
   Fonte: Roblox Help (mesma URL acima). */
const DEVEX_MIN_ROBUX = 30000;

/* Cotação USD→BRL — usado como fallback se a API falhar.
   Última verificação: 2026-05-09 via open.er-api.com. */
const USD_BRL_FALLBACK = 4.92;

/* API gratuita, sem auth, JSON, atualização horária. */
const USD_BRL_API       = 'https://open.er-api.com/v6/latest/USD';
const FETCH_TIMEOUT_MS  = 5000;
const REFETCH_INTERVAL_MS = 30 * 60 * 1000;  // 30 min — auto-refresh em background
const VISIBILITY_REFETCH_AGE_MS = 5 * 60 * 1000;  // 5 min — refetch ao voltar pra aba

/* Chaves localStorage. */
const STORAGE = {
  rateOverride: 'rcs.usd_brl_override',
  liveRate:     'rcs.usd_brl_live',
  precision:    'rcs.precision',
  bmBrl:        'rcs.bm_brl_per_1k',
  bmUsd:        'rcs.bm_usd_per_1k',
};


/* ---------- 2. State ---------- */

const state = {
  usdBrl:           USD_BRL_FALLBACK,  // valor efetivo (override > live > fallback)
  usdBrlLive:       USD_BRL_FALLBACK,
  usdBrlOverride:   null,              // se !== null, override manual
  lastFetchTs:      null,              // timestamp do último fetch live bem-sucedido
  fetchFailedShown: false,             // flag pra evitar spam de toast em falhas seguidas
  precision:        false,
  reduceMotion:     window.matchMedia('(prefers-reduced-motion: reduce)').matches,
};

/* Refs cruzados — preenchidos no setup; chamados ao trocar a taxa. */
let refreshDevex      = () => {};
let refreshBlackmarket = () => {};


/* ---------- 3. Parse / format helpers ---------- */

/* Parser robusto que aceita formatos BR e US:
     "50000"      → 50000
     "50.000"     → 50000   (BR thousand sep)
     "50,000"     → 50000   (US thousand sep)
     "1.000.000"  → 1000000
     "1,000,000"  → 1000000
     "50,5"       → 50.5    (BR decimal)
     "50.5"       → 50.5    (US decimal)
     "1.000,50"   → 1000.50 (BR completo)
     "1,000.50"   → 1000.50 (US completo)
   Regra: separador único com 3 dígitos depois → milhar; senão → decimal.
*/
function parseNumber(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  s = s.replace(/[^\d.,-]/g, '');
  if (!s || s === '-' || s === '.' || s === ',') return NaN;

  const dotCount   = (s.match(/\./g) || []).length;
  const commaCount = (s.match(/,/g)  || []).length;

  if (dotCount === 0 && commaCount === 0) return Number(s);

  if (dotCount > 0 && commaCount === 0) {
    if (dotCount > 1) return Number(s.replace(/\./g, ''));
    const after = s.split('.')[1] || '';
    /* 3+ dígitos após o separador único → thousand-sep (BR).
       1-2 dígitos → decimal. Isso evita confundir estados intermediários
       de digitação tipo "1.0000" (que o formatter logo vira "10.000"). */
    if (after.length >= 3) return Number(s.replace(/\./g, ''));
    return Number(s);
  }
  if (commaCount > 0 && dotCount === 0) {
    if (commaCount > 1) return Number(s.replace(/,/g, ''));
    const after = s.split(',')[1] || '';
    if (after.length >= 3) return Number(s.replace(/,/g, ''));
    return Number(s.replace(',', '.'));
  }

  /* Mistos — o último separador é o decimal. */
  const lastDot   = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const decPos = Math.max(lastDot, lastComma);
  const intPart = s.slice(0, decPos).replace(/[.,]/g, '');
  const decPart = s.slice(decPos + 1).replace(/[.,]/g, '');
  return Number(intPart + '.' + decPart);
}

const fmtRobux = (n, dec = 0) => {
  if (!isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
};

const fmtUSD = (n, precision = false) => {
  if (!isFinite(n)) return '—';
  const dec = precision ? 4 : 2;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
};

const fmtBRL = (n, precision = false) => {
  if (!isFinite(n)) return '—';
  const dec = precision ? 4 : 2;
  return n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
};

const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;

/* Formata timestamp como "HH:MM" se for hoje, senão "DD/MM HH:MM". */
function formatTimestamp(ts) {
  if (!ts || !isFinite(ts)) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mo} ${hh}:${mm}`;
}

/* Formata número simples para usar dentro de input (sem símbolo de moeda). */
const fmtPlain = (n, dec = 2) => {
  if (!isFinite(n)) return '';
  return n.toLocaleString('pt-BR', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
};


/* ---------- 4. Calc ---------- */

function calcTaxFromGross(gross) {
  return { gross, net: gross * CREATOR_SHARE, fee: gross * FEE_RATE };
}
function calcTaxFromNet(net) {
  const gross = net / CREATOR_SHARE;
  return { gross, net, fee: gross - net };
}

function devexFromRobux(robux, usdBrlRate, devexRate = DEVEX_RATE_USD_PER_ROBUX) {
  const usd = robux * devexRate;
  return { robux, usd, brl: usd * usdBrlRate };
}
function devexFromUSD(usd, usdBrlRate, devexRate = DEVEX_RATE_USD_PER_ROBUX) {
  return { robux: usd / devexRate, usd, brl: usd * usdBrlRate };
}
function devexFromBRL(brl, usdBrlRate, devexRate = DEVEX_RATE_USD_PER_ROBUX) {
  const usd = brl / usdBrlRate;
  return { robux: usd / devexRate, usd, brl };
}

function calcBlackmarket(robux, pricePer1k) {
  if (!isFinite(robux) || !isFinite(pricePer1k)) return NaN;
  return (robux / 1000) * pricePer1k;
}

/* Compara o valor paralelo com o que o DevEx oficial pagaria pelos mesmos Robux.
   Retorna { devexValue, devexOther, diffPct } onde:
     - devexValue está na MESMA moeda do paralelo (currency='BRL'|'USD')
     - devexOther está na moeda oposta
     - diffPct = (paralelo - devex) / devex   (positivo se paralelo > devex)
*/
function compareVsDevex(blackmarketValue, robux, currency, usdBrlRate) {
  if (!isFinite(blackmarketValue) || !isFinite(robux) || robux <= 0) return null;
  const usd = robux * DEVEX_RATE_USD_PER_ROBUX;
  const devexValue = currency === 'BRL' ? usd * usdBrlRate : usd;
  const devexOther = currency === 'BRL' ? usd : usd * usdBrlRate;
  if (devexValue <= 0) return null;
  return {
    devexValue,
    devexOther,
    diffPct: (blackmarketValue - devexValue) / devexValue,
  };
}


/* ---------- 5. Live USD→BRL fetch ---------- */

async function fetchUsdBrl() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(USD_BRL_API, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rate = json && json.rates && json.rates.BRL;
    if (typeof rate === 'number' && rate > 0) {
      const ts = Date.now();
      try {
        localStorage.setItem(STORAGE.liveRate, JSON.stringify({ rate, ts }));
      } catch (e) { /* ignore */ }
      return { rate, source: 'live', ts };
    }
    throw new Error('rate not found in response');
  } catch (err) {
    return { rate: USD_BRL_FALLBACK, source: 'fallback', error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/* Fetch + atualiza state + dispara render. Usado tanto no boot inicial
   quanto pelo setInterval de auto-refresh. Toast aparece SÓ na primeira
   falha de uma sequência (não spam se a API ficar fora por horas). */
async function refetchAndUpdate() {
  const result = await fetchUsdBrl();
  if (result.source === 'live') {
    state.usdBrlLive = result.rate;
    state.lastFetchTs = result.ts;
    if (state.usdBrlOverride == null) state.usdBrl = result.rate;
    state.fetchFailedShown = false;
    refreshDevex();
  } else if (!state.fetchFailedShown) {
    toast('live rate offline · using fallback', 'warn');
    state.fetchFailedShown = true;
  }
}


/* ---------- 6. Animated counter ---------- */

const animFrames  = new WeakMap();
const lastValues  = new WeakMap();

function animateCounter(el, from, to, formatFn, duration = 400) {
  if (state.reduceMotion || !isFinite(from)) {
    el.textContent = formatFn(to);
    return;
  }
  const prev = animFrames.get(el);
  if (prev) cancelAnimationFrame(prev);

  const start = performance.now();
  function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const v = from + (to - from) * eased;
    el.textContent = formatFn(v);
    if (t < 1) {
      animFrames.set(el, requestAnimationFrame(tick));
    } else {
      animFrames.delete(el);
    }
  }
  animFrames.set(el, requestAnimationFrame(tick));
}

function setAnimatedValue(el, value, formatFn) {
  if (!el) return;
  const prev = lastValues.get(el);
  if (!isFinite(value)) {
    el.textContent = '—';
    lastValues.set(el, NaN);
    return;
  }
  if (prev === value) {
    el.textContent = formatFn(value);
    return;
  }
  const fromVal = isFinite(prev) ? prev : value;
  animateCounter(el, fromVal, value, formatFn);
  lastValues.set(el, value);
}


/* ---------- 7. Storage helpers ---------- */

function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
}
function lsDel(key) {
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}


/* ---------- 8. UI wiring ---------- */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* Toast — type: 'success' (default) | 'warn' */
let toastTimer;
function toast(msg, type) {
  const el = $('[data-toast]');
  if (!el) return;
  el.textContent = msg;
  el.dataset.type = type || 'success';
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  const duration = type === 'warn' ? 2800 : 1500;
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), duration);
}

/* ---- Tax ---- */
function setupTax() {
  const grossEl = $('#tax-gross');
  const netEl   = $('#tax-net');
  const feeEl   = $('[data-tax-fee]');
  const rateEl  = $('[data-tax-rate]');

  function clear() {
    grossEl.value = '';
    netEl.value   = '';
    setAnimatedValue(feeEl, 0, (n) => `${fmtRobux(Math.round(n))} Robux`);
  }

  function fromGross() {
    const g = parseNumber(grossEl.value);
    if (!isFinite(g)) {
      netEl.value = '';
      setAnimatedValue(feeEl, 0, (n) => `${fmtRobux(Math.round(n))} Robux`);
      return;
    }
    const r = calcTaxFromGross(g);
    netEl.value = fmtRobux(Math.round(r.net));
    setAnimatedValue(feeEl, r.fee, (n) => `${fmtRobux(Math.round(n))} Robux`);
  }

  function fromNet() {
    const n = parseNumber(netEl.value);
    if (!isFinite(n)) {
      grossEl.value = '';
      setAnimatedValue(feeEl, 0, (m) => `${fmtRobux(Math.round(m))} Robux`);
      return;
    }
    const r = calcTaxFromNet(n);
    grossEl.value = fmtRobux(Math.round(r.gross));
    setAnimatedValue(feeEl, r.fee, (m) => `${fmtRobux(Math.round(m))} Robux`);
  }

  grossEl.addEventListener('input', fromGross);
  netEl.addEventListener('input',   fromNet);

  $$('[data-preset="tax"]').forEach(btn => {
    btn.addEventListener('click', () => {
      grossEl.value = fmtRobux(Number(btn.dataset.value));
      grossEl.focus();
      fromGross();
      flashInput(grossEl);
    });
  });

  $('[data-clear="tax"]').addEventListener('click', () => {
    clear();
    grossEl.focus();
  });

  rateEl.textContent = fmtPct(FEE_RATE);
  clear();
}

/* ---- DevEx ---- */
function setupDevex() {
  const robuxEl     = $('#dx-robux');
  const usdEl       = $('#dx-usd');
  const brlEl       = $('#dx-brl');
  const rateEl      = $('#dx-rate');
  const rateDisplay = $('[data-rate-display]');
  const warnEl      = $('[data-devex-warn]');
  const precision   = $('#precision-toggle');

  let lastEdited = null;  // 'robux' | 'usd' | 'brl' | null
  let rateTimer  = null;

  function effectiveRate() {
    return state.usdBrlOverride != null ? state.usdBrlOverride : state.usdBrlLive;
  }

  function refresh() {
    const rate = effectiveRate();
    state.usdBrl = rate;

    /* Stats strip */
    const statEl = $('[data-stat="usdbrl"]');
    setAnimatedValue(statEl, rate, (n) => fmtBRL(n));

    /* Rate display + placeholder */
    if (state.usdBrlOverride != null) {
      rateDisplay.textContent = `manual · ${fmtBRL(rate)}`;
    } else if (state.lastFetchTs) {
      rateDisplay.textContent = `${fmtBRL(rate)} · updated ${formatTimestamp(state.lastFetchTs)}`;
    } else {
      rateDisplay.textContent = `${fmtBRL(rate)} · using fallback`;
    }
    rateEl.placeholder = rate.toFixed(state.precision ? 4 : 2).replace('.', ',');

    /* Re-derive os outros campos a partir do último editado. */
    const robux = parseNumber(robuxEl.value);
    const usd   = parseNumber(usdEl.value);
    const brl   = parseNumber(brlEl.value);
    let result  = null;

    if (lastEdited === 'robux') {
      if (isFinite(robux)) {
        result = devexFromRobux(robux, rate);
        usdEl.value = fmtPlain(result.usd, state.precision ? 4 : 2);
        brlEl.value = fmtPlain(result.brl, state.precision ? 4 : 2);
      } else {
        usdEl.value = '';
        brlEl.value = '';
      }
    } else if (lastEdited === 'usd') {
      if (isFinite(usd)) {
        result = devexFromUSD(usd, rate);
        robuxEl.value = fmtPlain(result.robux, state.precision ? 2 : 0);
        brlEl.value   = fmtPlain(result.brl,   state.precision ? 4 : 2);
      } else {
        robuxEl.value = '';
        brlEl.value   = '';
      }
    } else if (lastEdited === 'brl') {
      if (isFinite(brl)) {
        result = devexFromBRL(brl, rate);
        robuxEl.value = fmtPlain(result.robux, state.precision ? 2 : 0);
        usdEl.value   = fmtPlain(result.usd,   state.precision ? 4 : 2);
      } else {
        robuxEl.value = '';
        usdEl.value   = '';
      }
    }

    /* Warn mínimo */
    const r = result ? result.robux : NaN;
    if (isFinite(r) && r > 0 && r < DEVEX_MIN_ROBUX) {
      const faltam = DEVEX_MIN_ROBUX - Math.floor(r);
      warnEl.hidden = false;
      warnEl.textContent = `⚠ below the devex minimum (${fmtRobux(DEVEX_MIN_ROBUX)} robux). ${fmtRobux(faltam)} to go.`;
    } else {
      warnEl.hidden = true;
    }

    /* Cascata para blackmarket — comparativo depende da taxa */
    refreshBlackmarket();
  }
  refreshDevex = refresh;

  robuxEl.addEventListener('input', () => { lastEdited = 'robux'; refresh(); });
  usdEl.addEventListener('input',   () => { lastEdited = 'usd';   refresh(); });
  brlEl.addEventListener('input',   () => { lastEdited = 'brl';   refresh(); });

  /* Override manual da taxa, debounce 100ms. */
  rateEl.addEventListener('input', () => {
    clearTimeout(rateTimer);
    rateTimer = setTimeout(() => {
      const v = parseNumber(rateEl.value);
      if (isFinite(v) && v > 0) {
        state.usdBrlOverride = v;
        lsSet(STORAGE.rateOverride, String(v));
      } else {
        state.usdBrlOverride = null;
        lsDel(STORAGE.rateOverride);
      }
      refresh();
    }, 100);
  });

  $('[data-action="reset-rate"]').addEventListener('click', () => {
    state.usdBrlOverride = null;
    rateEl.value = '';
    lsDel(STORAGE.rateOverride);
    refresh();
  });

  precision.addEventListener('change', () => {
    state.precision = precision.checked;
    lsSet(STORAGE.precision, precision.checked ? '1' : '0');
    refresh();
  });

  $$('[data-preset="devex"]').forEach(btn => {
    btn.addEventListener('click', () => {
      robuxEl.value = fmtRobux(Number(btn.dataset.value));
      lastEdited = 'robux';
      robuxEl.focus();
      refresh();
      flashInput(robuxEl);
    });
  });

  $('[data-clear="devex"]').addEventListener('click', () => {
    robuxEl.value = '';
    usdEl.value   = '';
    brlEl.value   = '';
    lastEdited = null;
    warnEl.hidden = true;
    refresh();
    robuxEl.focus();
  });

  /* Restaurar estado salvo */
  precision.checked = lsGet(STORAGE.precision) === '1';
  state.precision = precision.checked;
  const savedOverride = lsGet(STORAGE.rateOverride);
  if (savedOverride) {
    const v = parseNumber(savedOverride);
    if (isFinite(v) && v > 0) {
      state.usdBrlOverride = v;
      rateEl.value = fmtPlain(v, state.precision ? 4 : 2);
    }
  }

  refresh();
}

/* ---- Black Market ----
   Bidirecional: edita robux → calcula valor; edita valor → calcula robux.
   Ambos compartilham o mesmo "preço por 1k". lastEdited define qual é a
   fonte e qual é derivado quando o preço muda. */
function setupBlackmarket() {
  const brlPrice = $('#bm-brl-price');
  const brlRobux = $('#bm-brl-robux');
  const brlValue = $('#bm-brl-value');
  const brlComp  = $('[data-compare-brl]');
  const brlEquiv = $('[data-devex-equiv-brl]');
  const brlDiff  = $('[data-diff-brl]');

  const usdPrice = $('#bm-usd-price');
  const usdRobux = $('#bm-usd-robux');
  const usdValue = $('#bm-usd-value');
  const usdComp  = $('[data-compare-usd]');
  const usdEquiv = $('[data-devex-equiv-usd]');
  const usdDiff  = $('[data-diff-usd]');

  let lastEditedBrl = 'robux';
  let lastEditedUsd = 'robux';

  function renderOne(opts) {
    const price    = parseNumber(opts.priceEl.value);
    const robuxRaw = parseNumber(opts.robuxEl.value);
    const valueRaw = parseNumber(opts.valueEl.value);

    let robux = NaN;
    let value = NaN;

    if (opts.lastEdited === 'value') {
      value = valueRaw;
      if (isFinite(value) && isFinite(price) && price > 0) {
        robux = (value / price) * 1000;
        opts.robuxEl.value = fmtRobux(Math.round(robux));
      } else {
        opts.robuxEl.value = '';
      }
    } else {
      robux = robuxRaw;
      if (isFinite(robux) && isFinite(price) && price > 0) {
        value = (robux / 1000) * price;
        opts.valueEl.value = fmtPlain(value, 2);
      } else {
        opts.valueEl.value = '';
      }
    }

    /* Esconde comparativo se algum lado estiver vazio/inválido. */
    if (!isFinite(price) || !isFinite(robux) || !isFinite(value) || robux <= 0 || value <= 0 || price <= 0) {
      opts.compEl.hidden = true;
      return;
    }

    const cmp = compareVsDevex(value, robux, opts.currency, state.usdBrl);
    if (!cmp) { opts.compEl.hidden = true; return; }

    opts.compEl.hidden = false;
    opts.equivEl.textContent = `${opts.fmt(cmp.devexValue)} (${opts.fmtOther(cmp.devexOther)})`;

    const sign = cmp.diffPct >= 0 ? '+' : '-';
    const pct  = Math.abs(cmp.diffPct * 100).toFixed(1);
    opts.diffEl.textContent = ` · diferença: ${sign}${pct}% vs paralelo`;
    opts.diffEl.classList.toggle('positive', cmp.diffPct > 0);
    opts.diffEl.classList.toggle('negative', cmp.diffPct < 0);
  }

  function renderBRL() {
    renderOne({
      priceEl: brlPrice, robuxEl: brlRobux, valueEl: brlValue,
      compEl:  brlComp,  equivEl: brlEquiv, diffEl: brlDiff,
      lastEdited: lastEditedBrl,
      currency: 'BRL',
      fmt:      (n) => fmtBRL(n),
      fmtOther: (n) => fmtUSD(n),
    });
  }
  function renderUSD() {
    renderOne({
      priceEl: usdPrice, robuxEl: usdRobux, valueEl: usdValue,
      compEl:  usdComp,  equivEl: usdEquiv, diffEl: usdDiff,
      lastEdited: lastEditedUsd,
      currency: 'USD',
      fmt:      (n) => fmtUSD(n),
      fmtOther: (n) => fmtBRL(n),
    });
  }
  function renderAll() { renderBRL(); renderUSD(); }
  refreshBlackmarket = renderAll;

  brlPrice.addEventListener('input', () => { lsSet(STORAGE.bmBrl, brlPrice.value); renderBRL(); });
  brlRobux.addEventListener('input', () => { lastEditedBrl = 'robux'; renderBRL(); });
  brlValue.addEventListener('input', () => { lastEditedBrl = 'value'; renderBRL(); });

  usdPrice.addEventListener('input', () => { lsSet(STORAGE.bmUsd, usdPrice.value); renderUSD(); });
  usdRobux.addEventListener('input', () => { lastEditedUsd = 'robux'; renderUSD(); });
  usdValue.addEventListener('input', () => { lastEditedUsd = 'value'; renderUSD(); });

  $('[data-clear="bm"]').addEventListener('click', () => {
    brlPrice.value = ''; brlRobux.value = ''; brlValue.value = '';
    usdPrice.value = ''; usdRobux.value = ''; usdValue.value = '';
    lsDel(STORAGE.bmBrl);
    lsDel(STORAGE.bmUsd);
    lastEditedBrl = 'robux';
    lastEditedUsd = 'robux';
    renderAll();
  });

  /* Restaurar últimos preços paralelos digitados. */
  const savedBrl = lsGet(STORAGE.bmBrl);
  const savedUsd = lsGet(STORAGE.bmUsd);
  if (savedBrl) brlPrice.value = savedBrl;
  if (savedUsd) usdPrice.value = savedUsd;

  renderAll();
}

/* ---- Gamepass (uni-direcional: input = quanto quer receber) ---- */
function setupGamepass() {
  const target = $('#gp-target');
  const listEl = $('[data-gp-list]');
  const feeEl  = $('[data-gp-fee]');
  if (!target || !listEl || !feeEl) return;

  function fmt(n) {
    if (!isFinite(n) || n <= 0) return '0 robux';
    return Math.round(n).toLocaleString('pt-BR') + ' robux';
  }

  function refresh() {
    const desired = parseNumber(target.value);
    if (!isFinite(desired) || desired <= 0) {
      listEl.textContent = '0 robux';
      feeEl.textContent  = '0 robux';
      return;
    }
    const listPrice = desired / CREATOR_SHARE;
    listEl.textContent = fmt(listPrice);
    feeEl.textContent  = fmt(listPrice - desired);
  }

  target.addEventListener('input', refresh);
  refresh();
}

/* ---- Section pulse — chama atenção pros inputs ao entrar na viewport.
        A primeira seção COM INPUTS a pulsar tem delay de 2.5s (dá tempo
        do usuário se localizar na página). Todas as outras pulsam
        imediatamente ao entrar na viewport. CSS faz a animação via
        @keyframes input-pulse-{green,amber}. */
function setupSectionPulse() {
  if (state.reduceMotion) return;
  if (typeof IntersectionObserver !== 'function') return;

  const sections = $$('.section');
  if (!sections.length) return;

  const seen = new WeakSet();
  const FIRST_DELAY_MS    = 2500;   // delay só pra primeira seção com inputs
  const PULSE_DURATION_MS = 1100;   // tempo que a classe fica ativa (anim 1s + buffer)
  let firstWithInputsDone = false;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting || seen.has(entry.target)) return;
      seen.add(entry.target);
      const section = entry.target;
      const hasInputs = section.querySelector('input') !== null;
      const delay = (hasInputs && !firstWithInputsDone) ? FIRST_DELAY_MS : 0;
      if (hasInputs) firstWithInputsDone = true;
      setTimeout(() => {
        section.classList.add('just-entered');
        setTimeout(() => section.classList.remove('just-entered'), PULSE_DURATION_MS);
      }, delay);
    });
  }, {
    threshold: 0.30,
    rootMargin: '-15% 0px -15% 0px',
  });

  sections.forEach((s) => observer.observe(s));
}

/* ---- Nav scroll — smooth scroll + atualiza hash silenciosamente via
        replaceState (assim deep-links com #sec-X funcionam ao recarregar,
        mas o scroll só dispara na navegação explícita por click). */
function setupNavScroll() {
  $$('.nav-item').forEach((link) => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (!href || href.charAt(0) !== '#') return;
      const target = document.querySelector(href);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({
        behavior: state.reduceMotion ? 'auto' : 'smooth',
        block: 'start',
      });
      try { history.replaceState(null, '', href); } catch (err) { /* ignore */ }
    });
  });
}

/* ---- Active nav indicator — destaca o nav-item da seção em vista.
        Observer separado do pulse: usa rootMargin pra criar uma "faixa
        ativa" no topo do viewport. Quando uma seção cruza essa faixa,
        seu nav-item ganha .is-active. */
function setupActiveNav() {
  const navLinks = $$('.nav-item');
  if (!navLinks.length) return;
  if (typeof IntersectionObserver !== 'function') return;

  const map = new Map();
  navLinks.forEach((link) => {
    const id = (link.getAttribute('href') || '').slice(1);
    const section = id ? document.getElementById(id) : null;
    if (section) map.set(section, link);
  });
  if (!map.size) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const link = map.get(entry.target);
      if (!link) return;
      link.classList.toggle('is-active', entry.isIntersecting);
    });
  }, {
    rootMargin: '-30% 0px -60% 0px',
    threshold: 0,
  });

  map.forEach((_, section) => observer.observe(section));
}

/* ---- Share — usa Web Share API se disponível, senão copia URL. */
function setupShareButton() {
  const btn = $('[data-action="share"]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const url   = window.location.href;
    const title = 'robux calculator suite';
    const text  = 'roblox calculator suite — tax, gamepass, devex and black market. all client-side, no dependencies.';
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text, url });
        toast('shared');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; /* usuário cancelou */
        /* outros erros: cai pro clipboard */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('link copied');
    } catch (err) {
      toast('copy failed', 'warn');
    }
  });
}

/* ---- Flash input — pulse rápido num input só, usado em presets. */
function flashInput(el) {
  if (!el || state.reduceMotion) return;
  el.classList.remove('flashing');
  void el.offsetWidth; /* força reflow pra reiniciar animação */
  el.classList.add('flashing');
  setTimeout(() => el.classList.remove('flashing'), 900);
}

/* ---- Copy buttons ---- */
function setupCopy() {
  $$('.copy[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.copy;
      let text = '';
      const byId = document.getElementById(id);
      if (byId && 'value' in byId) {
        text = byId.value || '';
      } else {
        const out = document.querySelector(`[data-${id}]`);
        if (out) text = out.textContent.trim();
      }
      if (!text) { toast('nothing to copy'); return; }
      try {
        await navigator.clipboard.writeText(text);
        const display = text.length > 22 ? text.slice(0, 22) + '…' : text;
        toast(`copied: ${display}`);
      } catch (e) {
        toast('copy failed');
      }
    });
  });
}

/* ---- Stats strip ---- */
function setupStats() {
  $('[data-stat="fee"]').textContent = fmtPct(FEE_RATE);

  /* DevEx · 100k Robux — valor constante derivado das constantes. */
  const devexEl = $('[data-stat="devex"]');
  const devexValue = 100000 * DEVEX_RATE_USD_PER_ROBUX;
  setAnimatedValue(devexEl, devexValue, (n) => fmtUSD(n).replace(/\.00$/, ''));

  /* USD→BRL — atualizado pelo refresh do devex. */
  const usdbrlEl = $('[data-stat="usdbrl"]');
  setAnimatedValue(usdbrlEl, state.usdBrl, (n) => fmtBRL(n));
}

/* ---- Build info ---- */
function setupBuildInfo() {
  const el = $('[data-build-info]');
  if (el) el.textContent = `rates verified 2026-05-09`;
}

/* ---- Numeric-only filter ----
   Remove qualquer caractere que não seja dígito, vírgula ou ponto.
   Atacha em TODOS os campos numéricos (Robux, USD, BRL, taxa, preços).
   Roda antes do formatter e do calc — garante que valores não-numéricos
   nunca entrem no pipeline. Preserva cursor pela contagem de chars
   removidos antes da posição.
*/
function attachNumericFilter(input) {
  input.addEventListener('input', () => {
    const original = input.value;
    if (!/[^\d.,]/.test(original)) return;

    const cursorPos = input.selectionStart != null ? input.selectionStart : original.length;
    const before = original.slice(0, cursorPos);
    const removedBeforeCursor = before.length - before.replace(/[^\d.,]/g, '').length;

    input.value = original.replace(/[^\d.,]/g, '');

    const newCursor = Math.max(0, cursorPos - removedBeforeCursor);
    try {
      input.setSelectionRange(newCursor, newCursor);
    } catch (err) { /* alguns inputs não suportam */ }
  });
}

function setupNumericFilters() {
  const selectors = [
    '#tax-gross', '#tax-net',
    '#dx-robux', '#dx-usd', '#dx-brl', '#dx-rate',
    '#gp-target',
    '#bm-brl-price', '#bm-brl-robux', '#bm-brl-value',
    '#bm-usd-price', '#bm-usd-robux', '#bm-usd-value',
  ];
  selectors.forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) attachNumericFilter(el);
  });
}

/* ---- Robux thousand-separator formatter ----
   Reformata o input enquanto o usuário digita: "1000000" → "1.000.000".

   Detalhes:
   - `beforeinput` captura o valor pré-edição → permite saber se o estado
     anterior tinha parte decimal real (ex.: "267,45") ou só thousand-sep
     (ex.: "1.000"). Sem isso, deletar o último dígito de "1.000" produziria
     "1.00" e seria erroneamente lido como decimal.
   - Cursor é preservado pela posição de DÍGITO (não offset de char) — assim
     reformatar não pula a posição do usuário.
   - Backspace sobre um separador também deleta o dígito anterior, em vez
     de só restaurar o separador (UX comum em inputs mascarados).
   - Aceita parte decimal opcional ",XX" (1-2 dígitos), pra Robux fracionários
     produzidos pelo DevEx em modo precisão.
*/
function attachThousandsFormatter(input) {
  let preEditValue = input.value;

  input.addEventListener('beforeinput', () => {
    preEditValue = input.value;
  });

  input.addEventListener('input', (e) => {
    const cursorPos = input.selectionStart != null ? input.selectionStart : input.value.length;
    const value = input.value;

    if (!value) {
      preEditValue = '';
      return;
    }

    const wasDeletion = e.inputType && e.inputType.indexOf('delete') === 0;

    /* prevHasDecimal: o valor antes da edição tinha parte decimal real?
       Se tinha thousand-sep só (ex.: "1.000"), NÃO conta como decimal. */
    let prevHasDecimal = false;
    if (preEditValue) {
      const pDot = preEditValue.lastIndexOf('.');
      const pComma = preEditValue.lastIndexOf(',');
      const pLast = Math.max(pDot, pComma);
      if (pLast !== -1 && /^\d{1,2}$/.test(preEditValue.slice(pLast + 1))) {
        prevHasDecimal = true;
      }
    }
    const prevDigitCount = (preEditValue.match(/\d/g) || []).length;

    const lastDot   = value.lastIndexOf('.');
    const lastComma = value.lastIndexOf(',');
    const lastSep   = Math.max(lastDot, lastComma);

    /* Em deleção sem decimal anterior, NÃO interpreta separador como decimal —
       mantém modo inteiro (caso "1.000" → backspace → "1.00" continue 100). */
    const allowDecimalInterp = !wasDeletion || prevHasDecimal;

    let intRaw = value;
    let decPart = '';
    let trailingSep = false;

    if (lastSep !== -1 && allowDecimalInterp) {
      const after = value.slice(lastSep + 1);
      if (/^\d{1,2}$/.test(after)) {
        intRaw = value.slice(0, lastSep);
        decPart = after;
      } else if (after === '' && lastSep === value.length - 1) {
        intRaw = value.slice(0, lastSep);
        trailingSep = true;
      }
    }

    let intDigits = intRaw.replace(/\D/g, '');
    let digitsBeforeCursor = value.slice(0, cursorPos).replace(/\D/g, '').length;

    /* Smart backspace: se separador foi deletado (digit count inalterado),
       também remove o dígito imediatamente antes do cursor.
       Mas NÃO dispara quando o valor anterior terminava com separador solto
       (ex.: "267," → backspace deve só remover a vírgula, não o "7"). */
    const prevEndsWithSep = !!preEditValue && /[.,]$/.test(preEditValue);
    const totalDigits = intDigits.length + decPart.length;
    if (e.inputType === 'deleteContentBackward'
        && totalDigits === prevDigitCount
        && digitsBeforeCursor > 0
        && cursorPos <= intRaw.length
        && !prevEndsWithSep) {
      intDigits = intDigits.slice(0, digitsBeforeCursor - 1) + intDigits.slice(digitsBeforeCursor);
      digitsBeforeCursor -= 1;
    }

    /* Formata parte inteira com pontos a cada 3 dígitos. */
    let intFormatted = '';
    if (intDigits) {
      const cleaned = intDigits.replace(/^0+/, '') || '0';
      intFormatted = cleaned.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }

    let formatted;
    if (decPart) {
      formatted = (intFormatted || '0') + ',' + decPart;
    } else if (trailingSep) {
      formatted = (intFormatted || '0') + ',';
    } else {
      formatted = intFormatted;
    }

    if (formatted === value) {
      preEditValue = formatted;
      return;
    }

    input.value = formatted;
    preEditValue = formatted;

    /* Reposiciona o cursor no mesmo dígito-índice. */
    let newCursor = formatted.length;
    if (digitsBeforeCursor === 0) {
      newCursor = 0;
    } else {
      let count = 0;
      for (let i = 0; i < formatted.length; i++) {
        if (/\d/.test(formatted[i])) {
          count++;
          if (count === digitsBeforeCursor) {
            newCursor = i + 1;
            break;
          }
        }
      }
    }
    try {
      input.setSelectionRange(newCursor, newCursor);
    } catch (err) { /* alguns inputs não suportam */ }
  });
}

function setupRobuxFormatters() {
  const selectors = ['#tax-gross', '#tax-net', '#dx-robux', '#gp-target', '#bm-brl-robux', '#bm-usd-robux'];
  selectors.forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) attachThousandsFormatter(el);
  });
}


/* ---------- 9. Boot ---------- */

async function boot() {
  /* Restaurar precision antes de qualquer setup que dependa dela. */
  state.precision = lsGet(STORAGE.precision) === '1';

  /* Carregar último valor live cacheado para render imediato. */
  try {
    const raw = lsGet(STORAGE.liveRate);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.rate === 'number' && parsed.rate > 0) {
        state.usdBrlLive  = parsed.rate;
        state.usdBrl      = parsed.rate;
        state.lastFetchTs = parsed.ts || null;
      }
    }
  } catch (e) { /* ignore */ }

  setupBuildInfo();
  setupStats();
  /* Ordem importa:
     1. NumericFilter PRIMEIRO — bloqueia letras antes de qualquer listener.
     2. RobuxFormatters depois — normaliza thousand-sep nos campos de Robux.
     3. Calculadoras por último — leem valores já saneados e formatados. */
  setupNumericFilters();
  setupRobuxFormatters();
  setupTax();
  setupDevex();
  setupGamepass();
  setupBlackmarket();
  setupCopy();
  setupSectionPulse();
  setupNavScroll();
  setupActiveNav();
  setupShareButton();

  /* Deep-link via hash — se URL tem #sec-X, scrolla pra lá (sem animação,
     pra não ser intrusivo no load). */
  if (window.location.hash) {
    try {
      const target = document.querySelector(window.location.hash);
      if (target) {
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    } catch (e) { /* invalid selector (e.g. #cfg= / #mosaic) — ignore */ }
  }

  /* Tenta atualizar com taxa ao vivo. */
  await refetchAndUpdate();

  /* Auto-refresh em background a cada 30 minutos. */
  setInterval(refetchAndUpdate, REFETCH_INTERVAL_MS);

  /* Se a aba ficou em background por mais de 5 min, refetch ao voltar. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const ts = state.lastFetchTs;
    if (!ts || (Date.now() - ts) > VISIBILITY_REFETCH_AGE_MS) {
      refetchAndUpdate();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
