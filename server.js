'use strict';
/*
  Kenya One (K1) clan site server.
  No packages to install. Needs Node.js 18 or newer.
  Run:  node server.js     (then open http://localhost:3000)
  Data is kept in one file: data/db.json (back it up now and then).
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const OWNER_ID = process.env.OWNER_ID || 'm_07';            // roster id of the site owner (Martin)
const TRUST_PROXY = process.env.TRUST_PROXY === '1';        // set to 1 when behind Render, Railway, Nginx etc.
/* Hosted mode (Vercel): data lives in an Upstash Redis database instead of a file. */
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const REMOTE = !!(KV_URL && KV_TOKEN);
const SESSION_MS = 365 * 24 * 3600 * 1000;
const ADMIN_ROLES = ['Master', 'Warlord', 'Vice Master', 'Leader'];

if (!REMOTE) fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* ---------- storage ---------- */
let db;
function writeNow() {
  if (REMOTE) return;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
let saveTimer = null;
let dirty = false;
function save() {
  db.v += 1;
  if (REMOTE) { dirty = true; return; }
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 150);
}
function load() {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    try { fs.copyFileSync(DB_FILE, DB_FILE + '.bak'); } catch (e) { /* ignore */ }
  } else {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
    db = { v: 1, docs: seed.docs || {}, auth: {}, sessions: {}, assets: {} };
    writeNow();
  }
  db.docs = db.docs || {}; db.auth = db.auth || {}; db.sessions = db.sessions || {}; db.assets = db.assets || {};
  const now = Date.now();
  Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].exp < now) delete db.sessions[k]; });
}
if (!REMOTE) load(); else db = { v: 1, docs: {}, auth: {}, sessions: {}, assets: {} };
process.on('SIGTERM', () => { try { writeNow(); } catch (e) { /* ignore */ } process.exit(0); });
process.on('SIGINT', () => { try { writeNow(); } catch (e) { /* ignore */ } process.exit(0); });

/* ---------- login codes ---------- */
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hashCode(code, salt) { return crypto.scryptSync(String(code), salt, 32).toString('hex'); }
function setCode(id, code) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.auth[id] = { salt, hash: hashCode(code, salt) };
  Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].id === id) delete db.sessions[k]; });
}
function checkCode(id, code) {
  const a = db.auth[id];
  if (!a) return false;
  const x = Buffer.from(hashCode(code, a.salt), 'hex');
  const y = Buffer.from(a.hash, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
(function bootstrapOwner() {
  if (REMOTE) return;
  if (process.env.OWNER_CODE) { setCode(OWNER_ID, process.env.OWNER_CODE); save(); writeNow(); return; }
  if (!db.auth[OWNER_ID]) {
    const code = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
    setCode(OWNER_ID, code); save(); writeNow();
    fs.writeFileSync(path.join(DATA_DIR, 'owner-code.txt'), code + '\n');
    console.log('\n  OWNER LOGIN CODE: ' + code + '  (also saved in ' + path.join(DATA_DIR, 'owner-code.txt') + ')\n');
  }
})();

/* ---------- who is asking, and what they may do ---------- */
function docRole(id) { const r = db.docs['roles/' + id]; return (r && r.role) || ''; }
function isAdmin(id) { return id === OWNER_ID || ADMIN_ROLES.includes(docRole(id)); }
function isOwner(id) { return id === OWNER_ID || docRole(id) === 'Master'; }
function exists(id) { return id === OWNER_ID || !!db.docs['roster/' + id]; }

function authOf(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  let id = null;
  if (t) {
    const s = db.sessions[sha(t)];
    if (s && s.exp > Date.now() && exists(s.id)) id = s.id;
  }
  const dev = String(req.headers['x-device'] || '');
  return {
    id,
    dev: /^dev_[A-Za-z0-9]{6,40}$/.test(dev) ? dev : '',
    admin: id ? isAdmin(id) : false,
    owner: id ? isOwner(id) : false,
  };
}
const LV = { view: 0, interact: 1, admin: 2, owner: 3 };
function level(a) { return a.owner ? 3 : a.admin ? 2 : a.id ? 1 : 0; }
const RULES = {
  roster:   { read: 'view',  write: 'admin', self: { read: 'view',     write: 'interact' } },
  contacts: { read: 'admin', write: 'admin', self: { read: 'interact', write: 'interact' } },
  pending:  { read: 'admin', write: 'admin', self: { read: 'interact', write: 'interact' } },
  log:      { read: 'admin', write: 'admin' },
  roles:    { read: 'view',  write: 'owner' },
};
const DEFAULT_RULE = { read: 'view', write: 'admin' };
function can(op, col, id, a) {
  const r = RULES[col] || DEFAULT_RULE;
  if (level(a) >= LV[r[op]]) return true;
  if (r.self && id && a.id === id && level(a) >= LV[r.self[op]]) return true;
  if (col === 'pending' && a.dev && id === a.dev) return true;     // a visitor's own join request
  return false;
}

/* ---------- small helpers ---------- */
const ID_RE = /^[A-Za-z0-9_.\-]{1,80}$/;
function ipOf(req) {
  if (TRUST_PROXY) { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
  return req.socket.remoteAddress || '';
}
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < ms);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); hits.forEach((v, k) => { if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }); }, 600e3).unref();

