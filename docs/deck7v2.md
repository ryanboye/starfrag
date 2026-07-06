# DECK 7-V2 — "REACTOR OVERLOAD"

A crew-reviewed, owner-approved second arena, live **alongside** the original deck7
so both can be A/B'd. Where deck7 is a ring of eight near-equal rooms for pure
deathmatch, v2 is a **five-zone plus**: one contested reactor core at the centre and
four cardinal arms, each a distinct place, wired by an outer rotation ring (the corner
corridors) plus four risky spokes (the core doors) into the middle. Design language:
**"spread, then concentrate."**

The arena is authored as **named data** in `shared/map.js` (`DECK7V2`), compiled
identically on client and server by `compileMap` — same philosophy as deck7.

## The five zones

| Zone | Cardinal | Character | Weapons / items | Objective |
| ---- | -------- | --------- | --------------- | --------- |
| **Reactor Core** | centre | crossroads-with-cover: a 2×2 reactor block dead-centre breaks every straight cross-core shot; otherwise open | **RAILGUN** on the exposed core floor, off-axis, sightlined from all 4 doors (grab-and-go) | the **OVERLOAD** climax happens here |
| **Command Bridge** | N | long E-W sightline hall under a north window; pylons + console cluster as cover | **PLASMA** | **CONSOLE A** |
| **Cargo Hold** | E | tight crate CQC maze, hard corners | **SCATTERGUN** + mega-health | **CONSOLE B** |
| **Docking Bay** | S | open, the big south planet-window, flank angles | armor + ammo | **CONSOLE C** |
| **Engineering** | W | hazard catwalk lanes | **THE QUAD** (far NW, high-risk) + health + ammo | — |

Textures carry identity (rusty HULL crates in cargo, teal TECH conduits/consoles in
bridge & engineering, emissive REACTOR **only** at the core = the one orange landmark).

## Objective — "OVERLOAD THE CORE"

Reuses the **same server-authoritative state machine** as hangar-bay's airlock
(`server/server.mjs`, `OBJ`), only re-themed and re-timed:

`idle → arming → opening (the OVERLOAD COUNTDOWN) → venting (core implosion) → reset`

1. Arm the **3 consoles A/B/C** — spread across bridge / cargo / docking, so arming
   all three **forces a full-map traversal** (no single holder can cover them).
2. All three armed → **opening**: a telegraphed 6-second overload countdown at the core.
3. **venting**: the core implodes; the **majority console-holder rides it out and wins**
   while everyone else is vented (a server kill). Tie → whoever armed the last console.

The machine is generic; deck7v2 only supplies a per-arena `objective` block in the map
data (theme labels + a `timing` override). hangar-bay omits it and keeps the airlock
defaults, so **nothing about the original objective changed** (obj-test still passes).

## >>> CELL COORDINATES (for Seb — re-baseline obj-test / mobile-verify / validate-map)

Authoritative source is `DECK7V2_CELLS` exported from `shared/map.js` (kept beside the
data so it can't drift). Consoles are stand-on pads (arm within `OBJECTIVE.ARM_RADIUS`
= 1.35 cells); the overload region is the core-implosion rect.

```
CONSOLES (objective):
  console-a  (15.5,  4.5)   COMMAND BRIDGE (N)
  console-b  (26.5, 15.5)   CARGO HOLD (E)
  console-c  (15.5, 26.5)   DOCKING BAY (S)

OVERLOAD REGION (the 'airlock'/vent entity — core implosion):
  core-overload  rect x12 y12 w8 h8   (core interior; pull sucks toward centre ~16,16)

CORE DOORS (spokes, gap centres):    N (15.5,10.5)  S (15.5,20.5)  W (10.5,15.5)  E (20.5,15.5)

WEAPONS (server-authoritative pads):
  weapon-railgun (13.5, 18.5)  reactor core floor (off-axis, sightlined from all 4 doors)
  weapon-plasma  (18.5,  2.5)  command bridge
  weapon-scatter (28.5, 18.5)  cargo maze

THE QUAD (telegraphed powerup):
  power-quad     ( 2.5, 12.5)  engineering far NW corner

OBJECTIVE TIMING OVERRIDE (arena.objective.timing):
  DOOR_OPEN_MS 6000 (overload countdown)   VENT_MS 3000 (implosion)
  (ARM_MS / ARM_RADIUS inherit the shared OBJECTIVE defaults.)
```

