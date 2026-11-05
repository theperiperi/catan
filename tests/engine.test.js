'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../shared/engine.js');

function pick(arr, rand) { return arr[Math.floor(rand() * arr.length)]; }

// Plays one legal action for whoever needs to act. Biased toward building so games progress.
function randomStep(g, rand) {
  if (g.phase === 'discard') {
    const pi = Number(Object.keys(g.discards)[0]);
    const p = g.players[pi], sel = C.cleanHand({});
    for (let k = 0; k < g.discards[pi]; k++) {
      const r = pick(C.RESOURCES.filter(r => p.res[r] - sel[r] > 0), rand);
      sel[r]++;
    }
    return C.discard(g, pi, sel);
  }
  const pi = g.current, p = g.players[pi];
  switch (g.phase) {
    case 'setup':
      return g.setup.step === 'settlement'
        ? C.placeSettlement(g, pick(C.legalSettlementSpots(g, pi), rand))
        : C.placeRoad(g, pick(C.legalRoadSpots(g, pi), rand));
    case 'roll':
      if (C.playableDev(g, pi).includes('knight') && rand() < 0.5) return C.playDev(g, 'knight');
      return C.rollDice(g);
    case 'robber':
      return C.moveRobber(g, pick(g.tiles.map((_, i) => i).filter(i => i !== g.robber), rand));
    case 'steal':
      return C.steal(g, pick(g.stealCandidates, rand));
    case 'roadBuilding':
      return C.placeRoad(g, pick(C.legalRoadSpots(g, pi), rand));
    case 'specialBuild': {
      const sets = C.legalSettlementSpots(g, pi), roads = C.legalRoadSpots(g, pi);
      if (sets.length && C.canAfford(p, C.COSTS.settlement)) return C.placeSettlement(g, pick(sets, rand));
      if (roads.length && C.canAfford(p, C.COSTS.road) && rand() < 0.5) return C.placeRoad(g, pick(roads, rand));
      return C.endTurn(g);
    }
    case 'main': {
      const cities = C.legalCitySpots(g, pi);
      if (cities.length && C.canAfford(p, C.COSTS.city)) return C.placeCity(g, pick(cities, rand));
      const sets = C.legalSettlementSpots(g, pi);
      if (sets.length && C.canAfford(p, C.COSTS.settlement)) return C.placeSettlement(g, pick(sets, rand));
      const roads = C.legalRoadSpots(g, pi);
      if (roads.length && C.canAfford(p, C.COSTS.road) && rand() < 0.7) return C.placeRoad(g, pick(roads, rand));
      if (g.devDeck.length && C.canAfford(p, C.COSTS.dev) && rand() < 0.5) return C.buyDevCard(g);
      const devs = C.playableDev(g, pi);
      if (devs.length && rand() < 0.5) {
        const d = pick(devs, rand);
        try {
          return C.playDev(g, d, { resources: ['ore', 'wheat'], resource: pick(C.RESOURCES, rand) });
        } catch (e) {
          if (!(e instanceof C.RuleError)) throw e; // bank short for Year of Plenty
        }
      }
      const give = C.RESOURCES.find(r => p.res[r] >= C.bankRate(g, pi, r));
      if (give && rand() < 0.6) {
        const get = C.RESOURCES.find(r => r !== give && g.bank[r] > 0);
        if (get) return C.tradeWithBank(g, give, get);
      }
      if (rand() < 0.1 && C.totalCards(p) > 0) {
        const r = C.RESOURCES.find(r => p.res[r] > 0);
        const want = C.RESOURCES.find(x => x !== r);
        C.proposeTrade(g, { [r]: 1 }, { [want]: 1 });
        const other = g.players.findIndex((q, i) => i !== pi && q.res[want] > 0);
        if (other >= 0) { C.respondTrade(g, other, true); return C.confirmTrade(g, other); }
        return C.cancelTrade(g);
      }
      return C.endTurn(g);
    }
  }
  throw new Error('stuck in phase ' + g.phase);
}

