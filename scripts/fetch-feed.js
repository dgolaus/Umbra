#!/usr/bin/env node
/* =========================================================================
   umbra · fetch-feed
   Builds js/feed.js: a snapshot of roblox's public charts (explore-api sorts)
   enriched with creator, visits, genre, 16:9 thumbnails and square icons.
   Node 18+ (global fetch), zero deps. Run from anywhere:
     node scripts/fetch-feed.js          write js/feed.js
     node scripts/fetch-feed.js --dry    fetch + validate, print a summary, write nothing
   On any failure the existing js/feed.js is left untouched and the exit code is 1.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'js', 'feed.js');
const DRY = process.argv.includes('--dry');

const EXPLORE = 'https://apis.roblox.com/explore-api/v1/get-sorts';
const GAMES = 'https://games.roblox.com/v1/games';
const VOTES = 'https://games.roblox.com/v1/games/votes';
const ICONS = 'https://thumbnails.roblox.com/v1/games/icons';
const THUMBS = 'https://thumbnails.roblox.com/v1/games/multiget/thumbnails';

// per-request id limits (probed: games 50, votes 100, icons 100, multiget 100)
const BATCH = { games: 50, votes: 100, icons: 100, thumbs: 50 };

const MIN_GAMES = 80;
const MAX_BYTES = 150 * 1024;
const TARGET_BYTES = 140 * 1024;
const CAPS = { main: 30, genre: 16 };     // games kept per sort; shrunk while the file is over budget
const MIN_CAPS = { main: 12, genre: 6 };
const SPARE = 8;                          // extra candidates per sort, in case some lack art
const MAX_SORT_PAGES = 12;
const MAX_ATTEMPTS = 7;
const MIN_GAP_MS = 800;                   // games.roblox.com 429s on bursts well below its advertised limit
const TIMEOUT_MS = 20000;

const SKIP_SORTS = ['more-when-you-subscribe'];
const SKIP_MATURITY = ['restricted'];

const HEADERS = {
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'umbra-feed/1 (+https://github.com/dgolaus/Umbra)'
};

// sort id -> natural pt-br name (english comes from the api)
const SORT_PT = {
  'top-trending': 'Em alta',
  'up-and-coming': 'Em ascensão',
  'top-playing-now': 'Mais jogados agora',
  'fun-with-friends': 'Diversão com amigos',
  'top-revisited': 'Mais revisitados',
  'top-earning': 'Maiores faturamentos',
  'top-paid-access': 'Melhores de acesso pago',
  'top-rated': 'Mais bem avaliados',
  'most-popular': 'Mais populares',
  'trending-music-experiences': 'Experiências musicais em alta',
  'learning-and-explore': 'Aprender e explorar',
  'recommended-for-you': 'Recomendados para você'
};

// genre id (roblox untranslated_genre_l1, "_" -> "-") -> [english, pt-br]
const GENRES = {
  'action': ['Action', 'Ação'],
  'adventure': ['Adventure', 'Aventura'],
  'education': ['Education', 'Educação'],
  'entertainment': ['Entertainment', 'Entretenimento'],
  'obby-and-platformer': ['Obby & Platformer', 'Obby e plataforma'],
  'party-and-casual': ['Party & Casual', 'Festa e casual'],
  'puzzle': ['Puzzle', 'Quebra-cabeça'],
  'roleplay-and-avatar-sim': ['Roleplay & Avatar Sim', 'Roleplay e avatar'],
  'rpg': ['RPG', 'RPG'],
  'shooter': ['Shooter', 'Tiro'],
  'shopping': ['Shopping', 'Compras'],
  'simulation': ['Simulation', 'Simulação'],
  'social': ['Social', 'Social'],
  'sports-and-racing': ['Sports & Racing', 'Esportes e corrida'],
  'strategy': ['Strategy', 'Estratégia'],
  'survival': ['Survival', 'Sobrevivência'],
  'utility-and-other': ['Utility & Other', 'Utilitários e outros'],
  'other': ['Other', 'Outros']
};

/* ---------- helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stdout.write('[feed] ' + msg + '\n');

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function slug(s) {
  return clean(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function genreId(raw, display) {
  let id = clean(raw).toLowerCase().replace(/_/g, '-');
  if (!id || id === 'na') id = slug(display);
  return id || 'other';
}

function genreNames(id, display) {
  if (GENRES[id]) return GENRES[id];
  const en = clean(display) || id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return [en, en];
}

function lowerFirst(s) {
  return /^[A-Z]{2,}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function sortPt(id, name, genre) {
  if (SORT_PT[id]) return SORT_PT[id];
  if (genre) return 'Em alta em ' + lowerFirst(genreNames(genre, '')[1]);
  return name;
}

/* ---------- http: paced, retried ---------- */
let lastRequestAt = 0;

