/* Duo — private 1:1 messenger server (Node 18+, deps: express, ws)
   Stores only ciphertext: message bodies and file bytes are encrypted in the browser. */
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const DBFILE = path.join(DATA, 'db.json');
const MAX_UPLOAD = 25 * 1024 * 1024;

fs.mkdirSync(UPLOADS, { recursive: true });

/* ----------------------------- tiny json store ---------------------------- */
let db = { users: {}, codes: {}, requests: {}, pairs: {}, messages: {}, receipts: {}, files: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBFILE, 'utf8'))); } catch (e) {}
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    fs.writeFile(DBFILE + '.tmp', JSON.stringify(db), err => {
      if (!err) fs.rename(DBFILE + '.tmp', DBFILE, () => {});
    });
  }, 150);
}
const rid = (n = 16) => crypto.randomBytes(n).toString('base64url').slice(0, n);

/* --------------------------------- app ------------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  setHeaders(res, filePath) {
    if (/\.(html|js|json)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'no-cache, max-age=300'); // icons etc: revalidate, short cache
  }
}));

function auth(req, res, next) {
  const t = (req.get('authorization') || '').replace(/^Bearer /, '') || req.query.t;
  const uid = Object.keys(db.users).find(u => db.users[u].token === t);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  req.uid = uid;
  req.user = db.users[uid];
  next();
}
const pub = u => ({ uid: u.uid, username: u.username, pubJwk: u.pubJwk });

/* -------------------------------- accounts -------------------------------- */
app.post('/api/signup', (req, res) => {
  const username = String(req.body.username || '').trim().slice(0, 24);
  if (username.length < 2) return res.status(400).json({ error: 'username too short' });
  const uid = 'u_' + rid(14);
  const token = rid(32);
  const code = rid(10).toLowerCase().replace(/[^a-z0-9]/g, 'x');
  db.users[uid] = { uid, username, token, code, pubJwk: req.body.pubJwk || null, lastSeen: Date.now() };
  db.codes[code] = uid;
  save();
  res.json({ uid, token, code, username });
});

app.get('/api/me', auth, (req, res) => {
  const pair = db.pairs[req.uid] || null;
  let peer = null;
  if (pair) {
    const p = db.users[pair.peerUid];
    peer = p ? Object.assign(pub(p), { lastSeen: p.lastSeen, online: isOnline(p.uid) }) : null;
  }
  res.json({
    me: Object.assign(pub(req.user), { code: req.user.code }),
    pair, peer,
    requests: Object.values(db.requests).filter(r => r.toUid === req.uid && r.status === 'pending'),
    myRequest: db.requests[req.uid] || null
  });
});

app.post('/api/key', auth, (req, res) => {
  req.user.pubJwk = req.body.pubJwk; save();
  const p = db.pairs[req.uid];
  if (p) send(p.peerUid, { t: 'key', uid: req.uid, pubJwk: req.body.pubJwk });
  res.json({ ok: true });
});

app.get('/api/invite/:code', (req, res) => {
  const uid = db.codes[req.params.code];
  if (!uid || !db.users[uid]) return res.status(404).json({ error: 'unknown invite' });
  res.json({ ownerUid: uid, ownerUsername: db.users[uid].username, taken: !!db.pairs[uid] });
});

/* ------------------------------- connection ------------------------------- */
app.post('/api/request', auth, (req, res) => {
  const owner = db.codes[String(req.body.code || '')];
  if (!owner || !db.users[owner]) return res.status(404).json({ error: 'unknown invite' });
  if (owner === req.uid) return res.status(400).json({ error: 'that is your own link' });
  if (db.pairs[req.uid]) return res.status(400).json({ error: 'you are already connected' });
  if (db.pairs[owner]) return res.status(400).json({ error: 'that person is already connected' });
  const r = { fromUid: req.uid, fromUsername: req.user.username, toUid: owner, status: 'pending', ts: Date.now() };
  db.requests[req.uid] = r; save();
  send(owner, { t: 'request', request: r });
  res.json({ ok: true, request: r });
});

app.post('/api/request/:from/:decision', auth, (req, res) => {
  const r = db.requests[req.params.from];
  if (!r || r.toUid !== req.uid) return res.status(404).json({ error: 'no such request' });
  if (req.params.decision === 'reject') {
    r.status = 'rejected'; save();
    send(r.fromUid, { t: 'rejected' });
    return res.json({ ok: true });
  }
  if (db.pairs[req.uid] || db.pairs[r.fromUid]) return res.status(400).json({ error: 'already connected' });
  const a = db.users[req.uid], b = db.users[r.fromUid];
  const pairId = [a.uid, b.uid].sort().join('~');
  db.pairs[a.uid] = { pairId, peerUid: b.uid, peerUsername: b.username, at: Date.now() };
  db.pairs[b.uid] = { pairId, peerUid: a.uid, peerUsername: a.username, at: Date.now() };
  r.status = 'accepted'; save();
  send(b.uid, { t: 'paired', pair: db.pairs[b.uid], peer: Object.assign(pub(a), { online: isOnline(a.uid) }) });
  send(a.uid, { t: 'paired', pair: db.pairs[a.uid], peer: Object.assign(pub(b), { online: isOnline(b.uid) }) });
  res.json({ ok: true });
});

