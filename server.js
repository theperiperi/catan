// Catan multiplayer server. No dependencies: `node server.js`, then share the printed URL.
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const C = require('./shared/engine.js');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const STATIC = { '/': 'public', '/shared/': 'shared' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name, room) {
  let n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20) || `Player ${room.members.length + 1}`;
  const taken = new Set(room.members.map(m => m.name.toLowerCase()));
  for (let i = 2, base = n; taken.has(n.toLowerCase()); i++) n = `${base} ${i}`;
  return n;
}

function addMember(room, name) {
  const member = { token: crypto.randomBytes(16).toString('hex'), name: cleanName(name, room), connections: 0 };
  room.members.push(member);
  return member;
}

function memberIndex(room, token) {
  return room.members.findIndex(m => m.token === token);
}

function roomView(room, pi) {
  return {
    code: room.code,
    you: pi,
    members: room.members.map((m, i) => ({ name: m.name, color: C.PLAYER_COLORS[i], connected: m.connections > 0 })),
    started: !!room.game,
    chat: room.chat.slice(-60),
    game: room.game ? C.viewFor(room.game, pi) : null,
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const client of room.clients) {
    client.res.write(`data: ${JSON.stringify(roomView(room, client.pi))}\n\n`);
  }
}

// Actions the current player takes on their turn.
const TURN_ACTIONS = {
  rollDice: g => C.rollDice(g),
  placeSettlement: (g, a) => C.placeSettlement(g, a.vertex),
  placeRoad: (g, a) => C.placeRoad(g, a.edge),
  placeCity: (g, a) => C.placeCity(g, a.vertex),
  moveRobber: (g, a) => C.moveRobber(g, a.tile),
  steal: (g, a) => C.steal(g, a.victim),
  buyDevCard: g => C.buyDevCard(g),
  playDev: (g, a) => C.playDev(g, a.card, { resources: a.resources, resource: a.resource }),
  tradeBank: (g, a) => C.tradeWithBank(g, a.give, a.get),
  proposeTrade: (g, a) => C.proposeTrade(g, a.give, a.get),
  confirmTrade: (g, a) => C.confirmTrade(g, a.with),
  cancelTrade: g => C.cancelTrade(g),
  endTurn: g => C.endTurn(g),
};

// Actions any seated player may take.
const ANY_ACTIONS = {
  discard: (g, a, pi) => C.discard(g, pi, a.cards),
  respondTrade: (g, a, pi) => C.respondTrade(g, pi, !!a.accept),
};

function handleAction(room, pi, a) {
  const type = a && a.type;
  if (type === 'chat') {
    const text = String(a.text || '').trim().slice(0, 300);
    if (text) room.chat.push({ pi, name: room.members[pi].name, text, at: Date.now() });
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
    return;
  }
  if (type === 'start' || type === 'newGame') {
    if (pi !== 0) throw new C.RuleError('Only the host can start the game.');
    if (room.game && room.game.phase !== 'over') throw new C.RuleError('The game is already running.');
    room.game = C.newGame(room.members.map(m => m.name));
    return;
  }
  const g = room.game;
  if (!g) throw new C.RuleError('The game hasn’t started yet.');
  if (ANY_ACTIONS[type]) return ANY_ACTIONS[type](g, a, pi);
  if (TURN_ACTIONS[type]) {
    if (pi !== g.current) throw new C.RuleError('It’s not your turn.');
    return TURN_ACTIONS[type](g, a);
  }
  throw new C.RuleError('Unknown action.');
}

// ---------- HTTP ----------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 16 * 1024) { reject(new C.RuleError('Request too large.')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new C.RuleError('Bad JSON.')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const prefix = pathname.startsWith('/shared/') ? '/shared/' : '/';
  const baseDir = path.join(__dirname, STATIC[prefix]);
  let rel = decodeURIComponent(pathname.slice(prefix.length));
  if (rel === '') rel = 'index.html';
  const file = path.resolve(baseDir, rel);
  if (!file.startsWith(baseDir + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => `http://${i.address}:${PORT}`);
}

function openEvents(req, res, room, pi) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const client = { res, pi };
  room.clients.add(client);
  if (pi >= 0) room.members[pi].connections++;
  broadcast(room);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    room.clients.delete(client);
    if (pi >= 0) room.members[pi].connections--;
    broadcast(room);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'api') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, url.pathname);
  }

  if (req.method === 'GET' && parts[1] === 'info') return sendJson(res, 200, { lanUrls: lanUrls() });

  if (req.method === 'POST' && parts[1] === 'rooms' && parts.length === 2) {
    const body = await readJson(req);
    const room = { code: makeCode(), members: [], game: null, chat: [], clients: new Set(), lastActive: Date.now() };
    rooms.set(room.code, room);
    const m = addMember(room, body.name);
    return sendJson(res, 200, { code: room.code, token: m.token });
  }

  if (parts[1] !== 'rooms' || !parts[2]) return sendJson(res, 404, { error: 'Not found' });
  const room = rooms.get(parts[2].toUpperCase());
  if (!room) return sendJson(res, 404, { error: 'That game doesn’t exist (or the server restarted).' });
  const token = url.searchParams.get('token') || '';
  const action = parts[3];

  if (req.method === 'GET' && !action) {
    return sendJson(res, 200, { code: room.code, started: !!room.game, you: memberIndex(room, token) });
  }

  if (req.method === 'GET' && action === 'events') {
    return openEvents(req, res, room, memberIndex(room, token));
  }

  if (req.method === 'POST' && action === 'join') {
    const body = await readJson(req);
    if (room.game) return sendJson(res, 409, { error: 'That game has already started.' });
    if (room.members.length >= C.MAX_PLAYERS) return sendJson(res, 409, { error: 'That game is full.' });
    const m = addMember(room, body.name);
    broadcast(room);
    return sendJson(res, 200, { code: room.code, token: m.token });
  }

  if (req.method === 'POST' && action === 'action') {
    const body = await readJson(req);
    const pi = memberIndex(room, body.token);
    if (pi < 0) return sendJson(res, 403, { error: 'You’re not in this game.' });
    handleAction(room, pi, body);
    broadcast(room);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => {
    if (err instanceof C.RuleError) return sendJson(res, 400, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Server error.' });
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && now - room.lastActive > ROOM_TTL_MS) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Catan server running.`);
    console.log(`  On this computer:  http://localhost:${PORT}`);
    lanUrls().forEach(u => console.log(`  Same Wi-Fi:        ${u}`));
  });
}

module.exports = { server, rooms };
