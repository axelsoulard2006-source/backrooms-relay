// =====================================================================
//  Serveur Backrooms : comptes (sauvegardés dans un dépôt GitHub),
//  salons multijoueur (WebSocket) et, en option, le jeu lui-même.
//  Dépendance unique : ws.   Démarrage : npm start
//
//  Variables d'environnement (Render > Environment) :
//    GITHUB_TOKEN   jeton GitHub (fine-grained, accès "Contents: read & write" au dépôt de données)
//    GITHUB_REPO    ex. "pseudo/backrooms-comptes"   (dépôt PRIVÉ conseillé)
//    GITHUB_BRANCH  ex. "main" (défaut)
//    GITHUB_PATH    ex. "accounts.json" (défaut)
//    AUTH_SECRET    (optionnel) secret de signature des sessions
//    PORT           fourni par Render
//  Sans GITHUB_TOKEN, les comptes sont gardés dans data/accounts.json (local).
// =====================================================================
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const VERSION = 2;
const PORT = process.env.PORT || 8080;
const GH = {
  token: process.env.GITHUB_TOKEN || '',
  repo: process.env.GITHUB_REPO || '',
  branch: process.env.GITHUB_BRANCH || 'main',
  path: process.env.GITHUB_PATH || 'accounts.json',
};
const LOCAL_FILE = path.join(__dirname, 'data', 'accounts.json');
const GAME_DIR = (() => {
  const c = [process.env.GAME_DIR, path.join(__dirname, '..')].filter(Boolean);
  for (const d of c) if (fs.existsSync(path.join(d, 'index.html')) && fs.existsSync(path.join(d, 'js'))) return path.resolve(d);
  return null;
})();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ===================================================================
   STOCKAGE DES COMPTES
   =================================================================== */
const Store = {
  data: { v: 1, secret: '', users: {} },
  sha: null, dirty: false, saving: false, timer: null, mode: 'local', lastError: '', lastSave: 0,

  async load() {
    if (GH.token && GH.repo) {
      this.mode = 'github';
      try {
        const r = await ghGet();
        if (r) { this.data = r.json; this.sha = r.sha; log(`Comptes chargés depuis GitHub (${Object.keys(this.data.users || {}).length})`); }
        else log('Aucun fichier de comptes sur GitHub : il sera créé.');
      } catch (e) {
        this.lastError = String(e.message || e);
        log('ERREUR GitHub au chargement :', this.lastError);
        // on ne démarre pas avec une base vide qui écraserait la vraie : nouvel essai régulier
        this.blocked = true;
        setTimeout(() => this.retryLoad(), 15000);
      }
    } else {
      try { if (fs.existsSync(LOCAL_FILE)) this.data = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')); } catch (e) { log('Fichier local illisible :', e.message); }
      log(`Mode LOCAL (pas de GITHUB_TOKEN) : ${LOCAL_FILE}`);
    }
    this.data.users = this.data.users || {};
    if (!this.data.secret) { this.data.secret = crypto.randomBytes(32).toString('hex'); this.touch(); }
  },
  async retryLoad() {
    try { const r = await ghGet(); if (r) { this.data = r.json; this.sha = r.sha; } this.data.users = this.data.users || {}; if (!this.data.secret) this.data.secret = crypto.randomBytes(32).toString('hex'); this.blocked = false; this.lastError = ''; log('GitHub de nouveau accessible : comptes chargés.'); }
    catch (e) { this.lastError = String(e.message || e); setTimeout(() => this.retryLoad(), 30000); }
  },
  touch() { this.dirty = true; clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 4000); },
  async flush() {
    if (!this.dirty || this.saving || this.blocked) return;
    this.saving = true; this.dirty = false;
    const body = JSON.stringify(this.data, null, 1);
    try {
      if (this.mode === 'github') {
        try { this.sha = await ghPut(body, this.sha); }
        catch (e) {
          if (e.status === 409 || e.status === 422) { const cur = await ghGet(); this.sha = cur ? cur.sha : null; this.sha = await ghPut(body, this.sha); }
          else throw e;
        }
      } else {
        fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
        fs.writeFileSync(LOCAL_FILE + '.tmp', body); fs.renameSync(LOCAL_FILE + '.tmp', LOCAL_FILE);
      }
      this.lastSave = Date.now(); this.lastError = '';
    } catch (e) {
      this.lastError = String(e.message || e); log('ERREUR sauvegarde :', this.lastError);
      this.dirty = true; clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 15000);
    } finally { this.saving = false; if (this.dirty && !this.timer) this.touch(); }
  },
};