app.post('/api/unpair', auth, (req, res) => {
  const p = db.pairs[req.uid];
  if (!p) return res.json({ ok: true });
  delete db.messages[p.pairId];
  Object.keys(db.files).forEach(id => {
    if (db.files[id].pairId === p.pairId) { fs.unlink(path.join(UPLOADS, id), () => {}); delete db.files[id]; }
  });
  delete db.pairs[p.peerUid]; delete db.pairs[req.uid];
  delete db.requests[req.uid]; delete db.requests[p.peerUid];
  save();
  send(p.peerUid, { t: 'unpaired' });
  res.json({ ok: true });
});

/* -------------------------------- messages -------------------------------- */
function pairOf(uid) { return db.pairs[uid] || null; }

app.get('/api/messages', auth, (req, res) => {
  const p = pairOf(req.uid);
  if (!p) return res.json({ messages: [], receipts: {} });
  res.json({
    messages: db.messages[p.pairId] || [],
    receipts: {
      mine: db.receipts[p.pairId + '~' + req.uid] || { deliveredTs: 0, readTs: 0 },
      peer: db.receipts[p.pairId + '~' + p.peerUid] || { deliveredTs: 0, readTs: 0 }
    }
  });
});

app.post('/api/message', auth, (req, res) => {
  const p = pairOf(req.uid);
  if (!p) return res.status(400).json({ error: 'not connected' });
  const env = req.body.env;
  if (!env || !env.id || !env.ct || !env.iv) return res.status(400).json({ error: 'bad envelope' });
  const rec = { id: String(env.id).slice(0, 40), ts: Date.now(), from: req.uid, ct: env.ct, iv: env.iv };
  const list = db.messages[p.pairId] || (db.messages[p.pairId] = []);
  list.push(rec);
  if (list.length > 20000) list.splice(0, list.length - 20000);
  save();
  send(p.peerUid, { t: 'msg', msg: rec });
  res.json({ ok: true, msg: rec });
});

app.post('/api/receipt', auth, (req, res) => {
  const p = pairOf(req.uid);
  if (!p) return res.status(400).json({ error: 'not connected' });
  const k = p.pairId + '~' + req.uid;
  const cur = db.receipts[k] || { deliveredTs: 0, readTs: 0 };
  cur.deliveredTs = Math.max(cur.deliveredTs, Number(req.body.deliveredTs) || 0);
  cur.readTs = Math.max(cur.readTs, Number(req.body.readTs) || 0);
  db.receipts[k] = cur; save();
  send(p.peerUid, { t: 'receipt', by: req.uid, receipt: cur });
  res.json({ ok: true });
});

/* ---------------------------------- files --------------------------------- */
app.post('/api/upload', auth, express.raw({ type: '*/*', limit: MAX_UPLOAD }), (req, res) => {
  const p = pairOf(req.uid);
  if (!p) return res.status(400).json({ error: 'not connected' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty' });
  const id = 'f_' + rid(20);
  fs.writeFile(path.join(UPLOADS, id), req.body, err => {
    if (err) return res.status(500).json({ error: 'write failed' });
    db.files[id] = { id, pairId: p.pairId, size: req.body.length, ts: Date.now() };
    save();
    res.json({ id });
  });
});

app.get('/api/file/:id', auth, (req, res) => {
  const f = db.files[req.params.id];
  const p = pairOf(req.uid);
  if (!f || !p || f.pairId !== p.pairId) return res.status(404).end();   // only the two paired users
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=31536000');
  fs.createReadStream(path.join(UPLOADS, f.id)).on('error', () => res.status(404).end()).pipe(res);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ------------------------------- websockets ------------------------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const live = new Map();                       // uid -> Set<ws>
const isOnline = uid => live.has(uid) && live.get(uid).size > 0;

function send(uid, obj) {
  const set = live.get(uid); if (!set) return;
  const s = JSON.stringify(obj);
  for (const ws of set) { try { ws.send(s); } catch (e) {} }
}
function notifyPresence(uid, online) {
  const p = db.pairs[uid]; if (!p) return;
  send(p.peerUid, { t: 'presence', uid, online, lastSeen: db.users[uid] ? db.users[uid].lastSeen : 0 });
}

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  const uid = Object.keys(db.users).find(u => db.users[u].token === token);
  if (!uid) { ws.close(4001, 'unauthorized'); return; }
  ws.uid = uid; ws.alive = true;
  if (!live.has(uid)) live.set(uid, new Set());
  live.get(uid).add(ws);
  db.users[uid].lastSeen = Date.now(); save();
  notifyPresence(uid, true);

  const p = db.pairs[uid];
  ws.send(JSON.stringify({ t: 'hello', peerOnline: p ? isOnline(p.peerUid) : false }));

  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const pair = db.pairs[ws.uid];
    if (!pair) return;
    if (m.t === 'typing') send(pair.peerUid, { t: 'typing', uid: ws.uid, on: !!m.on });
    else if (m.t === 'signal') send(pair.peerUid, { t: 'signal', from: ws.uid, d: m.d });   // WebRTC offer/answer/ICE
  });
  ws.on('close', () => {
    const set = live.get(uid); if (set) set.delete(ws);
    if (!isOnline(uid)) {
      db.users[uid].lastSeen = Date.now(); save();
      notifyPresence(uid, false);
    }
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false; try { ws.ping(); } catch (e) {}
  });
}, 30000);

server.listen(PORT, () => console.log('Duo listening on http://localhost:' + PORT));
