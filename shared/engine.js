// Catan rules engine. Pure game logic, shared by the server (authoritative)
// and the browser (constants only).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Catan = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
  const RES_NAME = { wood: 'Wood', brick: 'Brick', sheep: 'Sheep', wheat: 'Wheat', ore: 'Ore' };
  const COSTS = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { wheat: 2, ore: 3 },
    dev: { sheep: 1, wheat: 1, ore: 1 },
  };
  const PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
  const DEV_INFO = {
    knight: { name: 'Knight', text: 'Move the robber and steal a card.' },
    roadBuilding: { name: 'Road Building', text: 'Place 2 free roads.' },
    yearOfPlenty: { name: 'Year of Plenty', text: 'Take any 2 resources from the bank.' },
    monopoly: { name: 'Monopoly', text: 'Take every card of one resource from all players.' },
    victoryPoint: { name: 'Victory Point', text: '+1 VP, kept secret.' },
  };
  const PLAYER_COLORS = ['#e04848', '#3b73d9', '#f2f2f2', '#f08c2a', '#9b59d0', '#25b5a8'];
  const WIN_POINTS = 10;
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 6;

  // Base game for 2-4 players; the 5-6 player extension for more.
  const EDITIONS = {
    base: {
      rows: [3, 4, 5, 4, 3],
      terrain: { wood: 4, sheep: 4, wheat: 4, brick: 3, ore: 3, desert: 1 },
      numbers: [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12],
      ports: ['any', 'any', 'any', 'any', ...RESOURCES],
      bank: 19,
      dev: { knight: 14, victoryPoint: 5, roadBuilding: 2, yearOfPlenty: 2, monopoly: 2 },
      specialBuild: false,
    },
    extended: {
      rows: [3, 4, 5, 6, 5, 4, 3],
      terrain: { wood: 6, sheep: 6, wheat: 6, brick: 5, ore: 5, desert: 2 },
      numbers: [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12],
      ports: ['any', 'any', 'any', 'any', 'any', ...RESOURCES, 'sheep'],
      bank: 24,
      dev: { knight: 20, victoryPoint: 5, roadBuilding: 3, yearOfPlenty: 3, monopoly: 3 },
      specialBuild: true,
    },
  };

  class RuleError extends Error {}
  function fail(msg) { throw new RuleError(msg); }

  // ---------- helpers ----------

  function makeRng(seed) { // mulberry32
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function emptyHand() { return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; }

  // Sanitize an untrusted {resource: count} object.
  function cleanHand(obj) {
    const h = emptyHand();
    if (obj && typeof obj === 'object') {
      for (const r of RESOURCES) {
        const n = Math.floor(Number(obj[r]));
        h[r] = Number.isFinite(n) ? Math.max(0, Math.min(19, n)) : 0;
      }
    }
    return h;
  }

  function countHand(h) { return RESOURCES.reduce((s, r) => s + (h[r] || 0), 0); }
  function totalCards(p) { return countHand(p.res); }
  function canAfford(p, cost) { return Object.keys(cost).every(r => p.res[r] >= cost[r]); }

  function pay(g, p, cost) {
    for (const r of RESOURCES) {
      if (!cost[r]) continue;
      p.res[r] -= cost[r];
      g.bank[r] += cost[r];
    }
  }

  function take(g, p, r, n) {
    const k = Math.min(n, g.bank[r]);
    p.res[r] += k;
    g.bank[r] -= k;
    return k;
  }

  // Messages mark resources as {wood}, {ore}, …; the client draws them as glyphs.
  function tok(r) { return `{${r}}`; }

  function fmtRes(h) {
    const parts = RESOURCES.filter(r => h[r]).map(r => `${h[r]} ${tok(r)}`);
    return parts.length ? parts.join(' ') : 'nothing';
  }

  function log(g, text, pi, secret) {
    g.log.push({ text, pi: pi === undefined ? null : pi, secret: secret || null });
    if (g.log.length > 300) g.log.splice(0, g.log.length - 300);
  }

  // ---------- board ----------

  function buildBoard(rand, ed) {
    const SQ3 = Math.sqrt(3);
    const tiles = [];
    ed.rows.forEach((len, row) => {
      for (let i = 0; i < len; i++) {
        tiles.push({ x: SQ3 * (i - (len - 1) / 2), y: 1.5 * (row - (ed.rows.length - 1) / 2) });
      }
    });

    const vertices = [], edges = [];
    const vmap = new Map(), emap = new Map();
    tiles.forEach((t, ti) => {
      t.verts = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i - 30);
        const x = t.x + Math.cos(a), y = t.y + Math.sin(a);
        const k = Math.round(x * 1000) + ',' + Math.round(y * 1000);
        let vi = vmap.get(k);
        if (vi === undefined) {
          vi = vertices.length;
          vmap.set(k, vi);
          vertices.push({ id: vi, x, y, tiles: [], edges: [], adj: [], port: null, building: null });
        }
        vertices[vi].tiles.push(ti);
        t.verts.push(vi);
      }
      for (let i = 0; i < 6; i++) {
        const a = t.verts[i], b = t.verts[(i + 1) % 6];
        const k = a < b ? a + '-' + b : b + '-' + a;
        let ei = emap.get(k);
        if (ei === undefined) {
          ei = edges.length;
          emap.set(k, ei);
          edges.push({ id: ei, v: [a, b], tiles: [], road: null });
          vertices[a].edges.push(ei);
          vertices[b].edges.push(ei);
          vertices[a].adj.push(b);
          vertices[b].adj.push(a);
        }
        edges[ei].tiles.push(ti);
      }
    });

    tiles.forEach(t => { t.neighbors = []; });
    edges.forEach(e => {
      if (e.tiles.length === 2) {
        tiles[e.tiles[0]].neighbors.push(e.tiles[1]);
        tiles[e.tiles[1]].neighbors.push(e.tiles[0]);
      }
    });

    const terrain = shuffle(Object.entries(ed.terrain).flatMap(([t, n]) => Array(n).fill(t)), rand);
    tiles.forEach((t, i) => { t.resource = terrain[i]; });

    // Number tokens, re-shuffled until no two red numbers (6/8) touch.
    const nums = ed.numbers.slice();
    const isRed = n => n === 6 || n === 8;
    for (let attempt = 0; attempt < 5000; attempt++) {
      shuffle(nums, rand);
      let k = 0;
      tiles.forEach(t => { t.number = t.resource === 'desert' ? null : nums[k++]; });
      if (tiles.every(t => !isRed(t.number) || t.neighbors.every(n => !isRed(tiles[n].number)))) break;
    }

    // Ports spread evenly around the coast (never sharing a corner).
    const coastal = edges
      .filter(e => e.tiles.length === 1)
      .map(e => {
        const a = vertices[e.v[0]], b = vertices[e.v[1]];
        return { e, ang: Math.atan2((a.y + b.y) / 2, (a.x + b.x) / 2) };
      })
      .sort((p, q) => p.ang - q.ang)
      .map(p => p.e);
    const portTypes = shuffle(ed.ports.slice(), rand);
    const ports = portTypes.map((type, i) => {
      const e = coastal[Math.floor((i * coastal.length) / portTypes.length)];
      e.v.forEach(v => { vertices[v].port = type; });
      return { edge: e.id, type };
    });

    return { tiles, vertices, edges, ports };
  }

  // ---------- game setup ----------

  function newGame(names, seed) {
    const n = names.length;
    if (n < MIN_PLAYERS || n > MAX_PLAYERS) fail(`Catan needs ${MIN_PLAYERS}-${MAX_PLAYERS} players.`);
    const rand = makeRng(seed === undefined ? Math.floor(Math.random() * 2 ** 32) : seed);
    const ed = n > 4 ? EDITIONS.extended : EDITIONS.base;
    const board = buildBoard(rand, ed);
    const players = names.map((name, i) => ({
      name, color: PLAYER_COLORS[i], res: emptyHand(), dev: [], knights: 0,
      roadsLeft: 15, settlementsLeft: 5, citiesLeft: 4, playedDevThisTurn: false,
    }));
    const order = [...Array(n).keys()];
    const devDeck = shuffle(Object.entries(ed.dev).flatMap(([t, k]) => Array(k).fill(t)), rand);
    const g = {
      ...board,
      robber: board.tiles.findIndex(t => t.resource === 'desert'),
      players,
      bank: Object.fromEntries(RESOURCES.map(r => [r, ed.bank])),
      bankSize: ed.bank,
      specialBuild: ed.specialBuild ? { turnPlayer: null, queue: [] } : null,
      devDeck,
      current: 0,
      turn: 0,
      phase: 'setup',
      setup: { order: [...order, ...order.slice().reverse()], idx: 0, step: 'settlement', lastVertex: null },
      dice: null,
      discards: {},
      stealCandidates: [],
      afterRobber: 'main',
      freeRoads: 0,
      trade: null,
      roadLengths: Array(n).fill(0),
      longestRoadHolder: null,
      largestArmyHolder: null,
      winner: null,
      log: [],
      rand,
    };
    log(g, `Game started. ${players[0].name} places first.`);
    return g;
  }

  // ---------- legality ----------

  function requireMain(g) { if (g.phase !== 'main') fail('You can’t do that right now.'); }
  function requireBuild(g) { if (g.phase !== 'main' && g.phase !== 'specialBuild') fail('You can’t build right now.'); }

  function isVertexOpen(g, v) {
    const V = g.vertices[v];
    return !!V && !V.building && V.adj.every(a => !g.vertices[a].building);
  }

  function legalSettlementSpots(g, pi) {
    if (g.players[pi].settlementsLeft <= 0) return [];
    const setup = g.phase === 'setup';
    return g.vertices
      .filter(V => isVertexOpen(g, V.id) && (setup || V.edges.some(e => g.edges[e].road === pi)))
      .map(V => V.id);
  }

  function legalCitySpots(g, pi) {
    if (g.players[pi].citiesLeft <= 0) return [];
    return g.vertices
      .filter(V => V.building && V.building.owner === pi && V.building.type === 'settlement')
      .map(V => V.id);
  }

  // Can player pi extend a road out of vertex v (without using edge `except`)?
  function canExtendFrom(g, pi, v, except) {
    const V = g.vertices[v];
    if (V.building) return V.building.owner === pi;
    return V.edges.some(e => e !== except && g.edges[e].road === pi);
  }

  function legalRoadSpots(g, pi) {
    if (g.players[pi].roadsLeft <= 0) return [];
    if (g.phase === 'setup') {
      if (g.setup.step !== 'road') return [];
      return g.vertices[g.setup.lastVertex].edges.filter(e => g.edges[e].road === null);
    }
    return g.edges
      .filter(E => E.road === null && E.v.some(v => canExtendFrom(g, pi, v, E.id)))
      .map(E => E.id);
  }

  function bankRate(g, pi, r) {
    let rate = 4;
    for (const V of g.vertices) {
      if (!V.building || V.building.owner !== pi || !V.port) continue;
      if (V.port === r) rate = 2;
      else if (V.port === 'any') rate = Math.min(rate, 3);
    }
    return rate;
  }

  function playableDev(g, pi) {
    const p = g.players[pi];
    if (pi !== g.current || p.playedDevThisTurn) return [];
    if (g.phase !== 'main' && g.phase !== 'roll') return [];
    const types = new Set(p.dev.filter(c => c.type !== 'victoryPoint' && c.turn < g.turn).map(c => c.type));
    if (g.phase === 'roll') return types.has('knight') ? ['knight'] : [];
    if (types.has('roadBuilding') && legalRoadSpots(g, pi).length === 0) types.delete('roadBuilding');
    return [...types];
  }

  // ---------- scoring ----------

  function longestRoadFor(g, pi) {
    let best = 0;
    const used = new Set();
    function dfs(v, len) {
      if (len > best) best = len;
      const V = g.vertices[v];
      if (len > 0 && V.building && V.building.owner !== pi) return; // opponent breaks the road
      for (const e of V.edges) {
        const E = g.edges[e];
        if (E.road !== pi || used.has(e)) continue;
        used.add(e);
        dfs(E.v[0] === v ? E.v[1] : E.v[0], len + 1);
        used.delete(e);
      }
    }
    g.vertices.forEach(V => {
      if (V.edges.some(e => g.edges[e].road === pi)) dfs(V.id, 0);
    });
    return best;
  }

  function updateLongestRoad(g) {
    g.roadLengths = g.players.map((_, i) => longestRoadFor(g, i));
    const max = Math.max(...g.roadLengths);
    const holder = g.longestRoadHolder;
    if (holder !== null && g.roadLengths[holder] === max && max >= 5) return;
    const leaders = g.roadLengths.map((l, i) => (l === max ? i : -1)).filter(i => i >= 0);
    const next = max >= 5 && leaders.length === 1 ? leaders[0] : null;
    if (next !== holder) {
      g.longestRoadHolder = next;
      if (next !== null) log(g, `${g.players[next].name} now has the Longest Road (${max}).`, next);
      else log(g, 'Nobody holds the Longest Road now.');
    }
  }

  function updateLargestArmy(g) {
    const pi = g.current, p = g.players[pi], h = g.largestArmyHolder;
    if (h === pi) return;
    const toBeat = h === null ? 2 : g.players[h].knights;
    if (p.knights > toBeat) {
      g.largestArmyHolder = pi;
      log(g, `${p.name} now has the Largest Army (${p.knights}).`, pi);
    }
  }

  function victoryPoints(g, pi, includeHidden) {
    let vp = 0;
    for (const V of g.vertices) {
      if (V.building && V.building.owner === pi) vp += V.building.type === 'city' ? 2 : 1;
    }
    if (g.longestRoadHolder === pi) vp += 2;
    if (g.largestArmyHolder === pi) vp += 2;
    if (includeHidden) vp += g.players[pi].dev.filter(c => c.type === 'victoryPoint').length;
    return vp;
  }

  // You can only win on your own turn (not during someone else's special build).
  function checkWin(g) {
    if (g.phase === 'over' || g.phase === 'setup' || g.phase === 'specialBuild') return;
    if (victoryPoints(g, g.current, true) >= WIN_POINTS) {
      g.phase = 'over';
      g.winner = g.current;
      g.trade = null;
      log(g, `${g.players[g.current].name} wins with ${victoryPoints(g, g.current, true)} points!`, g.current);
    }
  }

  // ---------- actions (all act as the current player unless noted) ----------

  function placeSettlement(g, v) {
    const pi = g.current, p = g.players[pi], V = g.vertices[v];
    if (g.phase === 'setup') {
      if (g.setup.step !== 'settlement' || !isVertexOpen(g, v)) fail('You can’t build a settlement there.');
      V.building = { owner: pi, type: 'settlement' };
      p.settlementsLeft--;
      g.setup.lastVertex = v;
      g.setup.step = 'road';
      if (g.setup.idx >= g.players.length) {
        const got = emptyHand();
        V.tiles.forEach(t => {
          const T = g.tiles[t];
          if (T.resource !== 'desert') got[T.resource] += take(g, p, T.resource, 1);
        });
        log(g, `${p.name} placed a settlement and collected ${fmtRes(got)}.`, pi);
      } else {
        log(g, `${p.name} placed a settlement.`, pi);
      }
      updateLongestRoad(g);
      return;
    }
    requireBuild(g);
    if (!legalSettlementSpots(g, pi).includes(v)) fail('You can’t build a settlement there.');
    if (!canAfford(p, COSTS.settlement)) fail('Not enough resources for a settlement.');
    pay(g, p, COSTS.settlement);
    V.building = { owner: pi, type: 'settlement' };
    p.settlementsLeft--;
    log(g, `${p.name} built a settlement.`, pi);
    updateLongestRoad(g);
    checkWin(g);
  }

  function placeCity(g, v) {
    const pi = g.current, p = g.players[pi];
    requireBuild(g);
    if (!legalCitySpots(g, pi).includes(v)) fail('You can only upgrade your own settlements.');
    if (!canAfford(p, COSTS.city)) fail('Not enough resources for a city.');
    pay(g, p, COSTS.city);
    g.vertices[v].building.type = 'city';
    p.citiesLeft--;
    p.settlementsLeft++;
    log(g, `${p.name} built a city.`, pi);
    checkWin(g);
  }

  function placeRoad(g, e) {
    const pi = g.current, p = g.players[pi];
    if (!['setup', 'main', 'specialBuild', 'roadBuilding'].includes(g.phase)) fail('You can’t build a road right now.');
    if (!legalRoadSpots(g, pi).includes(e)) fail('You can’t build a road there.');
    if (g.phase === 'setup') {
      g.edges[e].road = pi;
      p.roadsLeft--;
      g.setup.idx++;
      g.setup.step = 'settlement';
      g.setup.lastVertex = null;
      updateLongestRoad(g);
      if (g.setup.idx >= g.setup.order.length) {
        g.phase = 'roll';
        g.current = 0;
        g.turn = 1;
        log(g, `Setup complete. ${g.players[0].name}'s turn.`, 0);
      } else {
        g.current = g.setup.order[g.setup.idx];
      }
      return;
    }
    if (g.phase === 'roadBuilding') {
      g.edges[e].road = pi;
      p.roadsLeft--;
      g.freeRoads--;
      log(g, `${p.name} placed a free road.`, pi);
      if (g.freeRoads <= 0 || legalRoadSpots(g, pi).length === 0) g.phase = 'main';
    } else {
      if (!canAfford(p, COSTS.road)) fail('Not enough resources for a road.');
      pay(g, p, COSTS.road);
      g.edges[e].road = pi;
      p.roadsLeft--;
      log(g, `${p.name} built a road.`, pi);
    }
    updateLongestRoad(g);
    checkWin(g);
  }

  function rollDice(g, forced) {
    if (g.phase !== 'roll') fail('You can’t roll right now.');
    const p = g.players[g.current];
    const d1 = forced ? forced[0] : 1 + Math.floor(g.rand() * 6);
    const d2 = forced ? forced[1] : 1 + Math.floor(g.rand() * 6);
    g.dice = [d1, d2];
    const sum = d1 + d2;
    log(g, `${p.name} rolled ${sum}.`, g.current);
    if (sum === 7) {
      g.discards = {};
      g.players.forEach((q, i) => {
        const n = totalCards(q);
        if (n > 7) g.discards[i] = Math.floor(n / 2);
      });
      g.afterRobber = 'main';
      const who = Object.keys(g.discards).map(i => g.players[i].name);
      if (who.length) {
        g.phase = 'discard';
        log(g, `${who.join(', ')} must discard half their cards.`);
      } else {
        g.phase = 'robber';
      }
      return;
    }
    distribute(g, sum);
    g.phase = 'main';
  }

  function distribute(g, sum) {
    const n = g.players.length;
    const demand = {};
    RESOURCES.forEach(r => { demand[r] = Array(n).fill(0); });
    g.tiles.forEach((T, ti) => {
      if (T.number !== sum || ti === g.robber) return;
      T.verts.forEach(v => {
        const b = g.vertices[v].building;
        if (b) demand[T.resource][b.owner] += b.type === 'city' ? 2 : 1;
      });
    });
    const gains = g.players.map(() => emptyHand());
    RESOURCES.forEach(r => {
      const d = demand[r];
      const total = d.reduce((a, b) => a + b, 0);
      if (!total) return;
      const recipients = d.filter(x => x > 0).length;
      if (total <= g.bank[r] || recipients === 1) {
        d.forEach((x, i) => { if (x) gains[i][r] += take(g, g.players[i], r, x); });
      } else {
        log(g, `The bank is short on ${tok(r)}, so nobody gets any.`);
      }
    });
    let any = false;
    gains.forEach((h, i) => {
      if (countHand(h)) { any = true; log(g, `${g.players[i].name} collected ${fmtRes(h)}.`, i); }
    });
    if (!any) log(g, 'Nobody collected anything.');
  }

  // Not limited to the current player: anyone with too many cards discards.
  function discard(g, pi, cards) {
    if (g.phase !== 'discard' || !(pi in g.discards)) fail('You don’t need to discard.');
    const p = g.players[pi], sel = cleanHand(cards);
    if (countHand(sel) !== g.discards[pi]) fail(`Discard exactly ${g.discards[pi]} cards.`);
    if (RESOURCES.some(r => sel[r] > p.res[r])) fail('You don’t have those cards.');
    pay(g, p, sel);
    delete g.discards[pi];
    log(g, `${p.name} discarded ${countHand(sel)} cards.`, pi);
    if (Object.keys(g.discards).length === 0) g.phase = 'robber';
  }

  function moveRobber(g, t) {
    if (g.phase !== 'robber') fail('You can’t move the robber now.');
    if (!Number.isInteger(t) || t < 0 || t >= g.tiles.length || t === g.robber) fail('Move the robber to a different tile.');
    const pi = g.current;
    g.robber = t;
    log(g, `${g.players[pi].name} moved the robber.`, pi);
    const victims = [...new Set(
      g.tiles[t].verts.map(v => g.vertices[v].building).filter(b => b && b.owner !== pi).map(b => b.owner)
    )].filter(i => totalCards(g.players[i]) > 0);
    if (victims.length === 0) g.phase = g.afterRobber;
    else if (victims.length === 1) doSteal(g, victims[0]);
    else { g.stealCandidates = victims; g.phase = 'steal'; }
  }

  function steal(g, victim) {
    if (g.phase !== 'steal' || !g.stealCandidates.includes(victim)) fail('You can’t steal from that player.');
    doSteal(g, victim);
  }

  function doSteal(g, victim) {
    const thief = g.players[g.current], v = g.players[victim];
    const pool = [];
    RESOURCES.forEach(r => { for (let i = 0; i < v.res[r]; i++) pool.push(r); });
    const r = pool[Math.floor(g.rand() * pool.length)];
    v.res[r]--;
    thief.res[r]++;
    log(g, `${thief.name} stole a card from ${v.name}.`, g.current,
      { to: [g.current, victim], text: `${thief.name} stole ${tok(r)} from ${v.name}.` });
    g.stealCandidates = [];
    g.phase = g.afterRobber;
  }

  function buyDevCard(g) {
    requireBuild(g);
    const pi = g.current, p = g.players[pi];
    if (!g.devDeck.length) fail('No development cards left.');
    if (!canAfford(p, COSTS.dev)) fail('Not enough resources for a development card.');
    pay(g, p, COSTS.dev);
    const type = g.devDeck.pop();
    p.dev.push({ type, turn: g.turn });
    log(g, `${p.name} bought a development card.`, pi,
      { to: [pi], text: `${p.name} bought a development card (${DEV_INFO[type].name}).` });
    checkWin(g);
  }

  function playDev(g, type, params) {
    const pi = g.current, p = g.players[pi];
    params = params || {};
    if (!playableDev(g, pi).includes(type)) fail('You can’t play that card now.');
    if (type === 'yearOfPlenty') {
      const rs = params.resources;
      if (!Array.isArray(rs) || rs.length !== 2 || !rs.every(r => RESOURCES.includes(r))) fail('Pick two resources.');
      if (rs[0] === rs[1] ? g.bank[rs[0]] < 2 : rs.some(r => g.bank[r] < 1)) fail('The bank doesn’t have those.');
    }
    if (type === 'monopoly' && !RESOURCES.includes(params.resource)) fail('Pick a resource.');

    p.dev.splice(p.dev.findIndex(c => c.type === type && c.turn < g.turn), 1);
    p.playedDevThisTurn = true;
    const name = DEV_INFO[type].name;
    switch (type) {
      case 'knight':
        p.knights++;
        log(g, `${p.name} played a Knight.`, pi);
        updateLargestArmy(g);
        g.afterRobber = g.phase;
        g.phase = 'robber';
        break;
      case 'roadBuilding':
        g.freeRoads = Math.min(2, p.roadsLeft);
        g.phase = 'roadBuilding';
        log(g, `${p.name} played ${name}.`, pi);
        break;
      case 'yearOfPlenty': {
        const got = emptyHand();
        params.resources.forEach(r => { got[r] += take(g, p, r, 1); });
        log(g, `${p.name} played ${name} and took ${fmtRes(got)}.`, pi);
        break;
      }
      case 'monopoly': {
        const r = params.resource;
        let total = 0;
        g.players.forEach((q, i) => {
          if (i === pi) return;
          total += q.res[r];
          q.res[r] = 0;
        });
        p.res[r] += total;
        log(g, `${p.name} played ${name} and took all ${total} ${tok(r)}.`, pi);
        break;
      }
    }
    checkWin(g);
  }

  function tradeWithBank(g, give, get) {
    requireMain(g);
    const pi = g.current, p = g.players[pi];
    if (!RESOURCES.includes(give) || !RESOURCES.includes(get) || give === get) fail('Pick two different resources.');
    const rate = bankRate(g, pi, give);
    if (p.res[give] < rate) fail(`You need ${rate} ${tok(give)}.`);
    if (g.bank[get] < 1) fail('The bank is out of that resource.');
    p.res[give] -= rate;
    g.bank[give] += rate;
    p.res[get]++;
    g.bank[get]--;
    log(g, `${p.name} traded ${rate} ${tok(give)} for 1 ${tok(get)} with the bank.`, pi);
  }

  function hasCards(p, h) { return RESOURCES.every(r => p.res[r] >= (h[r] || 0)); }

  function proposeTrade(g, give, get) {
    requireMain(g);
    const p = g.players[g.current];
    give = cleanHand(give);
    get = cleanHand(get);
    if (!countHand(give) || !countHand(get)) fail('A trade needs cards on both sides.');
    if (RESOURCES.some(r => give[r] && get[r])) fail('You can’t give and get the same resource.');
    if (!hasCards(p, give)) fail('You don’t have those cards.');
    g.trade = { from: g.current, give, get, responses: {} };
    log(g, `${p.name} offers ${fmtRes(give)} for ${fmtRes(get)}.`, g.current);
  }

  // Any non-current player responds to the open offer.
  function respondTrade(g, pi, accept) {
    const t = g.trade;
    if (!t || g.phase !== 'main') fail('There’s no open trade.');
    if (pi === t.from) fail('You can’t answer your own offer.');
    if (accept && !hasCards(g.players[pi], t.get)) fail('You don’t have the cards for this trade.');
    t.responses[pi] = accept ? 'accept' : 'decline';
  }

  function confirmTrade(g, other) {
    requireMain(g);
    const t = g.trade, p = g.players[g.current];
    if (!t) fail('There’s no open trade.');
    if (t.responses[other] !== 'accept') fail('That player hasn’t accepted.');
    const o = g.players[other];
    if (!hasCards(p, t.give)) fail('You no longer have those cards.');
    if (!hasCards(o, t.get)) fail(`${o.name} no longer has those cards.`);
    RESOURCES.forEach(r => {
      p.res[r] += t.get[r] - t.give[r];
      o.res[r] += t.give[r] - t.get[r];
    });
    g.trade = null;
    log(g, `${p.name} traded ${fmtRes(t.give)} to ${o.name} for ${fmtRes(t.get)}.`, g.current);
  }

  function cancelTrade(g) {
    if (!g.trade) return;
    g.trade = null;
    log(g, `${g.players[g.current].name} withdrew the offer.`, g.current);
  }

  // Could player pi build anything at all right now?
  function canBuildAnything(g, pi) {
    const p = g.players[pi];
    return (canAfford(p, COSTS.road) && legalRoadSpots(g, pi).length > 0)
      || (canAfford(p, COSTS.settlement) && legalSettlementSpots(g, pi).length > 0)
      || (canAfford(p, COSTS.city) && legalCitySpots(g, pi).length > 0)
      || (canAfford(p, COSTS.dev) && g.devDeck.length > 0);
  }

  // Ends the current turn, or passes during the Special Building Phase.
  function endTurn(g) {
    const n = g.players.length;
    if (g.phase === 'specialBuild') {
      g.specialBuild.queue.shift();
    } else {
      requireMain(g);
      g.players[g.current].playedDevThisTurn = false;
      g.trade = null;
      if (g.specialBuild) {
        const tp = g.current;
        g.specialBuild.turnPlayer = tp;
        g.specialBuild.queue = Array.from({ length: n - 1 }, (_, k) => (tp + 1 + k) % n);
        g.phase = 'specialBuild';
      }
    }
    if (g.phase === 'specialBuild') {
      const q = g.specialBuild.queue;
      while (q.length && !canBuildAnything(g, q[0])) q.shift(); // skip players who can't build
      if (q.length) {
        g.current = q[0];
        return;
      }
      g.current = g.specialBuild.turnPlayer;
    }
    g.current = (g.current + 1) % n;
    g.turn++;
    g.phase = 'roll';
    g.dice = null;
    log(g, `— ${g.players[g.current].name}'s turn —`, g.current);
    checkWin(g);
  }

  // ---------- per-player view (hides other players' hands) ----------

  function viewFor(g, pi) {
    const over = g.phase === 'over';
    const view = {
      tiles: g.tiles.map(t => ({ x: t.x, y: t.y, resource: t.resource, number: t.number, verts: t.verts })),
      vertices: g.vertices.map(V => ({ x: V.x, y: V.y, building: V.building, port: V.port })),
      edges: g.edges.map(E => ({ v: E.v, road: E.road, tiles: E.tiles })),
      ports: g.ports,
      robber: g.robber,
      bank: { ...g.bank },
      devDeckCount: g.devDeck.length,
      current: g.current,
      turn: g.turn,
      phase: g.phase,
      setupStep: g.phase === 'setup' ? g.setup.step : null,
      bankSize: g.bankSize,
      specialBuildFor: g.phase === 'specialBuild' ? g.specialBuild.turnPlayer : null,
      dice: g.dice,
      discards: { ...g.discards },
      stealCandidates: g.stealCandidates,
      freeRoads: g.freeRoads,
      trade: g.trade,
      longestRoadHolder: g.longestRoadHolder,
      largestArmyHolder: g.largestArmyHolder,
      winner: g.winner,
      players: g.players.map((p, i) => ({
        name: p.name, color: p.color, cards: totalCards(p), devCards: p.dev.length,
        knights: p.knights, roadLength: g.roadLengths[i], vp: victoryPoints(g, i, over),
        roadsLeft: p.roadsLeft, settlementsLeft: p.settlementsLeft, citiesLeft: p.citiesLeft,
      })),
      log: g.log.slice(-100).map(e => ({
        text: e.secret && e.secret.to.includes(pi) ? e.secret.text : e.text, pi: e.pi,
      })),
      you: null,
    };
    if (Number.isInteger(pi) && pi >= 0 && pi < g.players.length) {
      const p = g.players[pi], mine = pi === g.current;
      const ph = g.phase;
      const building = ph === 'main' || ph === 'specialBuild';
      view.you = {
        index: pi,
        res: { ...p.res },
        dev: p.dev.map(c => ({ type: c.type, isNew: c.turn >= g.turn })),
        vp: victoryPoints(g, pi, true),
        rates: Object.fromEntries(RESOURCES.map(r => [r, bankRate(g, pi, r)])),
        legal: {
          settlements: mine && (building || (ph === 'setup' && g.setup.step === 'settlement')) ? legalSettlementSpots(g, pi) : [],
          roads: mine && (building || ph === 'roadBuilding' || ph === 'setup') ? legalRoadSpots(g, pi) : [],
          cities: mine && building ? legalCitySpots(g, pi) : [],
          robberTiles: mine && ph === 'robber' ? g.tiles.map((_, i) => i).filter(i => i !== g.robber) : [],
          devs: playableDev(g, pi),
        },
      };
    }
    return view;
  }

  return {
    RESOURCES, RES_NAME, COSTS, PIPS, DEV_INFO, PLAYER_COLORS, WIN_POINTS, MIN_PLAYERS, MAX_PLAYERS,
    RuleError, cleanHand, countHand, totalCards, canAfford, fmtRes,
    newGame, isVertexOpen, legalSettlementSpots, legalCitySpots, legalRoadSpots, bankRate, playableDev,
    longestRoadFor, victoryPoints,
    placeSettlement, placeCity, placeRoad, rollDice, discard, moveRobber, steal, buyDevCard, playDev,
    tradeWithBank, proposeTrade, respondTrade, confirmTrade, cancelTrade, endTurn, viewFor,
  };
});