const ghHeaders = extra => Object.assign({ Authorization: 'Bearer ' + GH.token, 'User-Agent': 'backrooms-server', 'X-GitHub-Api-Version': '2022-11-28' }, extra || {});
const ghUrl = () => `https://api.github.com/repos/${GH.repo}/contents/${encodeURIComponent(GH.path).replace(/%2F/g, '/')}`;
async function ghGet() {
  const r = await fetch(ghUrl() + '?ref=' + encodeURIComponent(GH.branch), { headers: ghHeaders({ Accept: 'application/vnd.github+json' }) });
  if (r.status === 404) return null;
  if (!r.ok) { const e = new Error('GitHub GET ' + r.status + ' ' + (await r.text()).slice(0, 200)); e.status = r.status; throw e; }
  const j = await r.json();
  let text;
  if (j.content && j.encoding === 'base64') text = Buffer.from(j.content, 'base64').toString('utf8');
  else { // fichier > 1 Mo : contenu brut
    const raw = await fetch(ghUrl() + '?ref=' + encodeURIComponent(GH.branch), { headers: ghHeaders({ Accept: 'application/vnd.github.raw' }) });
    if (!raw.ok) throw new Error('GitHub RAW ' + raw.status);
    text = await raw.text();
  }
  return { json: JSON.parse(text), sha: j.sha };
}
async function ghPut(body, sha) {
  const payload = { message: 'Sauvegarde des comptes ' + new Date().toISOString(), content: Buffer.from(body, 'utf8').toString('base64'), branch: GH.branch };
  if (sha) payload.sha = sha;
  const r = await fetch(ghUrl(), { method: 'PUT', headers: ghHeaders({ Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
  if (!r.ok) { const e = new Error('GitHub PUT ' + r.status + ' ' + (await r.text()).slice(0, 200)); e.status = r.status; throw e; }
  const j = await r.json();
  return j.content && j.content.sha;
}

/* ===================================================================
   COMPTES
   =================================================================== */
const secret = () => process.env.AUTH_SECRET || Store.data.secret;
const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function makeToken(key, gen) { const p = b64u(JSON.stringify({ u: key, g: gen || 0, t: Date.now() })); return p + '.' + b64u(crypto.createHmac('sha256', secret()).update(p).digest()); }
function readToken(tok) {
  if (typeof tok !== 'string' || tok.indexOf('.') < 0) return null;
  const [p, s] = tok.split('.');
  const exp = b64u(crypto.createHmac('sha256', secret()).update(p).digest());
  if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
  try { const o = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); const u = Store.data.users[o.u]; if (!u || (u.gen || 0) !== (o.g || 0)) return null; return o.u; } catch (e) { return null; }
}
const hashPass = (pass, salt) => new Promise((res, rej) => crypto.scrypt(pass, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k.toString('hex'))));
const NAME_RE = /^[A-Za-z0-9_\-À-ÿ]{3,16}$/;
const keyOf = n => String(n).trim().toLowerCase();

function cleanProfile(p, name) {
  // garde-fous : la forme est contrôlée, les valeurs bornées
  p = (p && typeof p === 'object') ? p : {};
  const num = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(a, Math.min(b, Math.floor(v))) : d; };
  const strArr = (a, max) => Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.length < 32).slice(0, max) : [];
  const st = p.stats && typeof p.stats === 'object' ? p.stats : {};
  const stats = {};
  for (const k of ['games', 'escapes', 'deaths', 'fuses', 'revives', 'downs', 'time', 'wins', 'items', 'solo', 'multi']) stats[k] = num(st[k], 0, 1e9, 0);
  stats.best = {}; if (st.best && typeof st.best === 'object') for (const k of Object.keys(st.best).slice(0, 40)) { const v = num(st.best[k], 0, 1e7, 0); if (v) stats.best[k.slice(0, 24)] = v; }
  const look = p.look && typeof p.look === 'object' ? p.look : {};
  const lk = {}; for (const k of ['skin', 'aura']) lk[k] = typeof look[k] === 'string' && look[k].length < 32 ? look[k] : null;
  if (!lk.skin) lk.skin = 'survivor';
  const inv = {}; if (p.inv && typeof p.inv === 'object') for (const k of Object.keys(p.inv).slice(0, 20)) if (k.length < 20) inv[k] = num(p.inv[k], 0, 99, 0);
  return {
    v: 1, name, points: num(p.points, 0, 1e8, 300), xp: num(p.xp, 0, 1e9, 0),
    stats, look: lk, ownedSkins: Array.from(new Set(['survivor', ...strArr(p.ownedSkins, 40)])), ownedAcc: strArr(p.ownedAcc, 60),
    inv, loadout: strArr(p.loadout, 3), title: typeof p.title === 'string' ? p.title.slice(0, 24) : '', created: num(p.created, 0, 1e14, Date.now()),
    daily: num(p.daily, 0, 1e14, 0), streak: num(p.streak, 0, 1000, 0), achievements: strArr(p.achievements, 80),
    arena: cleanArena(p.arena, num, strArr),
  };
}