function checkInvariants(g) {
  for (const r of C.RESOURCES) {
    const total = g.bank[r] + g.players.reduce((s, p) => s + p.res[r], 0);
    assert.strictEqual(total, g.bankSize, `${r} not conserved`);
    g.players.forEach(p => assert.ok(p.res[r] >= 0, 'negative hand'));
  }
  const devs = g.devDeck.length + g.players.reduce((s, p) => s + p.dev.length + p.knights, 0);
  assert.ok(devs <= (g.players.length > 4 ? 34 : 25));
  g.players.forEach((p, i) => {
    const roads = g.edges.filter(e => e.road === i).length;
    assert.strictEqual(roads + p.roadsLeft, 15);
    const s = g.vertices.filter(v => v.building && v.building.owner === i && v.building.type === 'settlement').length;
    const c = g.vertices.filter(v => v.building && v.building.owner === i && v.building.type === 'city').length;
    assert.strictEqual(s + p.settlementsLeft, 5);
    assert.strictEqual(c + p.citiesLeft, 4);
  });
  g.vertices.forEach(V => {
    if (V.building) V.adj.forEach(a => assert.ok(!g.vertices[a].building, 'distance rule broken'));
  });
}

test('board has standard geometry', () => {
  const g = C.newGame(['a', 'b', 'c'], 1);
  assert.strictEqual(g.tiles.length, 19);
  assert.strictEqual(g.vertices.length, 54);
  assert.strictEqual(g.edges.length, 72);
  assert.strictEqual(g.ports.length, 9);
  assert.strictEqual(g.edges.filter(e => e.tiles.length === 1).length, 30);
  assert.strictEqual(g.tiles.filter(t => t.resource === 'desert').length, 1);
  assert.strictEqual(g.tiles[g.robber].resource, 'desert');
  const portVerts = g.vertices.filter(v => v.port).length;
  assert.strictEqual(portVerts, 18, 'ports must not share corners');
});

test('5-6 player games use the extension board, bank and deck', () => {
  for (const n of [5, 6]) {
    const g = C.newGame(Array.from({ length: n }, (_, i) => 'p' + i), n);
    assert.strictEqual(g.tiles.length, 30);
    assert.strictEqual(g.tiles.filter(t => t.resource === 'desert').length, 2);
    assert.strictEqual(g.tiles.filter(t => t.number).length, 28);
    assert.strictEqual(g.ports.length, 11);
    assert.strictEqual(g.vertices.filter(v => v.port).length, 22, 'ports must not share corners');
    assert.strictEqual(g.bank.ore, 24);
    assert.strictEqual(g.devDeck.length, 34);
  }
  assert.throws(() => C.newGame(Array(7).fill('x')), C.RuleError);
});

test('special building phase lets other players build between turns', () => {
  const g = C.newGame(['a', 'b', 'c', 'd', 'e'], 2);
  while (g.phase === 'setup') {
    C.placeSettlement(g, C.legalSettlementSpots(g, g.current)[0]);
    C.placeRoad(g, C.legalRoadSpots(g, g.current)[0]);
  }
  C.rollDice(g, [1, 1]);
  // Only player 3 can afford a road.
  g.players.forEach(p => C.RESOURCES.forEach(r => { g.bank[r] += p.res[r]; p.res[r] = 0; }));
  g.players[3].res.wood = 1; g.players[3].res.brick = 1;
  g.bank.wood--; g.bank.brick--;
  const bankBefore = { ...g.bank };
  C.endTurn(g);
  assert.strictEqual(g.phase, 'specialBuild');
  assert.strictEqual(g.current, 3, 'players who cannot build are skipped');
  assert.throws(() => C.tradeWithBank(g, 'wood', 'ore'), C.RuleError);
  C.placeRoad(g, C.legalRoadSpots(g, 3)[0]);
  assert.strictEqual(g.bank.wood, bankBefore.wood + 1);
  C.endTurn(g);
  assert.strictEqual(g.phase, 'roll');
  assert.strictEqual(g.current, 1, 'play continues with the next player');
});