async function getJson(url, label) {
  for (let attempt = 1; ; attempt++) {
    const gap = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (gap > 0) await sleep(gap);
    lastRequestAt = Date.now();

    let res = null;
    let problem = '';
    try {
      res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        try { return await res.json(); } catch (e) { problem = 'bad json'; }
      } else {
        problem = 'http ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 160).replace(/\s+/g, ' ');
      }
    } catch (e) {
      problem = 'network ' + (e && e.message ? e.message : e);
    }

    const status = res ? res.status : 0;
    const retryable = !res || res.ok || status === 429 || status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      const err = new Error(label + ' failed: ' + problem);
      err.status = status;
      throw err;
    }
    const retryAfter = res ? Number(res.headers.get('retry-after')) : 0;
    const wait = retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30000, 2000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 400);
    log(label + ': ' + problem + ', retry ' + attempt + '/' + (MAX_ATTEMPTS - 1) + ' in ' + Math.round(wait / 1000) + 's');
    await sleep(wait);
  }
}

/* ---------- explore sorts ---------- */
async function fetchSorts() {
  const sessionId = crypto.randomUUID();
  const raw = [];
  let token = '';
  for (let page = 0; page < MAX_SORT_PAGES; page++) {
    const url = EXPLORE + '?sessionId=' + sessionId + '&device=computer&country=all' +
      (token ? '&sortsPageToken=' + encodeURIComponent(token) : '');
    const data = await getJson(url, 'explore page ' + (page + 1));
    if (Array.isArray(data.sorts)) raw.push.apply(raw, data.sorts);
    token = data.nextSortsPageToken;
    if (!token) break;
  }

  const seen = new Set();
  const sorts = [];
  for (const s of raw) {
    if (!s || s.contentType !== 'Games' || !Array.isArray(s.games)) continue;
    const id = clean(s.sortId);
    if (!id || seen.has(id) || SKIP_SORTS.includes(id)) continue;
    const games = s.games.filter((g) => g && int(g.universeId) > 0 && !g.isSponsored &&
      !SKIP_MATURITY.includes(g.contentMaturity));
    if (!games.length) continue;
    seen.add(id);
    const genre = id.indexOf('trending-in-') === 0 ? id.slice('trending-in-'.length) : null;
    sorts.push({ id, name: clean(s.sortDisplayName) || id, genre, games });
  }
  return sorts;
}

/* ---------- enrichment ---------- */
async function fetchDetails(ids) {
  const map = new Map();
  for (const part of chunk(ids, BATCH.games)) {
    const data = await getJson(GAMES + '?universeIds=' + part.join(','), 'games x' + part.length);
    for (const g of data.data || []) if (g && g.id) map.set(int(g.id), g);
  }
  return map;
}

async function fetchVotes(ids) {
  const map = new Map();
  for (const part of chunk(ids, BATCH.votes)) {
    const data = await getJson(VOTES + '?universeIds=' + part.join(','), 'votes x' + part.length);
    for (const v of data.data || []) if (v && v.id) map.set(int(v.id), { up: int(v.upVotes), down: int(v.downVotes) });
  }
  return map;
}

async function fetchIcons(ids, format) {
  const map = new Map();
  for (const part of chunk(ids, BATCH.icons)) {
    const url = ICONS + '?universeIds=' + part.join(',') +
      '&returnPolicy=PlaceHolder&size=512x512&format=' + format + '&isCircular=false';
    const data = await getJson(url, 'icons x' + part.length);
    for (const t of data.data || []) {
      if (t && t.state === 'Completed' && t.imageUrl) map.set(int(t.targetId), t.imageUrl);
    }
  }
  return map;
}

async function fetchThumbs(ids, format) {
  const map = new Map();
  for (const part of chunk(ids, BATCH.thumbs)) {
    const url = THUMBS + '?universeIds=' + part.join(',') +
      '&countPerUniverse=1&defaults=true&size=768x432&format=' + format + '&isCircular=false';
    const data = await getJson(url, 'thumbs x' + part.length);
    for (const u of data.data || []) {
      const t = u && !u.error && Array.isArray(u.thumbnails) ? u.thumbnails[0] : null;
      if (t && t.state === 'Completed' && t.imageUrl) map.set(int(u.universeId), t.imageUrl);
    }
  }
  return map;
}