// jeu 2 (COLOSSES) : compétences possédées, équipement, statistiques (formes et bornes contrôlées)
function cleanArena(a, num, strArr) {
  a = a && typeof a === 'object' ? a : {};
  const id = v => typeof v === 'string' && /^[a-z_0-9]{2,24}$/.test(v) ? v : null;
  const owned = {}; if (a.owned && typeof a.owned === 'object') for (const k of Object.keys(a.owned).slice(0, 60)) { if (!id(k)) continue; const v = a.owned[k] || {}; owned[k] = { lv: num(v.lv, 1, 5, 1), xp: num(v.xp, 0, 100000, 0) }; }
  const equip = [0, 1, 2, 3].map(i => Array.isArray(a.equip) ? id(a.equip[i]) : null);
  const st = a.st && typeof a.st === 'object' ? a.st : {}, obj = (o, max) => { const out = {}; if (o && typeof o === 'object') for (const k of Object.keys(o).slice(0, max)) if (k.length < 32) out[k] = num(o[k], 0, 1e7, 0); return out; };
  return { owned, equip, ult: id(a.ult), weapon: id(a.weapon), free: num(a.free, 0, 5, 0), st: { boss: obj(st.boss, 10), best: obj(st.best, 40), duelW: num(st.duelW, 0, 1e7, 0), duelL: num(st.duelL, 0, 1e7, 0), botW: num(st.botW, 0, 1e7, 0) } };
}

const rate = new Map();
function limited(ip, kind, max, perMs) {
  const k = ip + '|' + kind, now = Date.now(); let r = rate.get(k);
  if (!r || now - r.t > perMs) { r = { t: now, n: 0 }; rate.set(k, r); }
  return ++r.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, r] of rate) if (now - r.t > 600000) rate.delete(k); }, 60000);