test('6s and 8s are never adjacent', () => {
  for (let seed = 0; seed < 200; seed++) {
    const g = C.newGame(Array(seed % 2 ? 2 : 6).fill('p'), seed);
    g.tiles.forEach(t => {
      if (t.number === 6 || t.number === 8) {
        t.neighbors.forEach(n => assert.ok(![6, 8].includes(g.tiles[n].number), `seed ${seed}`));
      }
    });
  }
});

test('setup runs in snake order and pays out the second settlement', () => {
  const g = C.newGame(['a', 'b', 'c'], 7);
  const order = [];
  while (g.phase === 'setup') {
    order.push(g.current);
    C.placeSettlement(g, C.legalSettlementSpots(g, g.current)[0]);
    C.placeRoad(g, C.legalRoadSpots(g, g.current)[0]);
  }
  assert.deepStrictEqual(order, [0, 1, 2, 2, 1, 0]);
  assert.strictEqual(g.phase, 'roll');
  assert.ok(g.players.some(p => C.totalCards(p) > 0));
});

test('rolling a 7 makes big hands discard half, then robber, then steal', () => {
  const g = C.newGame(['a', 'b'], 3);
  while (g.phase === 'setup') {
    C.placeSettlement(g, C.legalSettlementSpots(g, g.current)[0]);
    C.placeRoad(g, C.legalRoadSpots(g, g.current)[0]);
  }
  // Give player 1 a 9-card hand (returning setup income to the bank first).
  C.RESOURCES.forEach(r => { g.bank[r] += g.players[1].res[r]; });
  g.players[1].res = { wood: 3, brick: 3, sheep: 3, wheat: 0, ore: 0 };
  g.bank.wood -= 3; g.bank.brick -= 3; g.bank.sheep -= 3;
  // And a settlement on a tile player 0 doesn't touch, so there's exactly one victim.
  const target = g.tiles.findIndex((t, i) => i !== g.robber &&
    !t.verts.some(v => g.vertices[v].building) && t.verts.some(v => C.isVertexOpen(g, v)));
  g.vertices[g.tiles[target].verts.find(v => C.isVertexOpen(g, v))].building = { owner: 1, type: 'settlement' };
  g.players[1].settlementsLeft--;
  C.rollDice(g, [3, 4]);
  assert.strictEqual(g.phase, 'discard');
  assert.strictEqual(g.discards[1], 4);
  assert.throws(() => C.discard(g, 1, { wood: 1 }), C.RuleError);
  C.discard(g, 1, { wood: 2, brick: 2 });
  assert.strictEqual(g.phase, 'robber');
  const before = C.totalCards(g.players[0]);
  C.moveRobber(g, target);
  assert.strictEqual(C.totalCards(g.players[0]), before + 1);
  assert.strictEqual(g.phase, 'main');
  checkInvariants(g);
});

test('longest road is awarded at 5 and broken by an opponent settlement', () => {
  const g = C.newGame(['a', 'b'], 11);
  g.phase = 'main';
  g.turn = 1;
  // Walk a simple 7-vertex path (6 edges) along vertex adjacency.
  function walk(path) {
    if (path.length === 7) return path;
    for (const a of g.vertices[path[path.length - 1]].adj) {
      if (path.includes(a)) continue;
      const found = walk([...path, a]);
      if (found) return found;
    }
    return null;
  }
  const path = walk([0]);
  g.vertices[path[0]].building = { owner: 0, type: 'settlement' };
  for (let i = 0; i < 6; i++) {
    const e = g.vertices[path[i]].edges.find(e => g.edges[e].v.includes(path[i + 1]));
    g.players[0].res.wood++; g.players[0].res.brick++;
    g.bank.wood--; g.bank.brick--;
    C.placeRoad(g, e);
  }
  assert.strictEqual(C.longestRoadFor(g, 0), 6);
  assert.strictEqual(g.longestRoadHolder, 0);
  // Opponent settles in the middle of the road.
  g.current = 1;
  g.vertices[path[3]].building = { owner: 1, type: 'settlement' };
  g.players[1].settlementsLeft--;
  assert.strictEqual(C.longestRoadFor(g, 0), 3);
});

