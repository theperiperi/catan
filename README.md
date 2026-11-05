# Catan

An online Catan clone for 2–6 friends, each playing on their own device. It needs only Node.js 18 or newer and has no dependencies.
<img width="1177" height="780" alt="Screenshot 2026-11-05 at 11 29 11 PM" src="https://github.com/user-attachments/assets/fe0922cb-e707-4b34-8502-831f95417480" />

## Play

```sh

npm start          # or: node server.js   (PORT=8080 node server.js to change port)
```

1. Open the printed URL, enter your name, and click **Create a game**.
2. Share the link or the 4-letter code shown in the lobby.
3. When everyone has joined, the host clicks **Start game**.

**Friends on the same Wi-Fi:** the lobby link already uses your LAN address (e.g. `http://192.168.x.x:3000`). If they can't connect, allow Node through your firewall.

**Friends somewhere else:** expose the server with a tunnel and share that URL, e.g.
`npx localtunnel --port 3000` or `cloudflared tunnel --url http://localhost:3000`.
You can also deploy `server.js` to any Node host (Render, Fly.io, Railway, …).

If you refresh or drop off, open the same link again to rejoin. Games live in server memory, so restarting the server ends them.

## Rules implemented

Games with 2–4 players use the base game. Games with 5–6 players automatically use the 5–6 player extension:
a 30-tile board with 2 deserts, 11 ports, 24 cards of each resource, and 34 development cards.
They also add the **Special Building Phase**: after each turn, the other players take turns to build or buy
development cards, with no trading. Players who can't afford anything are skipped.

- Random board each game, with number tokens never putting two 6s/8s next to each other
- Snake-order setup; the second settlement pays out its adjacent resources
- Dice and production with a limited bank (shortages handled per the rules)
- Rolling a 7: anyone with more than 7 cards discards half, the robber moves, and the roller steals
- Roads, settlements (distance rule), and cities, with piece limits of 15/5/4
- Development cards: Knight, Road Building, Year of Plenty, Monopoly, and Victory Point (hidden). Only one per turn, and not on the turn you bought it
- Longest Road (5+, opponents' settlements break it) and Largest Army (3+)
- Bank and port trades, plus trade offers to other players that they accept or decline
- First to 10 VP on their own turn wins; the host can start a rematch
- In-game chat for haggling

## Layout

```
server.js           HTTP + Server-Sent Events server, rooms, action routing
shared/engine.js    Rules engine (authoritative on the server)
public/             Browser client: SVG board and UI
tests/              node:test suites (engine rules, random full games, server end-to-end)
```

```sh
npm test
```