async function apiRegister(body, ip) {
  if (Store.blocked) return [503, { error: 'Base de comptes momentanément indisponible, réessaie dans une minute.' }];
  if (limited(ip, 'reg', 6, 600000)) return [429, { error: 'Trop de comptes créés, patiente un peu.' }];
  const name = String(body.name || '').trim(), pass = String(body.pass || '');
  if (!NAME_RE.test(name)) return [400, { error: 'Pseudo : 3 à 16 caractères (lettres, chiffres, _ ou -).' }];
  if (pass.length < 4 || pass.length > 72) return [400, { error: 'Mot de passe : 4 caractères minimum.' }];
  const key = keyOf(name);
  if (Store.data.users[key]) return [409, { error: 'Ce pseudo est déjà pris.' }];
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPass(pass, salt);
  if (Store.data.users[key]) return [409, { error: 'Ce pseudo est déjà pris.' }];
  const profile = cleanProfile(body.profile || {}, name);
  Store.data.users[key] = { name, salt, hash, gen: 0, created: Date.now(), seen: Date.now(), profile };
  Store.touch();
  log('Nouveau compte :', name);
  return [200, { token: makeToken(key, 0), profile }];
}
async function apiLogin(body, ip) {
  if (Store.blocked) return [503, { error: 'Base de comptes momentanément indisponible, réessaie dans une minute.' }];
  if (limited(ip, 'login', 12, 300000)) return [429, { error: 'Trop d\'essais, patiente quelques minutes.' }];
  const key = keyOf(body.name || ''), u = Store.data.users[key];
  if (!u) return [404, { error: 'Compte introuvable.' }];
  const h = await hashPass(String(body.pass || ''), u.salt);
  if (h !== u.hash) return [401, { error: 'Mot de passe incorrect.' }];
  u.seen = Date.now(); Store.touch();
  return [200, { token: makeToken(key, u.gen || 0), profile: u.profile }];
}
function apiMe(key) { const u = Store.data.users[key]; u.seen = Date.now(); return [200, { profile: u.profile }]; }
function apiSave(key, body) {
  const u = Store.data.users[key];
  const s = JSON.stringify(body.profile || {}); if (s.length > 30000) return [413, { error: 'Profil trop gros.' }];
  u.profile = cleanProfile(body.profile, u.name); u.seen = Date.now(); Store.touch();
  return [200, { ok: true, profile: u.profile }];
}
async function apiPassword(key, body) {
  const u = Store.data.users[key];
  if ((await hashPass(String(body.old || ''), u.salt)) !== u.hash) return [401, { error: 'Ancien mot de passe incorrect.' }];
  const np = String(body.pass || ''); if (np.length < 4 || np.length > 72) return [400, { error: 'Mot de passe : 4 caractères minimum.' }];
  u.salt = crypto.randomBytes(16).toString('hex'); u.hash = await hashPass(np, u.salt); u.gen = (u.gen || 0) + 1; Store.touch();
  return [200, { token: makeToken(key, u.gen) }];
}
let lbCache = null, lbTime = 0;
function apiLeaderboard() {
  if (lbCache && Date.now() - lbTime < 20000) return [200, lbCache];
  const all = Object.values(Store.data.users).map(u => ({ name: u.name, xp: u.profile.xp || 0, escapes: (u.profile.stats || {}).escapes || 0, games: (u.profile.stats || {}).games || 0, fuses: (u.profile.stats || {}).fuses || 0, revives: (u.profile.stats || {}).revives || 0, skin: (u.profile.look || {}).skin || 'survivor' }));
  const top = k => all.slice().sort((a, b) => b[k] - a[k]).slice(0, 50);
  lbCache = { xp: top('xp'), escapes: top('escapes'), revives: top('revives'), total: all.length }; lbTime = Date.now();
  return [200, lbCache];
}