function send(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers || {}));
  res.end(body);
}
function readBody(req, max) {
  if (REMOTE && req.body !== undefined) {                       // some hosts read the body before we do
    const b = req.body;
    const buf = Buffer.isBuffer(b) ? b : typeof b === 'string' ? Buffer.from(b) : Buffer.from(JSON.stringify(b || {}));
    if (buf.length > max) return Promise.reject(Object.assign(new Error('too large'), { status: 413 }));
    return Promise.resolve(buf);
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 128 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch (e) { throw Object.assign(new Error('bad json'), { status: 400 }); }
}
function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function clean(o) {                         // drop prototype tricks and cap document size
  const s = JSON.stringify(o);
  if (s.length > 64 * 1024) throw Object.assign(new Error('document too large'), { status: 413 });
  return JSON.parse(s, (k, v) => (k === '__proto__' || k === 'constructor' ? undefined : v));
}
function deny(res, a) { send(res, a.id ? 403 : 401, { error: a.id ? 'not allowed' : 'login needed' }); }

/* ---------- pages ---------- */
const INDEX = path.join(__dirname, 'public', 'index.html');
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://platform.twitter.com https://cdn.syndication.twimg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://platform.twitter.com https://*.twimg.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https:; frame-src https://platform.twitter.com https://syndication.twitter.com https://x.com; connect-src 'self' https://syndication.twitter.com https://cdn.syndication.twimg.com https://api.twitter.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

async function handle(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const m = req.method;

    if (m === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (m === 'GET' && p === '/shim.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'shim.js')));
    }
    if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (m === 'GET' && p === '/api/version') return send(res, 200, { v: db.v, poll: 3000 });

    if (m === 'GET' && (p.startsWith('/_blob/') || p.startsWith('/api/blob/'))) {
      const id = p.slice(p.startsWith('/_blob/') ? 7 : 10);
      const meta = ID_RE.test(id) && db.assets[id];
      if (!meta) { res.writeHead(404); return res.end(); }
      if (REMOTE) {
        const b64 = (await kv([['GET', 'k1:blob:' + id]]))[0];
        if (!b64) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': meta.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
        return res.end(Buffer.from(b64, 'base64'));
      }
      res.writeHead(200, { 'content-type': meta.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(path.join(DATA_DIR, 'uploads', id)).pipe(res);
    }

    if (!p.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    const a = authOf(req);

    if (m === 'GET' && p === '/api/me') {
      if (!a.id) return send(res, 200, { id: null });
      const r = db.docs['roster/' + a.id];
      return send(res, 200, { id: a.id, admin: a.admin, owner: a.owner, name: r ? r.name : '' });
    }

    if (m === 'POST' && p === '/api/login') {
      const b = await readJson(req);
      const id = String(b.id || ''), code = String(b.code || '').trim();
      if (limited('login:' + ipOf(req), 20, 15 * 60e3) || limited('loginid:' + id, 8, 15 * 60e3)) return send(res, 429, { error: 'too many tries, wait a few minutes' });
      if (!ID_RE.test(id) || !exists(id) || !checkCode(id, code)) return send(res, 401, { error: 'wrong name or code' });
      const token = crypto.randomBytes(32).toString('hex');
      db.sessions[sha(token)] = { id, exp: Date.now() + SESSION_MS };
      save();
      const r = db.docs['roster/' + id];
      return send(res, 200, { token, me: { id, admin: isAdmin(id), owner: isOwner(id), name: r ? r.name : '' } });
    }
    /* a member saves their own WhatsApp number the first time they pick their name */
    if (m === 'POST' && p === '/api/claim') {
      const b = await readJson(req);
      const id = String(b.id || ''), phone = String(b.phone || '').replace(/\D/g, '');
      if (limited('claim:' + ipOf(req), 30, 15 * 60e3)) return send(res, 429, { error: 'too many tries, wait a few minutes' });
      if (!ID_RE.test(id) || !db.docs['roster/' + id]) return send(res, 404, { error: 'name not on the roster' });
      if (!/^\d{11,15}$/.test(phone)) return send(res, 400, { error: 'enter the full WhatsApp number' });
      if (!a.id && !a.dev) return send(res, 400, { error: 'no device id' });
      const cur = db.docs['contacts/' + id];
      const mine = a.id === id || a.admin || !cur || !cur.phone || (cur.dev && cur.dev === a.dev);
      if (!mine) return send(res, 409, { error: 'a number is already saved for this name', exists: true });
      db.docs['contacts/' + id] = { phone, dev: a.dev || '', at: Date.now() };
      const uid = String(b.uid || '').replace(/\D/g, '');
      const ros = db.docs['roster/' + id];
      if (/^\d{5,20}$/.test(uid) && ros && !ros.uid) ros.uid = uid;
      save();
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/logout') {
      const h = req.headers.authorization || '';
      if (h.startsWith('Bearer ')) { delete db.sessions[sha(h.slice(7))]; save(); }
      return send(res, 200, { ok: true });
    }

    /* leaders make login codes */
    if (p === '/api/codes') {
      if (!a.admin) return deny(res, a);
      if (m === 'GET') return send(res, 200, { ids: Object.keys(db.auth).filter((k) => k !== '_oc') });
      if (m === 'POST') {
        const b = await readJson(req);
        const id = String(b.id || '');
        if (!ID_RE.test(id) || !exists(id)) return send(res, 404, { error: 'no such member' });
        if (isAdmin(id) && !a.owner) return send(res, 403, { error: 'only a Master can make codes for leaders' });
        if (id === OWNER_ID && a.id !== OWNER_ID) return send(res, 403, { error: 'only the site owner can reset the owner code' });
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        setCode(id, code); save(); writeNow();
        return send(res, 200, { code });
      }
    }

    if (m === 'GET' && p === '/api/export') {
      if (!a.admin) return deny(res, a);
      return send(res, 200, { docs: db.docs, exportedAt: Date.now() }, { 'content-disposition': 'attachment; filename="k1-backup.json"' });
    }

    /* pictures */
    if (m === 'POST' && p === '/api/assets') {
      if (!a.admin) return deny(res, a);
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) return send(res, 415, { error: 'use a JPG, PNG, WebP or GIF picture' });
      const buf = await readBody(req, REMOTE ? 700 * 1024 : 6 * 1024 * 1024);
      const id = crypto.randomBytes(16).toString('hex');
      if (REMOTE) await kv([['SET', 'k1:blob:' + id, buf.toString('base64')]]);
      else fs.writeFileSync(path.join(DATA_DIR, 'uploads', id), buf);
      db.assets[id] = { type, size: buf.length }; save();
      return send(res, 200, { id, url: '/_blob/' + id, sizeBytes: buf.length, contentType: type });
    }

    /* data: collection list, add */
    let mm = p.match(/^\/api\/c\/([^/]+)$/);
    if (mm) {
      const col = mm[1];
      if (!ID_RE.test(col)) return send(res, 400, { error: 'bad path' });
      if (m === 'GET') {
        const order = u.searchParams.get('order'), dir = u.searchParams.get('dir') === 'desc' ? -1 : 1;
        const limit = Math.min(Number(u.searchParams.get('limit')) || 500, 500);
        let docs = Object.keys(db.docs).filter((k) => k.startsWith(col + '/')).map((k) => ({ id: k.slice(col.length + 1), data: db.docs[k] }))
          .filter((d) => can('read', col, d.id, a));
        if (order) docs.sort((x, y) => { const A = x.data[order], B = y.data[order]; return (A > B ? 1 : A < B ? -1 : 0) * dir; });
        return send(res, 200, { docs: docs.slice(0, limit) });
      }
      if (m === 'POST') {
        const b = await readJson(req);
        if (!isObj(b)) return send(res, 400, { error: 'bad data' });
        const id = crypto.randomBytes(8).toString('hex');
        if (!can('write', col, id, a)) return deny(res, a);
        if (a.dev && !a.id && limited('anon:' + ipOf(req), 10, 3600e3)) return send(res, 429, { error: 'slow down' });
        db.docs[col + '/' + id] = clean(b); save();
        return send(res, 200, { id });
      }
    }

    /* data: one document */
    mm = p.match(/^\/api\/d\/([^/]+)\/([^/]+)$/);
    if (mm) {
      const col = mm[1], id = mm[2], key = col + '/' + id;
      if (!ID_RE.test(col) || !ID_RE.test(id)) return send(res, 400, { error: 'bad path' });
      if (m === 'GET') {
        if (!can('read', col, id, a) || !(key in db.docs)) return send(res, 200, { exists: false });
        return send(res, 200, { exists: true, data: db.docs[key] });
      }
      if (!['PUT', 'PATCH', 'DELETE'].includes(m)) { res.writeHead(405); return res.end(); }
      const cleanup = m === 'DELETE' && col === 'roles' && !db.docs['roster/' + id] && a.admin;   // tidy up after a member is removed
      if (!cleanup && !can('write', col, id, a)) return deny(res, a);
      if (a.dev && !a.id && limited('anon:' + ipOf(req), 20, 3600e3)) return send(res, 429, { error: 'slow down' });
      if (m === 'DELETE') {
        delete db.docs[key];
        if (col === 'roster') {                       // removing someone also removes their private details and logins
          delete db.docs['contacts/' + id]; delete db.docs['roles/' + id]; delete db.auth[id];
          Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].id === id) delete db.sessions[k]; });
        }
        save(); return send(res, 200, { ok: true });
      }
      const b = await readJson(req);
      if (!isObj(b)) return send(res, 400, { error: 'bad data' });
      if (a.id && !a.admin && JSON.stringify(b).length > 8 * 1024) return send(res, 413, { error: 'too large' });
      if (m === 'PUT') db.docs[key] = clean(b);
      else { if (!(key in db.docs)) return send(res, 404, { error: 'not found' }); db.docs[key] = clean(Object.assign({}, db.docs[key], b)); }
      save();
      return send(res, 200, { ok: true });
    }

    res.writeHead(404); res.end();
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    else res.end();
    if (!e.status) console.error(e);
  }
}