test('view hides other hands and secret dev cards', () => {
  const g = C.newGame(['a', 'b'], 5);
  g.players[1].res.ore = 3;
  g.players[1].dev.push({ type: 'victoryPoint', turn: 0 });
  const v = C.viewFor(g, 0);
  assert.strictEqual(v.you.index, 0);
  assert.strictEqual(v.players[1].cards, 3);
  assert.strictEqual(v.players[1].vp, 0);
  assert.ok(!('res' in v.players[1]) && !('dev' in v.players[1]));
  assert.ok(!JSON.stringify(v).includes('victoryPoint'));
});

test('random games stay consistent and finish', () => {
  let finished = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const n = 2 + (seed % 5);
    const g = C.newGame(Array.from({ length: n }, (_, i) => 'p' + i), seed);
    const rand = (() => { let s = seed * 9973; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    for (let step = 0; step < 20000 && g.phase !== 'over'; step++) {
      randomStep(g, rand);
      checkInvariants(g);
    }
    if (g.phase === 'over') {
      finished++;
      assert.ok(C.victoryPoints(g, g.winner, true) >= 10);
    }
  }
  assert.ok(finished >= 30, `only ${finished}/40 games finished`);
});

// A bare game state for exercising the dice on their own.
function diceState(players, seed) {
  return { diceDeck: [], lastRoll: null, sevens: Array(players).fill(0), players: Array(players).fill({}), current: 0, rand: C.newGame(['a', 'b'], seed).rand };
}
const SUM_ODDS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

test('balanced dice draw distinct combinations and rebuild the deck at 12 left', () => {
  const g = diceState(4, 3);
  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    const [a, b] = C.drawBalanced(g);
    seen.add(`${a},${b}`);
    g.lastRoll = a + b;
  }
  assert.strictEqual(seen.size, 24, 'no combination repeats before the reshuffle');
  assert.strictEqual(g.diceDeck.length, C.DICE_RESHUFFLE_AT);
  C.drawBalanced(g);
  assert.strictEqual(g.diceDeck.length, 35, 'a fresh 36-card deck is used once 12 remain');
});

test('balanced dice track the board odds and repeat totals less than real dice', () => {
  const g = diceState(4, 21);
  const counts = {}, N = 72000;
  let repeats = 0;
  for (let i = 0; i < N; i++) {
    const [a, b] = C.drawBalanced(g);
    const sum = a + b;
    if (sum === g.lastRoll) repeats++;
    g.lastRoll = sum;
    counts[sum] = (counts[sum] || 0) + 1;
    g.current = (g.current + 1) % 4;
  }
  for (const [sum, ways] of Object.entries(SUM_ODDS)) {
    const expected = (N * ways) / 36;
    assert.ok(Math.abs(counts[sum] - expected) / expected < 0.12, `total ${sum}: ${counts[sum]} vs ~${Math.round(expected)}`);
  }
  // Independent dice repeat the previous total 146/1296 ≈ 11.3% of the time.
  assert.ok(repeats / N < 0.09, `repeat rate ${(repeats / N).toFixed(3)} should be well below 0.113`);
});

test('in 2-player games balanced dice even out sevens between the players', () => {
  const g = diceState(2, 8);
  for (let i = 0; i < 20000; i++) {
    const [a, b] = C.drawBalanced(g);
    g.lastRoll = a + b;
    if (a + b === 7) g.sevens[g.current]++;
    g.current = 1 - g.current;
  }
  const [s0, s1] = g.sevens;
  assert.ok(Math.abs(s0 - s1) <= 6, `sevens split ${s0}/${s1}`);
  assert.ok(Math.abs(s0 + s1 - 20000 / 6) / (20000 / 6) < 0.12, 'sevens still come up about 1 in 6 overall');
});

