(function () {
  'use strict';

  const C = window.Catan;
  const { RESOURCES, RES_NAME, COSTS, PIPS, DEV_INFO } = C;
  const S = 60; // pixels per hex radius
  const TILE_COLORS = {
    wood: '#3c6e3a', brick: '#a8502f', sheep: '#8fae55', wheat: '#d4a53a', ore: '#79808a', desert: '#d8c38e',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const $ = sel => document.querySelector(sel);

  const state = { code: null, token: null, view: null, es: null, lanUrls: [], clockOffset: 0 };
  const ui = {
    mode: null,        // 'road' | 'settlement' | 'city' while choosing a build spot
    dialog: null,      // 'trade' | 'yearOfPlenty' | 'monopoly'
    discardSel: null,
    yopSel: null,
    tradeGive: C.cleanHand({}),
    tradeGet: C.cleanHand({}),
    bankGive: null,
    bankGet: null,
    tradeTab: 'players',     // trade dialog: 'players' | 'bank'
    hideResults: false,
    seenNotices: new Set(), // notice keys already animated in
    flashes: [],            // short-lived notices: { key, title, text, until }
    lastTurnFlash: null,
    colorMenu: false,        // lobby: colour list open
    editingName: false,      // lobby: renaming yourself
    warnedTimer: null,       // timer key we've already warned about
    feedTab: 'log',          // sidebar feed: 'log' | 'chat'
    chatSeen: null,          // chat messages already seen, for the unread count
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  // ---------- DOM helpers ----------

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(c => {
      if (c === null || c === undefined || c === false) return;
      e.append(c.nodeType ? c : String(c));
    });
    return e;
  }

  function svg(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  function svgText(parent, x, y, text, cls) {
    const t = svg('text', { x, y, class: cls }, parent);
    t.textContent = text;
    return t;
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => { s.hidden = s.id !== id; });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.replaceChildren(...richText(msg));
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // A resource glyph from the sprite in index.html.
  function glyph(r) {
    const el = svg('svg', { class: 'glyph', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    svg('use', { href: `#g-${r}` }, el);
    return el;
  }

  // A small hexagonal chip in the resource's colour.
  function chip(r) {
    return h('span', { class: `chip ${r}`, title: RES_NAME[r] }, glyph(r));
  }

  function resList(hand) {
    const parts = RESOURCES.filter(r => hand[r]).map(r =>
      h('span', { class: 'res-group' }, h('span', { class: 'qty' }, hand[r]), chip(r)));
    return parts.length ? parts : ['—'];
  }

  function costLabel(cost) {
    return h('span', { class: 'cost' }, Object.entries(cost).flatMap(([r, n]) => Array.from({ length: n }, () => chip(r))));
  }

  // Server messages mark resources as {wood}, {ore}, …
  function richText(text) {
    return String(text).split(/\{(wood|brick|sheep|wheat|ore)\}/).map((part, i) => (i % 2 ? chip(part) : part));
  }

  function icon(name) {
    const el = svg('svg', { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    svg('use', { href: `#g-${name}` }, el);
    return el;
  }

  const PIP_CELLS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function dieFace(n, cls) {
    return h('span', { class: 'die' + (cls ? ' ' + cls : ''), 'aria-label': String(n) },
      Array.from({ length: 9 }, (_, i) => h('i', { class: PIP_CELLS[n].includes(i) ? 'on' : '' })));
  }

  function settlementIcon(color) {
    const icon = svg('svg', { viewBox: '-11 -13 22 23', class: 'settlement-icon', 'aria-hidden': 'true' });
    svg('polygon', { points: '-9,8 9,8 9,-3 0,-11 -9,-3', fill: color }, icon);
    return icon;
  }

  // ---------- networking ----------

  async function api(path, body) {
    const opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {};
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function send(type, payload) {
    return api(`/api/rooms/${state.code}/action`, { token: state.token, type, ...(payload || {}) })
      .catch(e => toast(e.message));
  }

  function connect(code, token) {
    state.code = code;
    state.token = token;
    store.set('catan:' + code, token);
    history.replaceState(null, '', `?room=${code}`);
    if (state.es) state.es.close();
    const es = new EventSource(`/api/rooms/${code}/events?token=${encodeURIComponent(token)}`);
    es.onopen = () => { $('#conn').hidden = true; };
    es.onmessage = ev => {
      state.view = JSON.parse(ev.data);
      state.clockOffset = state.view.serverNow - Date.now();
      render();
    };
    es.onerror = () => {
      $('#conn').hidden = false;
      if (es.readyState !== EventSource.CLOSED) return; // browser will retry on its own
      api(`/api/rooms/${code}?token=${token}`)
        .then(() => setTimeout(() => connect(code, token), 1500))
        .catch(e => {
          if (e.status === 404) { leave(e.message); return; }
          setTimeout(() => connect(code, token), 3000);
        });
    };
    state.es = es;
  }

  function leave(message) {
    if (state.es) state.es.close();
    if (state.code) store.del('catan:' + state.code);
    state.es = null;
    state.code = state.token = state.view = null;
    history.replaceState(null, '', location.pathname);
    showScreen('home');
    if (message) toast(message);
  }

  // ---------- home ----------

  async function createGame() {
    const name = $('#name').value.trim();
    store.set('catan:name', name);
    try {
      const d = await api('/api/rooms', { name });
      connect(d.code, d.token);
    } catch (e) { toast(e.message); }
  }

  async function joinGame(ev) {
    ev.preventDefault();
    const code = $('#join-code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return toast('Enter the 4-letter game code.');
    const name = $('#name').value.trim();
    store.set('catan:name', name);
    const token = store.get('catan:' + code);
    try {
      if (token) {
        const info = await api(`/api/rooms/${code}?token=${token}`);
        if (info.you >= 0) return connect(code, token);
      }
      const d = await api(`/api/rooms/${code}/join`, { name });
      connect(d.code, d.token);
    } catch (e) { toast(e.message); }
  }

  // ---------- render ----------

  function render() {
    const v = state.view;
    if (!v) return;
    if (!v.started) {
      showScreen('lobby');
      renderLobby(v);
    } else {
      showScreen('game');
      renderGame(v);
    }
    renderChat(v);
    const g = v.game;
    const myTurn = g && g.you && (g.current === g.you.index || g.discards[g.you.index] !== undefined) && g.phase !== 'over';
    document.title = myTurn ? '● Your move — Catan' : 'Catan';
  }

  function shareLink(code) {
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
    const base = local && state.lanUrls.length ? state.lanUrls[0] : location.origin;
    return `${base}/?room=${code}`;
  }

  function renderLobby(v) {
    const codeEl = $('#room-code');
    if (codeEl.dataset.code !== v.code) {
      codeEl.dataset.code = v.code;
      codeEl.replaceChildren(...[...v.code].map(ch => h('span', { class: 'code-token' }, ch)));
    }
    const link = shareLink(v.code);
    const input = $('#share-link');
    if (input.value !== link) input.value = link;
    $('#share-hint').textContent = link.includes('192.168.') || link.includes('10.') || link.includes('172.')
      ? 'This link works for friends on the same Wi-Fi. For friends elsewhere, see the README.'
      : 'Send this link to your friends.';

    $('#member-count').textContent = `${v.members.length} of ${C.MAX_PLAYERS}`;
    // Don't rebuild the list mid-rename: that would drop focus and the half-typed name.
    if (!(ui.editingName && $('#members .name-input'))) renderMembers(v);
    renderLobbySettings(v);

    const actions = $('#lobby-actions');
    const n = v.members.length;
    if (v.you === 0) {
      actions.replaceChildren(
        h('button', { class: 'primary big', disabled: n < C.MIN_PLAYERS, onclick: () => send('start') },
          n < C.MIN_PLAYERS ? 'Waiting for players…' : `Start game (${n} players)`),
      );
    } else {
      actions.replaceChildren(h('p', { class: 'hint' }, 'Waiting for the host to start the game…'));
    }
  }

  function fmtSeconds(sec) {
    return sec < 120 ? `${sec}s` : `${sec / 60} min`;
  }

  // Player list. Your own row lets you change your colour (click the house) and name (click it).
  function renderMembers(v) {
    const rows = v.members.map((m, i) => {
      const mine = i === v.you;
      const colorCtl = mine
        ? h('span', { class: 'color-ctl' },
          h('button', {
            class: 'member-color', 'aria-haspopup': 'listbox', 'aria-expanded': String(ui.colorMenu),
            title: 'Change your color', 'aria-label': `Your color: ${C.COLOR_NAMES[m.color] || 'custom'}. Change`,
            onclick: ev => { ev.stopPropagation(); ui.colorMenu = !ui.colorMenu; ui.editingName = false; renderMembers(v); },
          }, settlementIcon(m.color)),
          ui.colorMenu && colorMenu(v, m))
        : settlementIcon(m.color);
      const nameCtl = !mine ? h('span', { class: 'member-name' }, m.name)
        : ui.editingName ? nameInput(v, m)
          : h('button', {
            class: 'member-name editable', title: 'Change your name',
            onclick: ev => { ev.stopPropagation(); ui.editingName = true; ui.colorMenu = false; renderMembers(v); focusNameInput(); },
          }, m.name, h('span', { class: 'edit-hint', 'aria-hidden': 'true' }, 'Edit'));
      return h('li', { class: mine ? 'me' : '' },
        colorCtl, nameCtl,
        mine && h('span', { class: 'tag' }, 'you'),
        i === 0 && h('span', { class: 'tag' }, 'host'),
        h('span', { class: 'presence' + (m.connected ? ' on' : '') }, m.connected ? 'here' : 'away'));
    });
    if (v.members.length < C.MAX_PLAYERS) {
      rows.push(h('li', { class: 'open-seat' },
        `${C.MAX_PLAYERS - v.members.length} seat${C.MAX_PLAYERS - v.members.length > 1 ? 's' : ''} open`));
    }
    $('#members').replaceChildren(...rows);
  }

  function colorMenu(v, me) {
    return h('div', { class: 'color-menu', role: 'listbox', 'aria-label': 'Choose your color', onclick: ev => ev.stopPropagation() },
      C.PLAYER_COLORS.map(c => {
        const owner = v.members.find(m => m.color === c);
        const current = me.color === c;
        return h('button', {
          class: 'color-option' + (current ? ' current' : ''), role: 'option', 'aria-selected': String(current),
          disabled: !!owner && !current,
          onclick: () => { ui.colorMenu = false; if (!current) send('color', { color: c }); renderMembers(v); },
        }, settlementIcon(c), h('span', { class: 'color-name' }, C.COLOR_NAMES[c]),
        current ? icon('check') : owner && h('span', { class: 'color-owner' }, owner.name));
      }));
  }

  function nameInput(v, me) {
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      ui.editingName = false;
      const name = input.value.trim();
      if (save && name && name !== me.name) {
        store.set('catan:name', name);
        send('rename', { name });
      }
      if (state.view && !state.view.started) renderMembers(state.view);
    };
    const input = h('input', {
      class: 'name-input', value: me.name, maxlength: 20, 'aria-label': 'Your name',
      onkeydown: ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
      },
      onblur: () => finish(true),
      onclick: ev => ev.stopPropagation(),
    });
    return input;
  }

  function focusNameInput() {
    const input = $('#members .name-input');
    if (input) { input.focus(); input.select(); }
  }

  function renderLobbySettings(v) {

    // A server started before settings existed sends none; keep the lobby usable and say why.
    const outdated = !v.settings;
    const host = v.you === 0 && !outdated, st = v.settings || C.DEFAULT_SETTINGS;
    const set = patch => send('settings', { settings: patch });
    $('#settings-note').textContent = v.you === 0 ? '' : 'Set by the host';
    $('#settings').replaceChildren(
      h('div', { class: 'setting' },
        h('div', { class: 'setting-text' },
          h('div', { class: 'setting-name' }, 'Balanced dice'),
          h('div', { class: 'setting-desc' }, st.balancedDice
            ? 'On: numbers come up close to the odds on the board, with fewer streaks.'
            : 'Off: each die is rolled at random, like real dice, so lucky and unlucky streaks can happen.')),
        h('button', {
          class: 'switch', role: 'switch', 'aria-checked': String(st.balancedDice), 'aria-label': 'Balanced dice',
          disabled: !host, onclick: () => set({ balancedDice: !st.balancedDice }),
        }, h('span', { class: 'switch-knob' }))),
      h('div', { class: 'setting stacked' },
        h('div', { class: 'setting-text' },
          h('div', { class: 'setting-name' }, 'Turn timer'),
          h('div', { class: 'setting-desc' },
            'Covers the whole turn. When it runs out, the turn is finished automatically. Opening placements always get 60 seconds each.')),
        h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Turn timer' }, C.TIMER_CHOICES.map(sec => h('button', {
          role: 'radio', 'aria-checked': String(st.turnTimer === sec), disabled: !host,
          onclick: () => set({ turnTimer: sec }),
        }, sec ? fmtSeconds(sec) : 'Off')))),
    );
  }

  function renderChat(v) {
    document.querySelectorAll('.chat-list').forEach(list => {
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
      list.replaceChildren(...v.chat.map(m => h('div', { class: 'chat-line' },
        h('b', {}, m.name + ': '), m.text)));
      if (atBottom) list.scrollTop = list.scrollHeight;
    });
    // Unread count on the in-game Chat tab while the log is showing.
    if (ui.chatSeen === null || ui.feedTab === 'chat' || !v.started) ui.chatSeen = v.chat.length;
    const unread = v.chat.length - ui.chatSeen;
    const badge = document.querySelector('.feed .unread');
    badge.hidden = unread <= 0;
    badge.textContent = unread;
  }

  function setFeedTab(tab) {
    ui.feedTab = tab;
    document.querySelectorAll('.feed .tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
    document.querySelectorAll('.feed .feed-pane').forEach(p => { p.hidden = p.dataset.pane !== tab; });
    if (state.view) renderChat(state.view);
    const pane = document.querySelector(`.feed [data-pane="${tab}"]`);
    const list = tab === 'chat' ? pane.querySelector('.chat-list') : pane;
    list.scrollTop = list.scrollHeight;
    if (tab === 'chat') pane.querySelector('input').focus();
  }

  function renderGame(v) {
    const g = v.game;
    const me = g.you;
    const building = g.phase === 'main' || g.phase === 'specialBuild';
    if (!building || !me || g.current !== me.index) ui.mode = null;
    if (g.phase !== 'main' || !me || g.current !== me.index) {
      if (ui.dialog === 'trade' || ui.dialog === 'yearOfPlenty' || ui.dialog === 'monopoly') ui.dialog = null;
    }
    if (g.phase !== 'over') ui.hideResults = false;
    if (me && g.current === me.index && g.phase === 'roll' && ui.lastTurnFlash !== g.turn) {
      ui.lastTurnFlash = g.turn;
      flash('turn-' + g.turn, 'Your turn', 'Roll the dice to begin.');
    }
    $('#game-code').textContent = `Game ${v.code}`;
    renderBoard(g, me);
    renderDice(g);
    renderPlayers(v, g, me);
    renderTurn(g, me);
    renderActionBar(g, me);
    renderNotices(g, me);
    tickTimer();
    renderHand(g, me);
    renderLog(g);
    renderModal(v, g, me);
  }

  // ---------- board ----------

  function hexPoints(cx, cy, r, offsetDeg) {
    return Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 180) * (offsetDeg + 60 * i);
      return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
    }).join(' ');
  }

  function renderBoard(g, me, root = $('#board')) {
    root.replaceChildren();
    const xs = g.tiles.map(t => t.x), ys = g.tiles.map(t => t.y);
    const pad = 2.6;
    const minX = (Math.min(...xs) - pad) * S, minY = (Math.min(...ys) - pad) * S;
    root.setAttribute('viewBox', `${minX} ${minY} ${(Math.max(...xs) + pad) * S - minX} ${(Math.max(...ys) + pad) * S - minY}`);
    // A wooden frame, open sea, shallows and a sandy shore follow the coastline.
    const frame = svg('g', { class: 'frame' }, root);
    g.tiles.forEach(t => svg('polygon', { points: hexPoints(t.x * S, t.y * S, 2.32 * S, 30) }, frame));
    const sea = svg('g', { class: 'sea' }, root);
    g.tiles.forEach(t => svg('polygon', { points: hexPoints(t.x * S, t.y * S, 2.14 * S, 30) }, sea));
    const shallows = svg('g', { class: 'shallows' }, root);
    g.tiles.forEach(t => svg('polygon', { points: hexPoints(t.x * S, t.y * S, 1.75 * S, 30) }, shallows));
    const beach = svg('g', { class: 'beach' }, root);
    g.tiles.forEach(t => svg('polygon', { points: hexPoints(t.x * S, t.y * S, 1.1 * S, 30) }, beach));

    // ports
    g.ports.forEach(pt => {
      const E = g.edges[pt.edge];
      const a = g.vertices[E.v[0]], b = g.vertices[E.v[1]];
      const T = g.tiles[E.tiles[0]];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const len = Math.hypot(mx - T.x, my - T.y);
      const px = (mx + ((mx - T.x) / len) * 0.62) * S, py = (my + ((my - T.y) / len) * 0.62) * S;
      [a, b].forEach(V => {
        svg('line', { x1: V.x * S, y1: V.y * S, x2: px, y2: py, class: 'dock' }, root);
        svg('line', { x1: V.x * S, y1: V.y * S, x2: px, y2: py, class: 'dock-light' }, root);
      });
      const grp = svg('g', { class: 'port' }, root);
      svg('title', {}, grp).textContent = pt.type === 'any' ? 'Port: trade 3 of any one resource for 1' : `Port: trade 2 ${RES_NAME[pt.type]} for 1`;
      svg('circle', { cx: px, cy: py, r: 19, class: 'disc' }, grp);
      if (pt.type === 'any') {
        svgText(grp, px, py + 4.5, '3:1', 'port-ratio');
      } else {
        svg('polygon', { points: hexPoints(px, py - 4.5, 9, 30), fill: TILE_COLORS[pt.type] }, grp);
        svg('use', { href: `#g-${pt.type}`, x: px - 5.5, y: py - 10, width: 11, height: 11, class: 'port-glyph' }, grp);
        svgText(grp, px, py + 14, '2:1', 'port-ratio small');
      }
    });

    // tiles
    const sum = g.dice ? g.dice[0] + g.dice[1] : null;
    g.tiles.forEach((T, ti) => {
      const cx = T.x * S, cy = T.y * S;
      const hit = sum && sum !== 7 && g.phase !== 'roll' && T.number === sum && ti !== g.robber;
      const grp = svg('g', { class: `tile ${T.resource}` + (hit ? ' hit' : '') }, root);
      const pts = T.verts.map(v => `${g.vertices[v].x * S},${g.vertices[v].y * S}`).join(' ');
      svg('polygon', { points: pts, fill: TILE_COLORS[T.resource], class: 'hex' }, grp);
      svg('polygon', { points: hexPoints(cx, cy, 0.86 * S, 30), class: 'hex-inner' }, grp);
      if (T.resource !== 'desert') {
        svg('use', { href: `#g-${T.resource}`, x: cx - 15, y: cy - 44, width: 30, height: 30, class: 'tile-glyph' }, grp);
      }
      if (T.number) {
        const red = T.number === 6 || T.number === 8;
        svg('circle', { cx, cy: cy + 16, r: 17, class: 'token-shadow' }, grp);
        svg('circle', { cx, cy: cy + 14, r: 17, class: 'token' }, grp);
        svgText(grp, cx, cy + 19, T.number, 'token-num' + (red ? ' red' : ''));
        const pips = PIPS[T.number];
        for (let i = 0; i < pips; i++) {
          svg('circle', { cx: cx + (i - (pips - 1) / 2) * 4.5, cy: cy + 25, r: 1.5, class: 'pip' + (red ? ' red' : '') }, grp);
        }
      }
    });

    // robber
    const RT = g.tiles[g.robber];
    const rx = RT.x * S + (RT.number ? 30 : 0), ry = RT.y * S + 10;
    const robber = svg('g', { class: 'robber', transform: `translate(${rx},${ry})` }, root);
    svg('path', { class: 'body', d: 'M-10 17 Q-10 10 -6 8 Q-9 3 -7 -2 Q-5 -6 -3.5 -7 A6.5 6.5 0 1 1 3.5 -7 Q5 -6 7 -2 Q9 3 6 8 Q10 10 10 17 Z' }, robber);
    svg('ellipse', { class: 'shine', cx: -2.5, cy: -12, rx: 2, ry: 2.6 }, robber);

    // roads
    g.edges.forEach(E => {
      if (E.road === null) return;
      const [a, b] = E.v.map(v => g.vertices[v]);
      const color = g.players[E.road].color;
      const [x1, y1, x2, y2] = shrink(a, b, 0.17);
      svg('line', { x1, y1, x2, y2, class: 'road-outline' }, root);
      svg('line', { x1, y1, x2, y2, class: 'road', stroke: color }, root);
    });

    // buildings
    g.vertices.forEach(V => {
      if (!V.building) return;
      const color = g.players[V.building.owner].color;
      const shape = V.building.type === 'city'
        ? '-13,10 13,10 13,-3 3,-3 3,-9 -5,-16 -13,-9'
        : '-9,8 9,8 9,-3 0,-11 -9,-3';
      svg('polygon', { points: shape, transform: `translate(${V.x * S},${V.y * S})`, class: 'building', fill: color }, root);
    });

    // click targets for the local player
    const myTurn = me && g.current === me.index;
    if (!myTurn) return;
    let verts = [], vertAction = null, edges = [], tiles = [];
    if (g.phase === 'setup') {
      if (g.setupStep === 'settlement') { verts = me.legal.settlements; vertAction = 'placeSettlement'; }
      else edges = me.legal.roads;
    } else if (g.phase === 'roadBuilding') {
      edges = me.legal.roads;
    } else if (g.phase === 'robber') {
      tiles = me.legal.robberTiles;
    } else if (g.phase === 'main' || g.phase === 'specialBuild') {
      if (ui.mode === 'road') edges = me.legal.roads;
      if (ui.mode === 'settlement') { verts = me.legal.settlements; vertAction = 'placeSettlement'; }
      if (ui.mode === 'city') { verts = me.legal.cities; vertAction = 'placeCity'; }
    }

    tiles.forEach(ti => {
      const T = g.tiles[ti];
      const pts = T.verts.map(v => `${g.vertices[v].x * S},${g.vertices[v].y * S}`).join(' ');
      const p = svg('polygon', { points: pts, class: 'tile-target' }, root);
      p.addEventListener('click', () => send('moveRobber', { tile: ti }));
    });
    edges.forEach(ei => {
      const E = g.edges[ei];
      const [x1, y1, x2, y2] = shrink(g.vertices[E.v[0]], g.vertices[E.v[1]], 0.2);
      const l = svg('line', { x1, y1, x2, y2, class: 'edge-target' }, root);
      l.addEventListener('click', () => { ui.mode = null; send('placeRoad', { edge: ei }); });
    });
    verts.forEach(vi => {
      const V = g.vertices[vi];
      const c = svg('circle', { cx: V.x * S, cy: V.y * S, r: 10, class: 'vertex-target' }, root);
      c.addEventListener('click', () => { ui.mode = null; send(vertAction, { vertex: vi }); });
    });
  }

  function shrink(a, b, f) {
    const dx = b.x - a.x, dy = b.y - a.y;
    return [(a.x + dx * f) * S, (a.y + dy * f) * S, (b.x - dx * f) * S, (b.y - dy * f) * S];
  }

  function renderDice(g) {
    const el = $('#dice');
    if (!g.dice) { el.replaceChildren(); return; }
    el.replaceChildren(
      dieFace(g.dice[0]),
      dieFace(g.dice[1], 'red'),
      h('span', { class: 'dice-sum' + (g.dice[0] + g.dice[1] === 7 ? ' seven' : '') }, g.dice[0] + g.dice[1]),
    );
  }

  // ---------- sidebar ----------

  function renderPlayers(v, g, me) {
    const list = $('#players');
    list.className = 'panel' + (g.players.length > 4 ? ' compact' : '');
    const stat = (n, label, title) => h('span', { title }, h('b', {}, n), ` ${label}`);
    list.replaceChildren(...g.players.map((p, i) => {
      const isMe = me && me.index === i;
      const vp = isMe ? me.vp : p.vp;
      return h('div', { class: 'player' + (i === g.current ? ' current' : '') },
        settlementIcon(p.color),
        h('div', { class: 'player-top' },
          h('span', { class: 'pname' }, p.name),
          isMe && h('span', { class: 'tag' }, 'you'),
          !v.members[i].connected && h('span', { class: 'tag warn' }, 'away'),
          g.discards[i] !== undefined && h('span', { class: 'tag warn' }, `discarding ${g.discards[i]}`),
        ),
        h('div', { class: 'vp', title: isMe ? 'Includes your hidden victory point cards' : 'Visible points' },
          vp, h('small', {}, 'points')),
        h('div', { class: 'player-stats' },
          stat(p.cards, p.cards === 1 ? 'card' : 'cards', 'Resource cards'),
          stat(p.devCards, 'dev', 'Development cards'),
          stat(p.knights, p.knights === 1 ? 'knight' : 'knights', 'Knights played'),
          stat(p.roadLength, 'road', 'Longest continuous road'),
          g.longestRoadHolder === i && h('span', { class: 'badge' }, 'Longest Road'),
          g.largestArmyHolder === i && h('span', { class: 'badge' }, 'Largest Army'),
        ),
      );
    }));
  }

  function statusText(g, me) {
    const cur = g.players[g.current];
    const mine = me && me.index === g.current;
    const who = mine ? 'You' : cur.name;
    switch (g.phase) {
      case 'setup': return g.setupStep === 'settlement'
        ? `${who}: place a settlement${mine ? ' on a glowing corner' : ''}.`
        : `${who}: place a road next to it.`;
      case 'roll': return mine ? 'Your turn — roll the dice.' : `${cur.name} is rolling…`;
      case 'discard': {
        const names = Object.keys(g.discards).map(i => g.players[i].name);
        return `Robber! Waiting for ${names.join(', ')} to discard.`;
      }
      case 'robber': return mine ? 'Click a tile to move the robber.' : `${cur.name} is moving the robber…`;
      case 'steal': return mine ? 'Choose who to steal from.' : `${cur.name} is choosing who to rob…`;
      case 'roadBuilding': return mine ? `Place ${g.freeRoads} free road${g.freeRoads > 1 ? 's' : ''}.` : `${cur.name} is building roads…`;
      case 'specialBuild': {
        const after = g.players[g.specialBuildFor].name;
        if (!mine) return `Special building: ${cur.name} may build before the next turn.`;
        if (ui.mode) return `Click a glowing spot to build a ${ui.mode}. (Esc to cancel)`;
        return `Special building after ${after}'s turn — build or buy now, or pass. (No trading.)`;
      }
      case 'main':
        if (!mine) return `${cur.name}'s turn.`;
        if (ui.mode) return `Click a glowing spot to build a ${ui.mode}. (Esc to cancel)`;
        return 'Build, trade, or end your turn.';
      case 'over': return `${g.players[g.winner].name} won the game!`;
      default: return '';
    }
  }

  function renderTurn(g, me) {
    const panel = $('#turn');
    const kids = [h('div', { class: 'status' }, statusText(g, me))];

    if (g.phase === 'over' && ui.hideResults) {
      kids.push(h('div', { class: 'actions' },
        h('button', { onclick: () => { ui.hideResults = false; render(); } }, 'Show results')));
    }
    panel.replaceChildren(...kids);
  }

  // Always-visible strip: build costs, dice, trade and end turn. Buttons light up when usable.
  function renderActionBar(g, me) {
    const bar = $('#action-bar');
    const mine = !!me && me.index === g.current;
    const building = mine && (g.phase === 'main' || g.phase === 'specialBuild');
    const afford = cost => !!me && C.canAfford({ res: me.res }, cost);
    const legal = me ? me.legal : { roads: [], settlements: [], cities: [] };
    const why = (cost, spots) => !mine ? 'Not your turn'
      : !building ? 'Not now'
        : !afford(cost) ? 'Not enough resources'
          : !spots ? 'Nowhere to build' : '';

    const build = (mode, label, cost, spots) => {
      const ok = building && afford(cost) && spots > 0;
      return h('button', {
        class: 'bar-item' + (ui.mode === mode ? ' active' : '') + (ok ? ' ready' : ''),
        disabled: !ok, title: why(cost, spots),
        onclick: () => { ui.mode = ui.mode === mode ? null : mode; render(); },
      }, h('span', { class: 'bar-label' }, label), costLabel(cost));
    };
    const devOk = building && afford(COSTS.dev) && g.devDeckCount > 0;
    const canRoll = mine && g.phase === 'roll';
    const canTrade = mine && g.phase === 'main';
    const special = mine && g.phase === 'specialBuild';

    const timer = g.timer && h('div', { class: 'bar-timer', id: 'turn-timer', role: 'timer' },
      h('span', { class: 'timer-who' }, mine ? 'Your time' : g.players[g.current].name),
      h('span', { class: 'timer-time' }),
      h('span', { class: 'timer-track' }, h('span', { class: 'timer-fill' })));

    bar.replaceChildren(
      ...(timer ? [timer] : []),
      h('button', {
        class: 'bar-roll' + (canRoll ? ' ready' : ''), disabled: !canRoll,
        title: canRoll ? 'Roll the dice (R)' : 'Not your roll', onclick: () => send('rollDice'),
      }, h('span', { class: 'bar-dice' }, dieFace(5), dieFace(2, 'red')), h('span', { class: 'bar-label' }, 'Roll')),
      h('div', { class: 'bar-builds' },
        build('road', 'Road', COSTS.road, legal.roads.length),
        build('settlement', 'Settlement', COSTS.settlement, legal.settlements.length),
        build('city', 'City', COSTS.city, legal.cities.length),
        h('button', {
          class: 'bar-item' + (devOk ? ' ready' : ''), disabled: !devOk,
          title: g.devDeckCount ? why(COSTS.dev, 1) || `${g.devDeckCount} left in the deck` : 'The deck is empty',
          onclick: () => send('buyDevCard'),
        }, h('span', { class: 'bar-label' }, 'Dev card', h('small', {}, g.devDeckCount)), costLabel(COSTS.dev)),
      ),
      h('button', {
        class: 'bar-trade' + (canTrade ? ' ready' : ''), disabled: !canTrade,
        title: canTrade ? 'Trade with the bank or other players (T)' : 'Trade on your turn, after rolling',
        onclick: () => openTrade(),
      }, icon('swap'), h('span', { class: 'bar-label' }, 'Trade')),
      h('button', {
        class: 'bar-end primary', disabled: !building,
        title: building ? 'End your turn (E)' : '',
        onclick: () => { ui.mode = null; send('endTurn'); },
      }, special ? 'Done building' : 'End turn'),
    );
  }

  // Updates the countdown between server updates (the server enforces the deadline).
  function tickTimer() {
    const el = $('#turn-timer');
    const g = state.view && state.view.game;
    if (!el || !g || !g.timer) return;
    const left = Math.max(0, g.timer.deadline - (Date.now() + state.clockOffset));
    const secs = Math.ceil(left / 1000);
    el.querySelector('.timer-time').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    el.querySelector('.timer-fill').style.width = `${Math.min(100, (left / (g.timer.seconds * 1000)) * 100)}%`;
    el.classList.toggle('low', secs <= 10);
    const me = g.you;
    if (me && me.index === g.current && secs <= 10 && secs > 0 && ui.warnedTimer !== g.timer.deadline) {
      ui.warnedTimer = g.timer.deadline;
      flash('timer-' + g.timer.deadline, '10 seconds left', 'Your turn will be finished for you when time runs out.', 4000);
      renderNotices(g, me);
    }
  }

  function flash(key, title, text, ms) {
    ui.flashes = ui.flashes.filter(f => f.key !== key);
    ui.flashes.push({ key, title, text, until: Date.now() + (ms || 3500) });
    setTimeout(() => { if (state.view && state.view.game) renderNotices(state.view.game, state.view.game.you); }, (ms || 3500) + 50);
  }

  function offerLines(l1, h1, l2, h2) {
    return h('div', { class: 'offer' },
      h('div', {}, h('span', { class: 'offer-label' }, l1), resList(h1)),
      h('div', {}, h('span', { class: 'offer-label' }, l2), resList(h2)));
  }

  // Pop-up notices over the board: trade offers (with accept/decline) and short alerts.
  function renderNotices(g, me) {
    const box = $('#notices');
    const notes = [];
    const t = g.trade;
    if (t && me && g.phase === 'main') {
      const key = `offer:${t.from}:${JSON.stringify(t.give)}:${JSON.stringify(t.get)}`;
      if (t.from === me.index) {
        const others = g.players.map((_, i) => i).filter(i => i !== me.index);
        notes.push({
          key, cls: 'own', body: [
            h('div', { class: 'notice-head' }, 'Your offer',
              h('button', { class: 'notice-x', title: 'Withdraw offer', onclick: () => send('cancelTrade') }, icon('cross'))),
            offerLines('You give', t.give, 'You get', t.get),
            h('div', { class: 'responses' }, others.map(i => {
              const r = t.responses[i], p = g.players[i];
              return h('div', { class: 'response ' + (r || 'waiting') },
                settlementIcon(p.color), h('span', { class: 'rname' }, p.name),
                r === 'accept'
                  ? h('button', { class: 'take', onclick: () => send('confirmTrade', { with: i }) }, icon('check'), 'Trade')
                  : h('span', { class: 'rstate' }, r === 'decline' ? 'declined' : 'deciding…'));
            })),
          ],
        });
      } else if (t.responses[me.index] !== 'decline') {
        const from = g.players[t.from];
        const accepted = t.responses[me.index] === 'accept';
        const canPay = RESOURCES.every(r => me.res[r] >= t.get[r]);
        notes.push({
          key, cls: 'incoming', body: [
            h('div', { class: 'notice-head' }, settlementIcon(from.color), `${from.name} offers a trade`),
            offerLines('You get', t.give, 'You give', t.get),
            h('div', { class: 'notice-actions' },
              h('span', { class: 'notice-state' },
                accepted ? `Accepted — waiting for ${from.name}` : canPay ? '' : 'You don’t have these cards'),
              h('button', {
                class: 'round decline', title: 'Decline', 'aria-label': 'Decline',
                onclick: () => send('respondTrade', { accept: false }),
              }, icon('cross')),
              h('button', {
                class: 'round accept', title: 'Accept', 'aria-label': 'Accept', disabled: !canPay || accepted,
                onclick: () => send('respondTrade', { accept: true }),
              }, icon('check'))),
          ],
        });
      }
    }
    const now = Date.now();
    ui.flashes = ui.flashes.filter(f => f.until > now);
    ui.flashes.forEach(f => notes.push({
      key: f.key, cls: 'flash', body: [h('div', { class: 'notice-head' }, f.title), h('div', { class: 'notice-text' }, f.text)],
    }));

    box.replaceChildren(...notes.map(n => {
      const fresh = !ui.seenNotices.has(n.key);
      ui.seenNotices.add(n.key);
      return h('div', { class: `notice ${n.cls}` + (fresh ? ' enter' : '') }, n.body);
    }));
  }

  function renderHand(g, me) {
    const panel = $('#hand');
    if (!me) {
      panel.replaceChildren(h('div', { class: 'panel-title' }, 'Spectating'));
      return;
    }
    const cards = RESOURCES.map(r => h('div', { class: `res-card ${r}` + (me.res[r] ? '' : ' empty'), title: RES_NAME[r] },
      glyph(r), h('span', { class: 'res-count' }, me.res[r]), h('span', { class: 'res-name' }, RES_NAME[r])));

    const groups = {};
    me.dev.forEach(c => {
      groups[c.type] = groups[c.type] || { total: 0, fresh: 0 };
      groups[c.type].total++;
      if (c.isNew) groups[c.type].fresh++;
    });
    const devs = Object.entries(groups).map(([type, info]) => {
      const playable = me.legal.devs.includes(type);
      return h('div', { class: 'dev-card' },
        h('span', { class: 'dev-name' }, `${DEV_INFO[type].name}${info.total > 1 ? ` ×${info.total}` : ''}`,
          info.fresh > 0 && type !== 'victoryPoint' && h('span', { class: 'tag' }, info.fresh === info.total ? 'new' : `${info.fresh} new`)),
        h('span', { class: 'dev-side' },
          playable && h('button', { class: 'small', onclick: () => playDev(type) }, 'Play')),
        h('span', { class: 'dev-text' }, DEV_INFO[type].text));
    });

    const p = g.players[me.index];
    panel.replaceChildren(
      h('div', { class: 'panel-title' }, 'Your hand'),
      h('div', { class: 'res-cards' }, cards),
      ...(devs.length ? [h('div', { class: 'dev-cards' }, devs)] : []),
      h('div', { class: 'pieces' }, `In reserve: ${p.roadsLeft} roads · ${p.settlementsLeft} settlements · ${p.citiesLeft} cities`),
    );
  }

  function playDev(type) {
    if (type === 'yearOfPlenty') { ui.dialog = 'yearOfPlenty'; ui.yopSel = C.cleanHand({}); render(); return; }
    if (type === 'monopoly') { ui.dialog = 'monopoly'; render(); return; }
    send('playDev', { card: type });
  }

  function renderLog(g) {
    const el = $('#log');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.replaceChildren(...g.log.map(e => {
      const turn = /^— .* —$/.test(e.text);
      return h('div', {
        class: 'log-line' + (turn ? ' turn' : ''),
        style: e.pi !== null && !turn ? `--pc:${g.players[e.pi].color}` : '',
      }, ...richText(turn ? e.text.slice(2, -2) : e.text));
    }));
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  // ---------- modals ----------

  function openTrade() {
    ui.dialog = 'trade';
    ui.tradeGive = C.cleanHand({});
    ui.tradeGet = C.cleanHand({});
    ui.bankGive = ui.bankGet = null;
    render();
  }

  function closeDialog() { ui.dialog = null; render(); }

  // A resource card to click. Used wherever the player picks cards.
  function pickCard(r, opts) {
    const { count, badge, disabled, selected, onclick, title } = opts;
    return h('button', {
      class: `pick-card res-card ${r}` + (selected ? ' selected' : '') + (disabled ? ' empty' : ''),
      disabled, title: title || RES_NAME[r], 'aria-pressed': selected ? 'true' : null, onclick,
    },
    glyph(r),
    count !== undefined && h('span', { class: 'res-count' }, count),
    badge && h('span', { class: 'pick-badge' }, badge),
    h('span', { class: 'res-name' }, RES_NAME[r]));
  }

  // The cards picked so far, fanned by resource. Clicking one puts it back.
  function tray(label, hand, onRemove, emptyText) {
    const cards = RESOURCES.flatMap(r => Array.from({ length: hand[r] }, () => r));
    return h('div', { class: 'tray' },
      h('div', { class: 'sub-label' }, label, cards.length > 0 && h('span', { class: 'tray-count' }, cards.length)),
      h('div', { class: 'tray-cards' }, cards.length
        ? cards.map((r, i) => h('button', {
          class: `tray-card res-card ${r}` + (i > 0 && cards[i - 1] === r ? ' stacked' : ''),
          title: `Put back ${RES_NAME[r]}`, onclick: () => onRemove(r),
        }, glyph(r)))
        : h('span', { class: 'tray-empty' }, emptyText)));
  }

  function renderModal(v, g, me) {
    const modal = $('#modal');
    const card = modal.querySelector('.modal-card');
    const rerender = () => renderModal(v, g, me);
    let content = null;

    const mine = me && me.index === g.current;
    if (g.phase === 'over' && !ui.hideResults) {
      content = resultsModal(v, g, me);
    } else if (me && g.phase === 'discard' && g.discards[me.index] !== undefined) {
      content = discardModal(g, me, rerender);
    } else if (mine && g.phase === 'steal') {
      content = [
        h('h2', {}, 'Steal a card'),
        h('p', {}, 'Pick a player to take a random card from.'),
        h('div', { class: 'actions column' }, g.stealCandidates.map(i => h('button', {
          onclick: () => send('steal', { victim: i }),
        }, `${g.players[i].name} (${g.players[i].cards} cards)`))),
      ];
    } else if (ui.dialog === 'trade' && mine && g.phase === 'main') {
      content = tradeModal(g, me, rerender);
    } else if (ui.dialog === 'yearOfPlenty' && mine) {
      const sel = ui.yopSel;
      const n = C.countHand(sel);
      content = [
        h('h2', {}, 'Year of Plenty'),
        h('p', {}, 'Take any two resources from the bank.'),
        tray(`You take · ${n} of 2`, sel, r => { sel[r]--; rerender(); }, 'Click two cards below'),
        h('div', { class: 'sub-label' }, 'From the bank'),
        h('div', { class: 'pick-row' }, RESOURCES.map(r => pickCard(r, {
          count: g.bank[r] - sel[r], disabled: n >= 2 || g.bank[r] - sel[r] < 1,
          title: `Take ${RES_NAME[r]}`, onclick: () => { sel[r]++; rerender(); },
        }))),
        h('div', { class: 'actions' },
          h('button', { onclick: closeDialog }, 'Cancel'),
          h('button', {
            class: 'primary', disabled: n !== 2,
            onclick: () => {
              const picks = RESOURCES.flatMap(r => Array(sel[r]).fill(r));
              ui.dialog = null;
              send('playDev', { card: 'yearOfPlenty', resources: picks });
            },
          }, 'Take them')),
      ];
    } else if (ui.dialog === 'monopoly' && mine) {
      content = [
        h('h2', {}, 'Monopoly'),
        h('p', {}, 'Every other player gives you all of one resource.'),
        h('div', { class: 'pick-row' }, RESOURCES.map(r => pickCard(r, {
          title: `Take everyone’s ${RES_NAME[r]}`,
          onclick: () => { ui.dialog = null; send('playDev', { card: 'monopoly', resource: r }); },
        }))),
        h('div', { class: 'actions' }, h('button', { onclick: closeDialog }, 'Cancel')),
      ];
    }

    if (g.phase !== 'discard') ui.discardSel = null;
    if (!content) { modal.hidden = true; return; }
    card.replaceChildren(...content);
    modal.hidden = false;
  }

  function discardModal(g, me, rerender) {
    const need = g.discards[me.index];
    if (!ui.discardSel) ui.discardSel = C.cleanHand({});
    const sel = ui.discardSel;
    const n = C.countHand(sel);
    return [
      h('h2', {}, 'The robber strikes'),
      h('p', {}, `You have more than 7 cards, so you must discard ${need}.`),
      tray(`Discarding · ${n} of ${need}`, sel, r => { sel[r]--; rerender(); }, 'Click cards in your hand'),
      h('div', { class: 'sub-label' }, 'Your hand'),
      h('div', { class: 'pick-row' }, RESOURCES.map(r => {
        const left = me.res[r] - sel[r];
        return pickCard(r, { count: left, disabled: left <= 0 || n >= need, onclick: () => { sel[r]++; rerender(); } });
      })),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', disabled: n !== need, onclick: () => send('discard', { cards: sel }) }, 'Discard')),
    ];
  }

  function tradeModal(g, me, rerender) {
    const tab = ui.tradeTab;
    const tabs = h('div', { class: 'feed-tabs modal-tabs', role: 'tablist' }, [['players', 'With players'], ['bank', 'With the bank']]
      .map(([id, label]) => h('button', {
        class: 'tab', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { ui.tradeTab = id; rerender(); },
      }, label)));

    if (tab === 'bank') {
      const give = ui.bankGive, get = ui.bankGet;
      const rate = give ? me.rates[give] : 0;
      const ok = give && get && give !== get && me.res[give] >= rate && g.bank[get] > 0;
      return [
        h('h2', {}, 'Trade'),
        tabs,
        h('p', {}, 'The bank trades 4 for 1. Your ports improve the rate.'),
        h('div', { class: 'sub-label' }, 'Get from the bank'),
        h('div', { class: 'pick-row' }, RESOURCES.map(r => pickCard(r, {
          selected: get === r, disabled: g.bank[r] < 1 || r === give,
          title: g.bank[r] < 1 ? 'The bank has none left' : `Get 1 ${RES_NAME[r]}`,
          onclick: () => { ui.bankGet = r; rerender(); },
        }))),
        h('div', { class: 'bank-summary' }, ok
          ? [h('span', { class: 'res-group' }, h('span', { class: 'qty' }, rate), chip(give)), icon('swap'),
            h('span', { class: 'res-group' }, h('span', { class: 'qty' }, 1), chip(get))]
          : 'Pick one card to get and one to give.'),
        h('div', { class: 'sub-label' }, 'Give from your hand'),
        h('div', { class: 'pick-row' }, RESOURCES.map(r => pickCard(r, {
          count: me.res[r], badge: `${me.rates[r]}:1`, selected: give === r, disabled: me.res[r] < me.rates[r],
          title: me.res[r] < me.rates[r] ? `You need ${me.rates[r]} ${RES_NAME[r]}` : `Give ${me.rates[r]} ${RES_NAME[r]}`,
          onclick: () => { ui.bankGive = r; if (ui.bankGet === r) ui.bankGet = null; rerender(); },
        }))),
        h('div', { class: 'actions' },
          h('button', { onclick: closeDialog }, 'Close'),
          h('button', {
            class: 'primary', disabled: !ok,
            onclick: () => { send('tradeBank', { give, get }); ui.bankGive = ui.bankGet = null; rerender(); },
          }, 'Trade with bank')),
      ];
    }

    const give = ui.tradeGive, get = ui.tradeGet;
    const ok = C.countHand(give) > 0 && C.countHand(get) > 0;
    return [
      h('h2', {}, 'Trade'),
      tabs,
      h('div', { class: 'sub-label' }, 'Ask for'),
      h('div', { class: 'pick-row' }, RESOURCES.map(r => pickCard(r, {
        disabled: give[r] > 0 || get[r] >= 9,
        title: give[r] > 0 ? `You’re offering ${RES_NAME[r]}` : `Ask for ${RES_NAME[r]}`,
        onclick: () => { get[r]++; rerender(); },
      }))),
      h('div', { class: 'trays' },
        tray('You give', give, r => { give[r]--; rerender(); }, 'Click cards in your hand below'),
        h('div', { class: 'tray-arrow' }, icon('swap')),
        tray('You get', get, r => { get[r]--; rerender(); }, 'Click what you want above')),
      h('div', { class: 'sub-label' }, 'Your hand'),
      h('div', { class: 'pick-row' }, RESOURCES.map(r => {
        const left = me.res[r] - give[r];
        return pickCard(r, {
          count: left, disabled: left <= 0 || get[r] > 0,
          title: get[r] > 0 ? `You’re asking for ${RES_NAME[r]}` : `Offer ${RES_NAME[r]}`,
          onclick: () => { give[r]++; rerender(); },
        });
      })),
      h('div', { class: 'actions' },
        h('button', { onclick: closeDialog }, 'Cancel'),
        h('button', {
          class: 'primary', disabled: !ok,
          onclick: () => { send('proposeTrade', { give, get }); ui.dialog = null; render(); },
        }, 'Offer to everyone')),
    ];
  }

  function resultsModal(v, g, me) {
    const ranked = g.players.map((p, i) => ({ ...p, i })).sort((a, b) => b.vp - a.vp);
    const winner = g.players[g.winner];
    return [
      h('h2', {}, me && me.index === g.winner ? 'Victory is yours' : `${winner.name} wins`),
      h('p', {}, 'Final standings'),
      h('ol', { class: 'results' }, ranked.map(p => h('li', {},
        settlementIcon(p.color), h('span', { class: 'pname' }, p.name), h('span', { class: 'vp' }, p.vp)))),
      h('div', { class: 'actions' },
        h('button', { onclick: () => { ui.hideResults = true; render(); } }, 'View board'),
        v.you === 0
          ? h('button', { class: 'primary', onclick: () => send('newGame') }, 'Play again')
          : h('span', { class: 'muted' }, 'The host can start a new game.')),
    ];
  }

  // A real, freshly generated board for the landing and lobby screens, with the
  // opening placements played out so it looks like a game in progress.
  function renderArt() {
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const g = C.newGame(['a', 'b', 'c', 'd']);
    while (g.phase === 'setup') {
      C.placeSettlement(g, pick(C.legalSettlementSpots(g, g.current)));
      C.placeRoad(g, pick(C.legalRoadSpots(g, g.current)));
    }
    const view = C.viewFor(g, null);
    document.querySelectorAll('.art-board').forEach(el => renderBoard(view, null, el));
  }

  // ---------- theme ----------

  function setTheme(theme, save) {
    document.documentElement.dataset.theme = theme;
    if (save) store.set('catan:theme', theme);
    document.querySelectorAll('.theme-toggle').forEach(b => {
      b.setAttribute('aria-checked', String(theme === 'dark'));
      b.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    });
  }

  // A sun/moon switch at the top of every screen.
  function mountThemeToggles() {
    document.querySelectorAll('.brand, .game-head').forEach(host => {
      host.append(h('button', {
        class: 'theme-toggle', role: 'switch', 'aria-label': 'Dark mode',
        onclick: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true),
      }, h('span', { class: 'tt-track' }, icon('sun'), icon('moon'), h('span', { class: 'tt-knob' }))));
    });
    setTheme(document.documentElement.dataset.theme || 'light', false);
    // Follow the system setting until the player picks one.
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      if (!store.get('catan:theme')) setTheme(e.matches ? 'dark' : 'light', false);
    });
  }

  // ---------- boot ----------

  function bindChat() {
    document.querySelectorAll('.chat-form').forEach(form => {
      form.addEventListener('submit', ev => {
        ev.preventDefault();
        const input = form.querySelector('input');
        const text = input.value.trim();
        if (!text || !state.code) return;
        input.value = '';
        send('chat', { text });
      });
    });
  }

  async function init() {
    $('#create').addEventListener('click', createGame);
    $('#join-form').addEventListener('submit', joinGame);
    $('#copy-link').addEventListener('click', () => {
      const input = $('#share-link');
      input.select();
      const done = () => toast('Link copied!');
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(input.value).then(done, () => {});
      else if (document.execCommand('copy')) done();
    });
    $('#modal').addEventListener('click', ev => {
      if (ev.target.id === 'modal' && ui.dialog) closeDialog();
    });
    document.addEventListener('click', () => {
      if (ui.colorMenu && state.view && !state.view.started) { ui.colorMenu = false; renderMembers(state.view); }
    });
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        if (ui.colorMenu && state.view && !state.view.started) { ui.colorMenu = false; renderMembers(state.view); return; }
        if (ui.dialog) closeDialog();
        else if (ui.mode) { ui.mode = null; render(); }
        return;
      }
      // Shortcuts press the matching bar button, so they obey the same rules.
      if (ev.metaKey || ev.ctrlKey || ev.altKey || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (!$('#modal').hidden) return;
      const target = { r: '.bar-roll', t: '.bar-trade', e: '.bar-end' }[ev.key.toLowerCase()];
      const btn = target && document.querySelector('#action-bar ' + target);
      if (btn && !btn.disabled) { ev.preventDefault(); btn.click(); }
    });
    bindChat();
    setInterval(tickTimer, 250);
    document.querySelectorAll('.feed .tab').forEach(t => t.addEventListener('click', () => setFeedTab(t.dataset.tab)));
    mountThemeToggles();
    renderArt();

    $('#name').value = store.get('catan:name') || '';
    api('/api/info').then(d => { state.lanUrls = d.lanUrls || []; render(); }).catch(() => {});

    const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
    if (code) {
      $('#join-code').value = code;
      const token = store.get('catan:' + code);
      if (token) {
        try {
          const info = await api(`/api/rooms/${code}?token=${token}`);
          if (info.you >= 0) return connect(code, token);
        } catch (e) { toast(e.message); }
      }
    }
    showScreen('home');
    $('#name').focus();
  }

  init();
})();
