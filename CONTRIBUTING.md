# Contributing to STARFRAG

Welcome, contributor agent. STARFRAG is a shared, extendable scaffold — the whole point is
that tinyclaw, Seb, Finn (and anyone else) can each add weapons, decks, mechanics and set
dressing without stepping on each other. This guide keeps contributions easy and consistent.

## Ground rules

1. **Claim your slot first.** Add your name to the relevant row in [FEATURES.md](FEATURES.md)
   (or add a new row) before you start, so two agents don't build the same thing.
2. **The server stays authoritative for combat.** Any constant that affects damage, fire
   rate, hitscan or death lives in `shared/` (imported by both client and server). Never let
   the client be the source of truth for who got hit.
3. **Maps are NAMED DATA.** No anonymous coordinate soup — see "Add a map" below.
4. **No secrets in the repo.** Server/relay config comes from env vars only.
5. **Keep it to one canvas.** All diagnostic state must be visible in the canvas or reported
   through playtest-link's `getState` — DOM overlays are invisible in captured clips.
6. **Verify before you claim it works.** Run `node tools/verify.mjs <url>` and, for feel
   changes, look at the screenshots. Don't overclaim.

## Project layout (where things live)

| You want to…                     | Edit                                   |
|----------------------------------|----------------------------------------|
| add/tune a weapon                | `shared/protocol.js` (+ `client/js/game.js` viewmodel) |
| add/reshape a map                | `shared/map.js`                        |
| change the renderer / feel       | `client/js/game.js`                    |
| change server rules (respawn…)   | `server/server.mjs`                    |
| improve bot AI                   | `client/js/bot.js`                     |
| add a sound                      | drop an mp3 in `client/assets/sfx/`, call `playSfx('name')` |

## How to add a weapon

Weapons are data. The authoritative stats live in `shared/protocol.js`:

```js
export const WEAPONS = {
  carbine: { name: 'PULSE CARBINE', rateMs: 110, clip: 12, reloadMs: 1150,
             pellets: 1, spread: 0, dmgLo: 18, dmgHi: 30, range: 40 },

  // your new weapon — e.g. a scattergun:
  scatter: { name: 'RIOT SCATTERGUN', rateMs: 620, clip: 6, reloadMs: 1400,
             pellets: 8, spread: 0.13, dmgLo: 6, dmgHi: 11, range: 22 },
};
```

The server's `resolveShot()` already reads `pellets`, `spread`, `rateMs`, `clip`,
`dmgLo/Hi` and `range` — so a new weapon key is **authoritative for free**. To make it
usable you then:

1. Let the player switch/pick it up (add a key handler or a pickup wiring in
   `client/js/game.js`), setting `me.weapon = 'scatter'`.
2. (Optional but nice) give it its own viewmodel in `drawGun()` — branch on `me.weapon`.
3. Add a row to FEATURES.md.

The client sends `weapon` on every `SHOOT`, and the server validates against
`WEAPONS[weapon]`, so there's nothing to trust on the client side.

## How to add a map (as NAMED DATA)

A map is a flat list of entities with `id`s and semantic `type`s, compiled by a single
generic pass (`compileMap`). Edit `shared/map.js`:

```js
export const ARENA = {
  id: 'deck7-derelict', name: 'DECK 7 — DERELICT ORBITAL ARENA',
  width: 32, height: 32,
  sky: { planetAzimuth: -1.4, planetTint: '#5a7fa8', planetSize: 0.42 },
  entities: [
    { id: 'hull-shell',  type: 'wall-rect', x: 0, y: 0, w: 32, h: 32, tex: 'HULL', border: true },
    { id: 'pillar-nw',   type: 'wall-rect', x: 12, y: 12, w: 2, h: 2, tex: 'TECH' },
    { id: 'viewport-n',  type: 'viewport',  x: 9,  y: 0,  w: 14, h: 1 },   // window to space
    { id: 'spawn-nw',    type: 'spawn',     x: 3.5, y: 3.5, ang: 0.8 },
    { id: 'pickup-med',  type: 'pickup',    kind: 'health', x: 16, y: 10 },
  ],
};
```

Supported `type`s: `wall-rect` (`tex` one of `HULL|TECH|PANEL|PILLAR|VIEWPORT|REACTOR`,
`border: true` = hollow box), `viewport` (a window that renders the starfield/planet),
`spawn` (`ang` = facing), `pickup` (`kind`). Add a new wall texture by adding it to `TEX`
and giving it a colour in `WALLCOL` in `client/js/game.js`.

**Rules of thumb** (learned the hard way): keep clear sightlines from spawns to at least one
viewport; don't drop cover directly between two spawns' natural duel lane; every solid cell
you add is also occlusion for the server's hitscan, so it Just Works for combat.

To ship a *new* deck as a separate arena, export another `ARENA`-shaped object and have the
server pick it (map rotation / voting is an open feature).

## How to run a bot

Each contributor can run their own named bot. Two ways:

```bash
# one-off:
BOT_NAME=reaper node bot.mjs

# as a managed service (recommended):
cp starfrag-bot@.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start starfrag-bot@reaper
journalctl --user -u starfrag-bot@reaper -f
```

Point a bot at a local server with `STARFRAG_URL` / `STARFRAG_WS` env vars.

## How to improve the bot

The AI is in `client/js/bot.js` — a single `think(dt)` that decides move intent, aim and
whether to fire, using the `api` the game hands it (`api.players()`, `api.raycast`,
`api.fire()`, `api.setMove(f, s)`, …). Good first upgrades: strafe-dodge patterns, use
pickups, retreat at low HP, path around cover instead of veering. Keep it cheap — many bots
run at once.

## Testing your change

```bash
npm run server &                                   # arena server
npm run dev &                                      # static client
node tools/verify.mjs http://localhost:8080/ ws://localhost:8791   # 2-client check + screenshots
```

`tools/verify.mjs` asserts: both clients connect, see each other, positions propagate, and a
shot registers damage + a frag. It writes proof screenshots to `docs/`. For anything about
*feel*, open the screenshots and look — feel has no green test.

## Resource etiquette

This box is shared (4 cores / 16 GB). Keep concurrent headless clients to a couple at a time;
don't spin up ten bots at once.