// Webp is smaller; fall back to Png if the format is ever rejected or comes back empty
async function fetchArt(ids) {
  let lastError = null;
  for (const format of ['Webp', 'Png']) {
    try {
      const icons = await fetchIcons(ids, format);
      const thumbs = await fetchThumbs(ids, format);
      if (icons.size && thumbs.size) return { icons, thumbs, format };
      lastError = new Error(format + ': no completed images');
    } catch (e) {
      lastError = e;
    }
    log('art as ' + format + ' failed (' + lastError.message + ')');
  }
  throw lastError;
}

/* ---------- assembly ---------- */
function candidateIds(sorts) {
  const ids = [];
  const seen = new Set();
  for (const s of sorts) {
    const cap = (s.genre ? CAPS.genre : CAPS.main) + SPARE;
    for (const g of s.games.slice(0, cap)) {
      const id = int(g.universeId);
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
  }
  return ids;
}

function buildGames(ids, explore, details, votes, art) {
  const games = new Map();
  for (const id of ids) {
    const d = details.get(id);
    const e = explore.get(id) || {};
    const thumb = art.thumbs.get(id);
    const icon = art.icons.get(id);
    if (!d || !thumb || !icon) continue;

    const v = votes.get(id);
    const up = e.totalUpVotes != null ? int(e.totalUpVotes) : (v ? v.up : 0);
    const down = e.totalDownVotes != null ? int(e.totalDownVotes) : (v ? v.down : 0);
    if (up + down <= 0) continue;

    const name = clean(d.name || e.name);
    const placeId = int(d.rootPlaceId || e.rootPlaceId);
    if (!name || !placeId) continue;

    const display = clean(d.genre_l1 || e.genreL1);
    games.set(id, {
      id: id,
      placeId: placeId,
      name: name,
      creator: clean(d.creator && d.creator.name),
      creatorVerified: !!(d.creator && d.creator.hasVerifiedBadge),
      rating: Math.round((up * 100) / (up + down)),
      playing: int(d.playing != null ? d.playing : e.playerCount),
      visits: int(d.visits),
      genre: genreId(d.untranslated_genre_l1, display),
      genreDisplay: display,
      thumb: thumb,
      icon: icon
    });
  }
  return games;
}

function assemble(sorts, games, caps) {
  const outSorts = [];
  const used = new Set();
  for (const s of sorts) {
    const cap = s.genre ? caps.genre : caps.main;
    const gameIds = [];
    for (const g of s.games) {
      const id = int(g.universeId);
      if (games.has(id) && gameIds.indexOf(id) === -1) gameIds.push(id);
      if (gameIds.length >= cap) break;
    }
    if (!gameIds.length) continue;
    gameIds.forEach((id) => used.add(id));
    outSorts.push({ id: s.id, name: s.name, namePt: sortPt(s.id, s.name, s.genre), gameIds: gameIds });
  }

  const ids = Array.from(used).sort((a, b) => a - b);
  const outGames = {};
  const genreDisplay = {};
  for (const id of ids) {
    const g = games.get(id);
    if (!genreDisplay[g.genre]) genreDisplay[g.genre] = g.genreDisplay;
    outGames[String(id)] = {
      id: g.id, placeId: g.placeId, name: g.name, creator: g.creator, creatorVerified: g.creatorVerified,
      rating: g.rating, playing: g.playing, visits: g.visits, genre: g.genre, thumb: g.thumb, icon: g.icon
    };
  }

  const genres = Object.keys(genreDisplay).map((id) => {
    const names = genreNames(id, genreDisplay[id]);
    return { id: id, name: names[0], namePt: names[1] };
  }).sort((a, b) => (a.id === 'other') - (b.id === 'other') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { sorts: outSorts, genres: genres, games: outGames, count: ids.length };
}

/* ---------- output ---------- */
// ascii-only JSON so the file reads the same whatever charset the page assumes
function js(v) {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function render(feed) {
  const lines = [];
  lines.push('/* umbra - roblox charts snapshot for the frontpage tool.');
  lines.push('   generated by scripts/fetch-feed.js (refreshed daily by .github/workflows/update-feed.yml). do not edit by hand. */');
  lines.push('window.__UMBRA_FEED = {');
  lines.push('"version": ' + js(feed.version) + ',');
  lines.push('"generatedAt": ' + js(feed.generatedAt) + ',');
  lines.push('"source": ' + js(feed.source) + ',');
  lines.push('"sorts": [');
  lines.push(feed.sorts.map(js).join(',\n'));
  lines.push('],');
  lines.push('"genres": [');
  lines.push(feed.genres.map(js).join(',\n'));
  lines.push('],');
  lines.push('"games": {');
  lines.push(Object.keys(feed.games).map((k) => js(k) + ': ' + js(feed.games[k])).join(',\n'));
  lines.push('}');
  lines.push('};');
  return lines.join('\n') + '\n';
}

function readExisting() {
  try {
    const src = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    const sandbox = { window: {} };
    vm.runInNewContext(src, sandbox, { timeout: 1000 });
    return { src: src, feed: sandbox.window.__UMBRA_FEED || null };
  } catch (e) {
    return null;
  }
}

function validate(feed, bytes) {
  const problems = [];
  const keys = Object.keys(feed.games);
  if (keys.length < MIN_GAMES) problems.push('only ' + keys.length + ' games (need ' + MIN_GAMES + ')');
  if (!feed.sorts.length) problems.push('no sorts');
  if (!feed.genres.length) problems.push('no genres');
  if (bytes > MAX_BYTES) problems.push('file is ' + bytes + ' bytes (max ' + MAX_BYTES + ')');
  for (const k of keys) {
    const g = feed.games[k];
    if (!/^https:\/\/[^\s"]+$/.test(g.thumb) || !/^https:\/\/[^\s"]+$/.test(g.icon)) { problems.push('bad art url on ' + k); break; }
  }
  for (const s of feed.sorts) {
    if (s.gameIds.some((id) => !feed.games[String(id)])) { problems.push('dangling id in sort ' + s.id); break; }
  }
  return problems;
}

/* ---------- main ---------- */
async function main() {
  const started = Date.now();
  const sorts = await fetchSorts();
  log(sorts.length + ' game sorts: ' + sorts.map((s) => s.id + '(' + s.games.length + ')').join(' '));
  if (!sorts.length) throw new Error('explore-api returned no game sorts');

  const explore = new Map();
  for (const s of sorts) for (const g of s.games) if (!explore.has(int(g.universeId))) explore.set(int(g.universeId), g);

  const ids = candidateIds(sorts);
  log(ids.length + ' candidate games');

  const details = await fetchDetails(ids);
  const missingVotes = ids.filter((id) => {
    const e = explore.get(id);
    return !e || e.totalUpVotes == null || e.totalDownVotes == null;
  });
  const votes = missingVotes.length ? await fetchVotes(missingVotes) : new Map();
  const art = await fetchArt(ids);
  log('details ' + details.size + ', icons ' + art.icons.size + ', thumbs ' + art.thumbs.size + ' (' + art.format + ')');

  const games = buildGames(ids, explore, details, votes, art);

  const caps = { main: CAPS.main, genre: CAPS.genre };
  const existing = readExisting();
  let built, src;
  for (;;) {
    built = assemble(sorts, games, caps);
    src = render({ version: 1, generatedAt: '0000-00-00T00:00:00Z', source: 'roblox-explore-api',
      sorts: built.sorts, genres: built.genres, games: built.games });
    if (Buffer.byteLength(src) <= TARGET_BYTES) break;
    if (caps.main <= MIN_CAPS.main && caps.genre <= MIN_CAPS.genre) break;
    caps.main = Math.max(MIN_CAPS.main, caps.main - 4);
    caps.genre = Math.max(MIN_CAPS.genre, caps.genre - 2);
  }

  const feed = {
    version: 1,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: 'roblox-explore-api',
    sorts: built.sorts,
    genres: built.genres,
    games: built.games
  };

  // unchanged data keeps the old timestamp, so the file produces no diff
  if (existing && existing.feed && typeof existing.feed.generatedAt === 'string') {
    const same = render(Object.assign({}, feed, { generatedAt: existing.feed.generatedAt }));
    if (same === existing.src) feed.generatedAt = existing.feed.generatedAt;
  }

  src = render(feed);
  const bytes = Buffer.byteLength(src);
  const problems = validate(feed, bytes);
  const summary = built.count + ' games, ' + feed.sorts.length + ' sorts, ' + feed.genres.length + ' genres, ' +
    (bytes / 1024).toFixed(1) + ' KB (caps ' + caps.main + '/' + caps.genre + ', ' + art.format + ', ' +
    Math.round((Date.now() - started) / 1000) + 's)';

  if (problems.length) throw new Error('validation failed: ' + problems.join('; ') + ' [' + summary + ']');

  if (DRY) { log('dry run, nothing written: ' + summary); return; }
  if (existing && existing.src === src) { log('unchanged: ' + summary); return; }

  const tmp = OUT + '.tmp';
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(tmp, src);
  fs.renameSync(tmp, OUT);
  log('wrote ' + path.relative(ROOT, OUT).replace(/\\/g, '/') + ': ' + summary);
}

main().catch((e) => {
  process.stderr.write('[feed] ' + (e && e.message ? e.message : e) + '\n[feed] keeping the existing js/feed.js\n');
  process.exit(1);
});
