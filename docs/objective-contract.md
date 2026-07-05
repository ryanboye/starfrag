# Airlock objective — client/server contract

The **server** (`server/server.mjs` + `shared/map.js`, Seb) owns all objective
truth. The **client** (`client/js/game.js`, BMO) renders it. This file is the
seam we build to independently and meet in the middle.

## Authority split (important)

Movement is client-authoritative, so **the server never moves a player.** That
splits the vent cleanly:

- **Server = truth.** Who owns each console, when the door opens, who wins, and
  who dies in the vent — all decided server-side and broadcast.
- **Client = spectacle.** The suck-toward-the-door **pull** is a pure local
  visual (lerp the camera / bodies toward the airlock rect). It changes nothing
  authoritative; the kill already arrived from the server.

So they can never disagree about who won or died.

## The loop

`idle → arming → opening → venting → (reset to idle)`

1. A live player standing within `ARM_RADIUS` of a console **channels** it to
   their name over `ARM_MS` (server derives this from the positions clients
   already send — **no new client message needed**). An enemy channels it back:
   neutralize to 0, then capture. Two+ players on one console = contested freeze.
2. Hold **all** consoles at once → `opening` (door cranks for `DOOR_OPEN_MS`).
3. → `venting` for `VENT_MS`: the majority console-holder (tie → whoever armed
   the last console) **wins**; every other live player is vented (a server kill).
4. Reset; next round.

Tunables live in `shared/protocol.js` `OBJECTIVE` (`ARM_MS`, `ARM_RADIUS`,
`DOOR_OPEN_MS`, `VENT_MS`) — retune freely, the contract shape is unaffected.

## Wire messages

### `S2C.OBJECTIVE` — broadcast every tick (20 Hz) on objective decks

```jsonc
{
  "t": "objective",
  "mode": "airlock",
  "phase": "idle" | "arming" | "opening" | "venting",
  "total": 4,                       // console count
  "armedCount": 2,                  // consoles fully captured right now
  "consoles": [
    { "id": "console-nw", "x": 5.5, "y": 10.5,
      "owner": 3,                   // player id, or null
      "color": "#ffd23c",           // owner's color, or null  → glow/ring color
      "progress": 0.42,             // 0..1 capture toward `owner` → ring fill
      "armed": false }              // progress === 1
  ],
  "airlock": { "id": "airlock-baydoor", "x": 3, "y": 0, "w": 26, "h": 2, "dir": "north" },
  "timer": 1500,                    // ms left in opening/venting, else null
  "winner": { "id": 3, "name": "cap3", "color": "#ffd23c" } | null
}
```

- **Idle deck** (deck7, no consoles): this message is **never sent** and
  `welcome.objective` is `null` — render nothing.
- `welcome` now also carries an `objective:` field: the same snapshot (without
  `t`) so a joiner can render immediately, or `null` on a deathmatch deck.

### Vent kills reuse `S2C.KILL`

Each vented player arrives as a normal killfeed entry with `weapon: "airlock"`
and `names.by` = the winner (`"THE VOID"` if somehow nobody holds a console).
Label `"airlock"` however you like in the feed (e.g. "VENTED").

## Suggested client rendering (BMO's half, non-binding)

- **Consoles**: floor markers at `(x,y)`; glow/pulse in `owner.color`; a radial
  ring for `progress`; a solid lit state when `armed`. Neutral when `owner:null`.
- **HUD**: `AIRLOCK  armedCount/total`; on `opening` a "DOOR OPENING" + `timer`
  countdown; on `venting` a "VENTING — {winner.name} WINS" banner.
- **Door**: animate the north bay-door viewport open across `opening`.
- **Vent pull**: during `venting`, drag non-winner cameras/bodies toward the
  `airlock` rect for the suck-out (visual only).

## Map data (how a deck opts in)

Add to a deck's `entities` in `shared/map.js` (see `HANGAR_BAY`):

```js
{ id: 'console-nw', type: 'console', x: 5.5, y: 10.5 },   // ×N, floor devices (not solid)
{ id: 'airlock-baydoor', type: 'airlock', x: 3, y: 0, w: 26, h: 2, dir: 'north' },
```

`compileMap` returns `consoles: [...]` and `airlock: {...}`; the server activates
the objective iff `airlock` is present. Deathmatch decks just omit them.

## Verify

`node tools/obj-test.mjs` against a `STARFRAG_MAP=hangar-bay` server drives 4
clients through a full capture→vent cycle and asserts the loop is
server-authoritative (phases, all-armed, a winner, exactly N-1 vent kills).