/* ---------- hosted mode: load from and save to Redis around each request ---------- */
async function kv(cmds) {
  const r = await fetch(KV_URL.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { authorization: 'Bearer ' + KV_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('database error ' + r.status);
  const j = await r.json();
  return j.map((x) => { if (x.error) throw new Error('database error: ' + x.error); return x.result; });
}
const HASHES = { docs: 'k1:docs', auth: 'k1:auth', sessions: 'k1:sessions', assets: 'k1:assets' };
let snap = {};
function toObj(flat) {
  const o = {};
  if (Array.isArray(flat)) { for (let i = 0; i < flat.length; i += 2) { try { o[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) { /* skip */ } } }
  else if (flat && typeof flat === 'object') Object.keys(flat).forEach((k) => { try { o[k] = typeof flat[k] === 'string' ? JSON.parse(flat[k]) : flat[k]; } catch (e) { /* skip */ } });
  return o;
}
async function loadRemote() {
  const r = await kv([['HGETALL', HASHES.docs], ['HGETALL', HASHES.auth], ['HGETALL', HASHES.sessions], ['HGETALL', HASHES.assets], ['GET', 'k1:v'], ['GET', 'k1:seeded']]);
  db = { v: Number(r[4]) || 1, docs: toObj(r[0]), auth: toObj(r[1]), sessions: toObj(r[2]), assets: toObj(r[3]) };
  if (!r[5]) {
    const seed = require('./seed.json');
    const cmds = [];
    Object.keys(seed.docs || {}).forEach((k) => { db.docs[k] = seed.docs[k]; cmds.push(['HSET', HASHES.docs, k, JSON.stringify(seed.docs[k])]); });
    cmds.push(['SET', 'k1:seeded', '1']);
    await kv(cmds);
  }
  snap = {};
  Object.keys(HASHES).forEach((n) => { snap[n] = {}; Object.keys(db[n]).forEach((k) => { snap[n][k] = JSON.stringify(db[n][k]); }); });
  dirty = false;
  const now = Date.now();
  Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].exp < now) { delete db.sessions[k]; } });
  const oc = process.env.OWNER_CODE;
  if (!oc) { if (!db.auth[OWNER_ID]) throw Object.assign(new Error('The site owner has not set OWNER_CODE yet'), { status: 500 }); }
  else {
    const h = sha('oc:' + oc);
    if (!(db.auth._oc && db.auth._oc.hash === h)) { setCode(OWNER_ID, oc); db.auth._oc = { hash: h }; save(); }
  }
}
async function flush() {
  if (!dirty) return;
  const cmds = [];
  Object.keys(HASHES).forEach((n) => {
    const set = [], del = [];
    Object.keys(db[n]).forEach((k) => { const s = JSON.stringify(db[n][k]); if (snap[n][k] !== s) set.push(k, s); });
    Object.keys(snap[n]).forEach((k) => { if (!(k in db[n])) del.push(k); });
    if (set.length) cmds.push(['HSET', HASHES[n]].concat(set));
    if (del.length) cmds.push(['HDEL', HASHES[n]].concat(del));
  });
  cmds.push(['INCR', 'k1:v']);
  await kv(cmds);
  dirty = false;
}
let chain = Promise.resolve();
async function remoteRequest(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' && p === '/api/version') {          // cheap: one tiny read, no full load
    try { const v = (await kv([['GET', 'k1:v']]))[0]; return send(res, 200, { v: Number(v) || 1, poll: 3000 }, { 'cache-control': 'public, max-age=0, s-maxage=2' }); }
    catch (e) { return send(res, 503, { error: 'database not reachable' }); }
  }
  const wh = res.writeHead.bind(res), en = res.end.bind(res);
  let held = null;
  res.writeHead = function (code, headers) { held = [code, headers]; return res; };
  res.end = function (body) {
    flush().then(() => { if (held) wh(held[0], held[1]); en(body); },
      (e) => { console.error(e); wh(500, { 'content-type': 'application/json' }); en('{"error":"could not save, try again"}'); });
    return res;
  };
  try { await loadRemote(); } catch (e) {
    console.error(e);
    return send(res, e.status || 503, { error: e.status ? e.message : 'database not reachable' });
  }
  await handle(req, res);
}
function remoteEntry(req, res) {
  const run = chain.then(() => new Promise((resolve) => { res.on('close', resolve); remoteRequest(req, res).catch((e) => { console.error(e); try { res.statusCode = 500; res.end('error'); } catch (x) { /* ignore */ } }); }));
  chain = run.catch(() => {});
  return run;
}

const entry = REMOTE ? remoteEntry : handle;
module.exports = entry;
if (require.main === module) {
  http.createServer(entry).listen(PORT, () => console.log('Kenya One site running on port ' + PORT + (REMOTE ? ' (database mode)' : '')));
}
