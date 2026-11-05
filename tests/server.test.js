'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { server } = require('../server.js');

let base;
test.before(() => new Promise(resolve => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  resolve();
})));
test.after(() => { server.closeAllConnections(); server.close(); });

async function post(path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

// Opens an SSE stream and resolves with the next state matching `pred`.
function subscribe(code, token) {
  const waiters = [];
  let latest = null;
  const req = http.get(`${base}/api/rooms/${code}/events?token=${token}`, res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!msg.startsWith('data: ')) continue;
        latest = JSON.parse(msg.slice(6));
        for (const w of waiters.splice(0)) if (!w.pred(latest)) waiters.push(w); else w.resolve(latest);
      }
    });
  });
  return {
    next(pred) {
      if (latest && pred(latest)) return Promise.resolve(latest);
      return new Promise(resolve => waiters.push({ pred, resolve }));
    },
    close() { req.destroy(); },
  };
}

test('two players create, join, start and play through setup', async () => {
  const host = await post('/api/rooms', { name: 'Host' });
  assert.strictEqual(host.status, 200);
  const code = host.body.code;
  const guest = await post(`/api/rooms/${code}/join`, { name: 'Host' });
  assert.strictEqual(guest.status, 200);

  const tokens = [host.body.token, guest.body.token];
  const streams = tokens.map(t => subscribe(code, t));
  const lobby = await streams[1].next(v => v.members.length === 2);
  assert.deepStrictEqual(lobby.members.map(m => m.name), ['Host', 'Host 2']);

  const notHost = await post(`/api/rooms/${code}/action`, { token: tokens[1], type: 'start' });
  assert.strictEqual(notHost.status, 400);
  await post(`/api/rooms/${code}/action`, { token: tokens[0], type: 'start' });

  const late = await post(`/api/rooms/${code}/join`, { name: 'Late' });
  assert.strictEqual(late.status, 409);

  // Out-of-turn moves are rejected.
  let v = await streams[1].next(s => s.started);
  const wrong = await post(`/api/rooms/${code}/action`, { token: tokens[1], type: 'placeSettlement', vertex: 0 });
  assert.strictEqual(wrong.status, 400);

  const placed = s => s.game.vertices.filter(x => x.building).length + s.game.edges.filter(e => e.road !== null).length;
  for (let step = 0; step < 8; step++) {
    const turn = step % 2 === 0 ? 'settlement' : 'road';
    v = await streams[0].next(s => s.game && placed(s) === step);
    const pi = v.game.current;
    const mine = await streams[pi].next(s => placed(s) === step);
    assert.strictEqual(mine.game.setupStep, turn);
    const legal = turn === 'settlement' ? mine.game.you.legal.settlements : mine.game.you.legal.roads;
    const r = await post(`/api/rooms/${code}/action`, {
      token: tokens[pi], type: turn === 'settlement' ? 'placeSettlement' : 'placeRoad',
      [turn === 'settlement' ? 'vertex' : 'edge']: legal[0],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  }

  v = await streams[0].next(s => s.game.phase === 'roll');
  assert.strictEqual(v.game.current, 0);
  // Each player sees only their own hand.
  const other = await streams[1].next(s => s.game.phase === 'roll');
  assert.strictEqual(other.game.you.index, 1);
  assert.ok(!('res' in other.game.players[0]));

  const roll = await post(`/api/rooms/${code}/action`, { token: tokens[0], type: 'rollDice' });
  assert.strictEqual(roll.status, 200);

  await post(`/api/rooms/${code}/action`, { token: tokens[1], type: 'chat', text: 'hi' });
  v = await streams[0].next(s => s.chat.length === 1);
  assert.strictEqual(v.chat[0].text, 'hi');

  streams.forEach(s => s.close());
});

test('static files are served and traversal is blocked', async () => {
  const page = await fetch(base + '/');
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /<title>Catan<\/title>/);
  const engine = await fetch(base + '/shared/engine.js');
  assert.strictEqual(engine.status, 200);
  const bad = await fetch(base + '/%2e%2e/server.js');
  assert.notStrictEqual(bad.status, 200);
});

test('rooms seat up to six players and start the 5-6 player board', async () => {
  const host = await post('/api/rooms', { name: 'H' });
  const code = host.body.code;
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await post(`/api/rooms/${code}/join`, { name: 'P' + i })).status, 200);
  }
  const seventh = await post(`/api/rooms/${code}/join`, { name: 'Late' });
  assert.strictEqual(seventh.status, 409);
  await post(`/api/rooms/${code}/action`, { token: host.body.token, type: 'start' });
  const s = subscribe(code, host.body.token);
  const v = await s.next(x => x.started);
  assert.strictEqual(v.game.players.length, 6);
  assert.strictEqual(v.game.tiles.length, 30);
  assert.strictEqual(v.game.bankSize, 24);
  s.close();
});