test('balanced dice are used by rollDice when enabled', () => {
  const g = C.newGame(['a', 'b'], 9, { balancedDice: true });
  while (g.phase === 'setup') C.forceTimeout(Object.assign(g, { settings: { ...g.settings, turnTimer: 60 } }));
  C.rollDice(g);
  assert.strictEqual(g.diceDeck.length, 35);
  assert.strictEqual(g.lastRoll, g.dice[0] + g.dice[1]);
});

test('settings are sanitised and colours are applied', () => {
  assert.deepStrictEqual(C.cleanSettings({ balancedDice: 'yes', turnTimer: 77 }), { balancedDice: true, turnTimer: 0 });
  const g = C.newGame(['a', 'b'], 1, { colors: ['#2e8b45', '#c8262f'], turnTimer: 90 });
  assert.deepStrictEqual(g.players.map(p => p.color), ['#2e8b45', '#c8262f']);
  assert.strictEqual(g.settings.turnTimer, 90);
  const dupes = C.newGame(['a', 'b'], 1, { colors: ['#c8262f', '#c8262f'] });
  assert.deepStrictEqual(dupes.players.map(p => p.color), C.PLAYER_COLORS.slice(0, 2), 'invalid colour lists fall back');
});

test('the turn timer gives 60s per opening placement and the full timer per turn', () => {
  const g = C.newGame(['a', 'b', 'c'], 4, { turnTimer: 120 });
  assert.strictEqual(C.syncTimer(g, 1000), 1000 + 60000);
  assert.strictEqual(C.syncTimer(g, 5000), 61000, 'same placement keeps its deadline');
  C.forceTimeout(g);
  assert.strictEqual(g.vertices.filter(v => v.building).length, 1, 'timeout placed a settlement');
  assert.strictEqual(g.edges.filter(e => e.road !== null).length, 1, 'and its road');
  assert.strictEqual(g.current, 1);
  assert.strictEqual(C.syncTimer(g, 9000), 69000, 'next placement gets a fresh 60s');
  while (g.phase === 'setup') C.forceTimeout(g);
  assert.strictEqual(g.phase, 'roll');
  assert.strictEqual(C.syncTimer(g, 100000), 100000 + 120000);
  C.forceTimeout(g);
  assert.strictEqual(g.current, 1, 'a timed-out turn is rolled and ended');
  assert.strictEqual(g.phase, 'roll');
  checkInvariants(g);
});

test('timeouts during discards, robber and trades still end the turn cleanly', () => {
  const g = C.newGame(['a', 'b'], 12, { turnTimer: 60 });
  while (g.phase === 'setup') C.forceTimeout(g);
  C.RESOURCES.forEach(r => { g.bank[r] += g.players[1].res[r]; });
  g.players[1].res = { wood: 4, brick: 4, sheep: 2, wheat: 0, ore: 0 };
  g.bank.wood -= 4; g.bank.brick -= 4; g.bank.sheep -= 2;
  C.rollDice(g, [6, 1]);
  assert.strictEqual(g.phase, 'discard');
  C.forceTimeout(g);
  assert.strictEqual(C.totalCards(g.players[1]) <= 6, true, 'the pending discard was made');
  assert.strictEqual(g.current, 1);
  assert.strictEqual(g.phase, 'roll');
  checkInvariants(g);
});

test('random games with balanced dice and frequent timeouts stay consistent', () => {
  for (let seed = 50; seed < 62; seed++) {
    const n = 2 + (seed % 5);
    const g = C.newGame(Array.from({ length: n }, (_, i) => 'p' + i), seed, { balancedDice: true, turnTimer: 60 });
    const rand = (() => { let s = seed * 7919; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    for (let step = 0; step < 6000 && g.phase !== 'over'; step++) {
      if (rand() < 0.05) C.forceTimeout(g); else randomStep(g, rand);
      checkInvariants(g);
    }
  }
});
