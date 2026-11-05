# Catan

An online Catan clone for 2–6 friends, each playing on their own device. It needs only Node.js 18 or newer and has no dependencies.

<img width="750" height="500" alt="Screenshot 2026-11-06 at 3 06 20 AM" src="https://github.com/user-attachments/assets/62551248-8223-487a-a26b-a5c3c2f84a83" />
<img width="750" height="500" alt="Screenshot 2026-11-06 at 3 05 35 AM" src="https://github.com/user-attachments/assets/4ab7c901-88d4-4c3f-baa2-88c5b0105c9a" />
<img width="750" height="500" alt="Screenshot 2026-11-06 at 2 33 47 AM" src="https://github.com/user-attachments/assets/87a1f35a-775f-4bdb-903f-73f0b84fd159" />


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

## Lobby settings

Everyone picks their piece colour (red, blue, white, orange, green or brown — no two players share one).
The host also chooses:

- **Balanced dice** — numbers come up close to the odds on the board, with fewer streaks. It follows
  [Colonist's published design](https://blog.colonist.io/designing-balanced-dice): each roll draws from a
  deck of all 36 dice combinations, rebuilt when 12 remain, and the previous total is 30% less likely to
  repeat. In 2-player games sevens are also nudged towards an even split between the players (Colonist
  does this for 1v1 but doesn't publish its numbers, so that strength is our own choice). Off means
  ordinary independent dice.
- **Turn timer** — off, 30s, 60s, 90s or 2 min for the whole turn (rolling, trading, building).
  Each opening settlement-and-road placement always gets 60 seconds, and each Special Building window
  in 5–6 player games gets 30 seconds. When time runs out the server finishes the turn: it places a
  random legal settlement/road during setup, otherwise it rolls, makes any pending discards, moves the
  robber off the player's own tiles, steals at random, withdraws open trades and ends the turn.

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