test('host controls settings, players pick unique colours, both carry into the game', async () => {
  const host = await post('/api/rooms', { name: 'H' });
  const code = host.body.code;
  const guest = await post(`/api/rooms/${code}/join`, { name: 'G' });
  const act = (token, body) => post(`/api/rooms/${code}/action`, { token, ...body });

  assert.strictEqual((await act(guest.body.token, { type: 'settings', settings: { turnTimer: 90 } })).status, 400);
  assert.strictEqual((await act(host.body.token, { type: 'settings', settings: { turnTimer: 90, balancedDice: true } })).status, 200);
  assert.strictEqual((await act(host.body.token, { type: 'color', color: '#2e8b45' })).status, 200);
  const clash = await act(guest.body.token, { type: 'color', color: '#2e8b45' });
  assert.strictEqual(clash.status, 400);
  assert.match(clash.body.error, /already has that color/);
  assert.strictEqual((await act(guest.body.token, { type: 'color', color: '#7b4a26' })).status, 200);

  await act(host.body.token, { type: 'start' });
  const s = subscribe(code, host.body.token);
  const v = await s.next(x => x.started);
  assert.deepStrictEqual(v.game.players.map(p => p.color), ['#2e8b45', '#7b4a26']);
  assert.deepStrictEqual(v.game.settings, { balancedDice: true, turnTimer: 90 });
  assert.ok(v.game.timer && v.game.timer.seconds === 60, 'opening placement runs on a 60s clock');
  assert.ok(v.game.timer.deadline > v.serverNow);
  assert.strictEqual((await act(host.body.token, { type: 'settings', settings: { turnTimer: 0 } })).status, 400, 'locked during play');
  s.close();
});

test('players can rename themselves in the lobby, with duplicate names numbered', async () => {
  const host = await post('/api/rooms', { name: 'Ana' });
  const code = host.body.code;
  const guest = await post(`/api/rooms/${code}/join`, { name: 'Bo' });
  const act = (token, body) => post(`/api/rooms/${code}/action`, { token, ...body });
  const s = subscribe(code, host.body.token);

  assert.strictEqual((await act(guest.body.token, { type: 'rename', name: '  Bo   Diddley ' })).status, 200);
  let v = await s.next(x => x.members[1].name === 'Bo Diddley');
  assert.strictEqual((await act(guest.body.token, { type: 'rename', name: 'ana' })).status, 200);
  v = await s.next(x => x.members[1].name !== 'Bo Diddley');
  assert.strictEqual(v.members[1].name, 'ana 2', 'clashing names are numbered');
  assert.strictEqual((await act(host.body.token, { type: 'rename', name: 'Ana' })).status, 200);
  v = await s.next(x => true);
  assert.strictEqual(v.members[0].name, 'Ana', 'keeping your own name is not a clash');
  assert.strictEqual((await act(guest.body.token, { type: 'rename', name: '   ' })).status, 400);

  await act(host.body.token, { type: 'start' });
  await s.next(x => x.started);
  assert.strictEqual((await act(guest.body.token, { type: 'rename', name: 'Late' })).status, 400, 'locked during play');
  s.close();
});