/* ===================================================================
   HTTP (API + fichiers du jeu)
   =================================================================== */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2' };
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function json(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 64000) { reject(new Error('trop gros')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res, urlPath) {
  if (!GAME_DIR) { cors(res); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Backrooms server OK (v' + VERSION + ')'); return; }
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const parts = p.split('/').filter(Boolean);
  if (parts.some(s => s.startsWith('.') || s === 'server' || s === 'node_modules')) { res.writeHead(404); res.end('404'); return; }
  const file = path.join(GAME_DIR, ...parts);
  if (!file.startsWith(GAME_DIR)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ['.html', '.js', '.css', '.json'].includes(ext) ? 'no-cache' : 'public, max-age=3600', 'Last-Modified': st.mtime.toUTCString(), 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/', ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  try {
    if (url.startsWith('/health')) return json(res, 200, { ok: true, v: VERSION, online: clients.size, rooms: rooms.size, playing: [...rooms.values()].filter(r => r.state === 'game').length, accounts: Object.keys(Store.data.users).length, storage: Store.mode, storageOk: !Store.lastError, game: !!GAME_DIR });
    if (url.startsWith('/api/')) {
      const route = url.split('?')[0];
      if (req.method === 'GET' && route === '/api/leaderboard') { const [c, o] = apiLeaderboard(); return json(res, c, o); }
      const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (req.method === 'GET' && route === '/api/me') { const k = readToken(auth); if (!k) return json(res, 401, { error: 'Session expirée, reconnecte-toi.' }); const [c, o] = apiMe(k); return json(res, c, o); }
      if (req.method !== 'POST') return json(res, 405, { error: 'Méthode non autorisée' });
      const body = await readBody(req);
      if (route === '/api/register') { const [c, o] = await apiRegister(body, ip); return json(res, c, o); }
      if (route === '/api/login') { const [c, o] = await apiLogin(body, ip); return json(res, c, o); }
      const k = readToken(auth); if (!k) return json(res, 401, { error: 'Session expirée, reconnecte-toi.' });
      if (route === '/api/save') { const [c, o] = apiSave(k, body); return json(res, c, o); }
      if (route === '/api/password') { const [c, o] = await apiPassword(k, body); return json(res, c, o); }
      return json(res, 404, { error: 'Route inconnue' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    serveStatic(req, res, url);
  } catch (e) {
    log('Erreur HTTP', e.message);
    json(res, 500, { error: 'Erreur serveur' });
  }
});

/* ===================================================================
   SALONS (WebSocket)
   =================================================================== */
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
const clients = new Map();          // id -> client
const rooms = new Map();            // code -> room
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// les cartes et difficultés sont décrites côté client : le serveur accepte tout identifiant simple
// (ainsi, ajouter une carte, un boss ou un mode ne demande plus de redéployer le serveur)
const ID_RE = /^[a-z0-9_]{1,24}$/;
const MAPS = { includes: v => typeof v === 'string' && ID_RE.test(v) }, DIFFS = { includes: v => typeof v === 'string' && ID_RE.test(v) };
let nextId = 1;

const send = (c, o) => { try { if (c && c.ws.readyState === 1) c.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch (e) {} };
function newCode() { for (;;) { let s = ''; for (let i = 0; i < 4; i++) s += CODE_CH[crypto.randomInt(CODE_CH.length)]; if (!rooms.has(s)) return s; } }
const cleanName = n => (String(n || '').replace(/[^\wÀ-ÿ \-.]/g, '').trim().slice(0, 16) || 'Survivant');
const cleanLook = l => { const o = {}; l = l && typeof l === 'object' ? l : {}; for (const k of ['skin', 'aura']) o[k] = typeof l[k] === 'string' && l[k].length < 32 ? l[k] : null; o.skin = o.skin || 'survivor'; return o; };

function roomView(r) {
  return {
    code: r.code, name: r.name, host: r.host, state: r.state, map: r.map, diff: r.diff, max: r.max, priv: r.priv, round: r.round,
    players: r.order.map(id => { const c = clients.get(id); return c ? { id, name: c.name, look: c.look, level: c.level, ready: !!r.ready[id], acc: !!c.account } : null; }).filter(Boolean),
  };
}
function roomList() {
  return [...rooms.values()].filter(r => !r.priv).map(r => ({ code: r.code, name: r.name, hostName: (clients.get(r.host) || {}).name || '?', n: r.order.length, max: r.max, map: r.map, diff: r.diff, state: r.state }))
    .sort((a, b) => (a.state === 'lobby' ? 0 : 1) - (b.state === 'lobby' ? 0 : 1) || b.n - a.n).slice(0, 60);
}
function broadcastRoom(r, extra) { const v = { t: 'room', room: roomView(r) }; if (extra) Object.assign(v, extra); const s = JSON.stringify(v); r.order.forEach(id => send(clients.get(id), s)); }
function toRoom(r, o, exceptId) { const s = JSON.stringify(o); r.order.forEach(id => { if (id !== exceptId) send(clients.get(id), s); }); }

function leaveRoom(c, reason) {
  const r = c.room && rooms.get(c.room); c.room = null;
  if (!r) return;
  r.order = r.order.filter(id => id !== c.id); delete r.ready[c.id];
  if (!r.order.length) { rooms.delete(r.code); log('Salon fermé', r.code); return; }
  toRoom(r, { t: 'left', id: c.id, name: c.name, reason: reason || 'quit' });
  if (r.host === c.id) {
    r.host = r.order[0];
    if (r.state === 'game') { r.state = 'lobby'; r.ready = {}; toRoom(r, { t: 'abort', msg: 'L\'hôte a quitté la partie.' }); }
    toRoom(r, { t: 'sys', m: (clients.get(r.host) || {}).name + ' est maintenant l\'hôte.' });
  }
  broadcastRoom(r);
}
function joinRoom(c, r) {
  if (c.room) leaveRoom(c);
  if (r.order.length >= r.max) return send(c, { t: 'error', code: 'full', msg: 'Ce salon est plein.' });
  if (r.state === 'game') return send(c, { t: 'error', code: 'ingame', msg: 'Partie en cours : attends la fin de la manche.' });
  if (r.banned.has(c.ip + '|' + c.name)) return send(c, { t: 'error', code: 'kicked', msg: 'Tu as été exclu de ce salon.' });
  r.order.push(c.id); c.room = r.code;
  broadcastRoom(r);
  toRoom(r, { t: 'sys', m: c.name + ' a rejoint le salon.' }, c.id);
}

wss.on('connection', (ws, req) => {
  const c = { id: 'p' + (nextId++).toString(36), ws, name: 'Survivant', look: cleanLook(), level: 1, account: false, room: null, alive: true, ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), bucket: 200, bt: Date.now() };
  clients.set(c.id, c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', raw => {
    c.alive = true;
    // limitation de débit (jeton seau : 200 msg, +90/s)
    const now = Date.now(); c.bucket = Math.min(200, c.bucket + (now - c.bt) * 0.09); c.bt = now;
    if (--c.bucket < 0) return;
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const r = c.room ? rooms.get(c.room) : null;
    switch (m.t) {
      case 'hello': {
        c.name = cleanName(m.name); c.look = cleanLook(m.look); c.level = Math.max(1, Math.min(999, m.level | 0 || 1));
        if (m.token) { const k = readToken(m.token); if (k) { c.account = true; c.name = Store.data.users[k].name; } }
        send(c, { t: 'welcome', id: c.id, v: VERSION, online: clients.size, rooms: roomList() });
        break;
      }
      case 'ping': send(c, { t: 'pong', c: m.c, online: clients.size }); break;
      case 'api': {   // même API que /api/* mais par le WebSocket (réseaux d'école où le fetch HTTPS est filtré)
        const q = m.q, route = String(m.path || ''), body = (m.body && typeof m.body === 'object') ? m.body : {}, k = m.token ? readToken(String(m.token)) : null;
        const reply = ([code, o]) => send(c, { t: 'apir', q, c: code, o });
        (async () => {
          if (route === '/api/leaderboard') return reply(apiLeaderboard());
          if (route === '/api/register') return reply(await apiRegister(body, c.ip));
          if (route === '/api/login') return reply(await apiLogin(body, c.ip));
          if (!k) return reply([401, { error: 'Session expirée, reconnecte-toi.' }]);
          if (route === '/api/me') return reply(apiMe(k));
          if (route === '/api/save') return reply(apiSave(k, body));
          if (route === '/api/password') return reply(await apiPassword(k, body));
          reply([404, { error: 'Route inconnue' }]);
        })().catch(e => { log('Erreur API ws', e.message); reply([500, { error: 'Erreur serveur' }]); });
        break;
      }
      case 'list': send(c, { t: 'rooms', list: roomList(), online: clients.size }); break;
      case 'profile': c.look = cleanLook(m.look); if (m.level) c.level = Math.max(1, Math.min(999, m.level | 0)); if (r) broadcastRoom(r); break;
      case 'create': {
        const nr = { code: newCode(), name: String(m.name || (c.name + ' — salon')).replace(/[<>]/g, '').slice(0, 28), host: c.id, state: 'lobby', map: MAPS.includes(m.map) ? m.map : 'backrooms', diff: DIFFS.includes(m.diff) ? m.diff : 'normal', max: Math.max(1, Math.min(8, m.max | 0 || 6)), priv: !!m.priv, order: [], ready: {}, round: 0, banned: new Set(), created: Date.now() };
        rooms.set(nr.code, nr); log('Salon créé', nr.code, 'par', c.name);
        joinRoom(c, nr);
        break;
      }
      case 'join': {
        const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const tr = rooms.get(code);
        if (!tr) { send(c, { t: 'error', code: 'notfound', msg: 'Aucun salon avec le code ' + (code || '?') + '.' }); break; }
        joinRoom(c, tr); break;
      }
      case 'quick': {
        const cand = [...rooms.values()].filter(x => !x.priv && x.state === 'lobby' && x.order.length < x.max).sort((a, b) => b.order.length - a.order.length)[0];
        if (cand) joinRoom(c, cand);
        else send(c, { t: 'error', code: 'noquick', msg: 'Aucun salon public ouvert : crée le tien !' });
        break;
      }
      case 'leave': leaveRoom(c); send(c, { t: 'rooms', list: roomList(), online: clients.size }); break;
      case 'settings': {
        if (!r || r.host !== c.id || r.state !== 'lobby') break;
        if (MAPS.includes(m.map)) r.map = m.map; if (DIFFS.includes(m.diff)) r.diff = m.diff;
        if (m.max) r.max = Math.max(r.order.length, Math.min(8, m.max | 0));
        if (m.priv != null) r.priv = !!m.priv; if (m.name) r.name = String(m.name).replace(/[<>]/g, '').slice(0, 28);
        broadcastRoom(r); break;
      }
      case 'ready': if (r && r.state === 'lobby') { r.ready[c.id] = !!m.v; broadcastRoom(r); } break;
      case 'kick': {
        if (!r || r.host !== c.id || m.id === c.id) break;
        const k = clients.get(m.id); if (!k || k.room !== r.code) break;
        r.banned.add(k.ip + '|' + k.name); leaveRoom(k, 'kick'); send(k, { t: 'kicked', msg: 'L\'hôte t\'a exclu du salon.' }); break;
      }
      case 'start': {
        if (!r || r.host !== c.id || r.state !== 'lobby') break;
        r.state = 'game'; r.round++;
        const seed = (m.seed >>> 0) || crypto.randomInt(1, 2 ** 31);
        toRoom(r, { t: 'start', seed, map: m.map || r.map, diff: r.diff, round: r.round, room: roomView(r), cfg: m.cfg || null });
        break;
      }
      case 'end': if (r && r.host === c.id && r.state === 'game') { r.state = 'lobby'; r.ready = {}; toRoom(r, { t: 'end', res: m.res || null }); broadcastRoom(r); } break;
      case 'r': {   // relais de jeu
        if (!r) break;
        const out = JSON.stringify({ t: 'r', f: c.id, d: m.d });
        if (m.to === '*' || (m.to == null && r.host === c.id)) r.order.forEach(id => { if (id !== c.id) send(clients.get(id), out); });
        else send(clients.get(m.to == null ? r.host : m.to), out);
        break;
      }
      case 'chat': {
        if (!r) break;
        const txt = String(m.m || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 160); if (!txt) break;
        toRoom(r, { t: 'chat', f: c.id, n: c.name, m: txt, q: m.q ? 1 : 0 });
        break;
      }
    }
  });
  ws.on('close', () => { leaveRoom(c, 'disconnect'); clients.delete(c.id); });
  ws.on('error', () => {});
});
setInterval(() => {
  for (const c of clients.values()) { if (!c.alive) { try { c.ws.terminate(); } catch (e) {} continue; } c.alive = false; try { c.ws.ping(); } catch (e) {} }
}, 20000);

/* ===================================================================
   DÉMARRAGE / ARRÊT
   =================================================================== */
async function shutdown(sig) {
  log('Arrêt (' + sig + '), sauvegarde…');
  try { clearTimeout(Store.timer); if (Store.dirty) await Store.flush(); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

Store.load().then(() => {
  server.listen(PORT, () => {
    log(`Serveur Backrooms v${VERSION} sur le port ${PORT}`);
    log(GAME_DIR ? 'Jeu servi depuis ' + GAME_DIR : 'API seule (le jeu n\'est pas dans ce dossier)');
    if (Store.mode === 'local') log('ATTENTION : sans GITHUB_TOKEN, sur Render les comptes seront perdus à chaque redémarrage.');
  });
});