Partition skeleton is **identical to deck7** (lines x=10, x=21, y=10, y=21; door gaps
at ±(4-5) / (15-16) / (25-26)), so the door graph is the same validated topology —
what differs is the block content (4 cardinal zones + 4 corner ring-corridors).

## Two arenas live + selectable — the map picker

The server is single-arena-per-process, so **each deck is its own instance** and the
arena is chosen by URL. The **lightest** way to keep both live + selectable:

- **Start-screen map picker** (`client/index.html` + `client/js/game.js`): the overlay
  shows two cards — **ORIGINAL** (ring / deathmatch) and **DECK7 · V2** (5 zones /
  overload). Clicking the current arena enters; clicking the other reloads with
  `?map=<id>`. (Clicking the overlay background still enters the current arena, so every
  existing tap-to-enter path — verify.mjs, mobile-verify — is untouched. The picker is
  gated to the two user arenas, so dev/verify maps like hangar-bay keep the plain screen.)
- **WS routing** (`client/js/net.js`): `?map=deck7v2` → `/starfrag-v2-ws` (prod) /
  `:8792` (localhost); everything else → the original `/starfrag-ws` / `:8791`.

"Player chooses when spinning up a room." No lobby, no server-side rooms.

### Deploy (BMO, after eye-pass + Seb gate + merge)

Both instances run as user systemd services from the live `/home/claudebot/starfrag`:

```
cp starfrag-server-v2.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now starfrag-server-v2   # deck7v2 on :8792
```

Add the Caddy route beside the existing `handle /starfrag-ws` block, then reload Caddy:

```
handle /starfrag-v2-ws {
    reverse_proxy localhost:8792
}
```

The original `/starfrag-ws` (deck7 on :8791) and `/starfrag/` static client are unchanged.

## Verification (all local, in the worktree — never touched the live :8791)

- `tools/validate-map.mjs` → deck7v2 passes (8 spawns, 8 viewports, 9 pickups, 0 blind);
  deck7 + hangar-bay still pass.
- design checks: no spawn sees another spawn; the railgun is clear from all 4 core doors
  and behind none; all floor reachable; every spawn sees a window.
- `tools/objv2-test.mjs` vs a `STARFRAG_MAP=deck7v2` server → the overload loop is
  server-authoritative: welcome carries objective → arming → all 3 armed → opening →
  venting, a winner, exactly N-1 implosion kills.
- No regressions: `obj-test` (airlock), `verify-weapons` (deck7), `mobile-verify`
  (hangar-bay) all still pass.
- Proof shots: `deck7v2-topdown.png`, `-picker.png`, `-zone-{core,bridge,cargo,docking,
  engineering}.png`, `-hud-{arming,overload,win}.png`.

## Honest read — what's rough / deferred

- **THE QUAD is telegraph + marker only.** The pad glows up on a wall-clock cycle with
  a HUD clock ("QUAD 0:12") — the anti-snowball / casual-on-ramp legibility the brief
  asked to showcase — but the **damage-multiplier buff is deferred**: it needs a server
  powerup system, which is outside this deck's tightly-scoped brief. Placement + timing
  are in the data, so wiring the effect later is additive.
- **health / armor / ammo** are placed to the design as billboards, but their pickup
  gameplay wiring is the same pre-existing "separate feature" as on deck7 (only weapons
  are server-wired today).
- The core-implosion has **no door-crank animation** (there's no viewport at the core,
  and the airlock crank FX is bay-door-specific). The telegraphed HUD countdown + vent
  flash + implosion camera-pull carry the climax instead. A bespoke core-breach FX
  (shockwave / reactor whiteout) is a nice future polish.
- The overload countdown length (6s) and console arm time reuse the shared machine's
  knobs via the per-arena `timing` block — easy to retune from data after playtests.
