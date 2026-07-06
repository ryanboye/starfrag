# DECK 7 — arena design

A research-driven redesign of the flagship deathmatch deck. The old deck7 was one
32×32 hollow box with a handful of free-floating cover blocks and four-fold
symmetry — every corner identical, every sightline the full width of the room, no
rooms, no corridors, no identity. The owner's words: *"a boring box with boxes, I
feel like I'm in a data center."* That is exactly what the geometry was.

This redesign replaces it with a **ring of eight distinct rooms around a central
contested reactor core**, wired for flow, sightline variety, and readable
landmarks. Same engine, same textures, same theme — different design.

## The problem, measured

The static analyzer (grid flood-fill + per-cell raycast sweep) on the two versions:

|                              | OLD (box)            | NEW (ring of 8)        |
| ---------------------------- | -------------------- | ---------------------- |
| open floor                   | 83% (one room)       | 71% (rooms + halls)    |
| distinct rooms               | 1                    | 9 (8 ring + core)      |
| avg spawns in direct LOS     | **4–5 each**         | **0 each**             |
| spawns with a window in view | 8/8                  | 8/8                    |
| dead ends                    | n/a (open box)       | 0                      |

Every spawn in the old box could see 4–5 other spawns the instant you appeared —
a spawn-camp gallery. In the new deck no spawn has line of sight to any other
spawn, because every spawn sits inside its own walled room.

## Principles applied (and the research behind them)

Canonical arena-FPS level-design principles from Quake / Unreal Tournament /
Counter-Strike map craft:

- **Overlapping loops, no dead ends.** '90s deathmatch maps funnel players
  corridor→atrium→corridor in a series of overlapping loops that keep players
  moving and break sightlines. Every room here has ≥2 exits.
- **Chokepoints with flanks.** Narrow doorways concentrate fights, but each one
  has an alternate route so a hold is never a stalemate.
- **Controlled line of sight + cover rhythm.** Mix long lanes, mid rooms, and
  tight corners; give the player many possible paths.
- **Power items behind risk.** A strong pickup should cost you exposure to reach —
  UT's *Conveyer* put the damage amp on a narrow walkway over molten metal, no cover.
- **Readable landmarks.** One unique visual anchor to orient by.

Sources:
[CritPoints – Good FPS Map Design](https://critpoints.net/2018/02/18/good-fps-map-design/),
[The Language of Arena FPS Level Design (Plus Forward)](https://www.plusforward.net/post/21433/The-Language-of-Arena-FPS-Level-Design/),
[Multiplayer Level Design Techniques (Mind Studios)](https://games.themindstudios.com/post/multiplayer-level-design-techniques/),
[What makes a good multiplayer level? (G. Annand)](https://fat-studios.medium.com/what-makes-a-good-multiplayer-level-d604de3385dd).

## The floorplan

```
###########OOOOOOOOOO####OOO####      Legend
#..p......p..........p.........#        #  hull shell        O  viewport (window to space)
#a.p......p..........p.PP....c.#        p  partition (PANEL)  T  tech panel / console
O..p......p..........p.PP..PP..#        P  pillar / crate     @  REACTOR (the only orange glow)
O..p..p......T....T........PP..#        a–h spawns            H/A  health / armor pickup
O..p..p........................#
#H....p...p..........p..PP..P..#      Rooms (clockwise from NW):
#.....ppp.p....TT....p......P..#        a WARREN      b GALLERY    c CARGO
#.....p...p.b........p.......A.#        d CONDUIT-W   @ CORE       e CONDUIT-E
#.....p...p..........p.........#        f CRYO        g BRIDGE     h SUBSTATION
#ppp..ppppppppp..pppppppp..pppp#
#.........p..........p.........#      Four partition lines (x=10, x=21, y=10, y=21)
#d.....P..p.T......T.p.........#      carve the 3×3 of blocks; the door gaps in them
O......P..p..........p.T.......O      align into four "peeker's-lane" corridors:
O...PP....p..........p...PP....O        - GALLERY  long E-W lane under the planet window
O...PP.........@@........PP....O        - BRIDGE   long E-W lane along the south
O..............@@..............O        - CONDUIT-W long N-S lane (west edge)
O.........p..........p......P..O        - CONDUIT-E long N-S lane (east edge)
O.pp......p.....H....p......P..O      each broken by ONE mid-lane cover block, so it is
#.........p.T......T.p........e#      a peek-and-trade lane, not an instant-death rail.
#.........p..........p.........#
#ppp..ppppppppp..pppppppp..pppp#      Loops: full outer ring
#.........p..........p.........#        warren→gallery→cargo→conduitE→substation
#.PP......p.T.....g..p.........#        →bridge→cryo→conduitW→warren, PLUS a core
#.PP......p..........p...TTT...#        shortcut off every hall. Always 2+ ways to go.
#.............TT.........TTT...#
#.....PP......TT.........TTT...#
#.....PP..p........T.p.........#
#..T......p..........p.........#
#f......H.p..........p.A......h#
#.........p..........p.........#
####OO#######OOOOOO######OOO####
```

## The nine zones (each its own place)

| Zone | Character | Range | Cover |
| ---- | --------- | ----- | ----- |
| **Reactor Core** (centre) | the power position; the reactor blocks every straight cross-core shot; four corner pylons cover the four doors | mid | reactor + pylons |
| **Observation Gallery** (N) | grand hall under the big planet window; the north landmark | mid→long | 2 pylons + a console |
| **Cargo Hold** (NE) | container maze, corners everywhere | CQC | crate stacks |
| **Maintenance Warren** (NW) | cramped zig-zag corridors, teal maintenance panels | CQC | interior walls |
| **West / East Conduits** | mid-range N-S flank lanes, the map's long shots | long | one mid-lane block each |
| **Cryo Bay** (SW) | fat cryo-pod pillars, broken mid space | mid | 2×2 pods |
| **Bridge** (S) | command consoles under the south window | mid | console cluster |
| **Substation** (SE) | a 3×3 transformer with a walkway ring — a little loop *inside* the room | mid | transformer |

Textures carry the identity: rusty **HULL** for cargo/conduits, teal **TECH**
panels for the warren/bridge/substation, and the emissive orange **REACTOR** used
*only* at the core — so orange always means "centre," a single landmark players
orient by (see *readable landmarks*, above).

## Flow, sightlines, cover — why it is not a data center

- **Flow:** a full perimeter loop plus a core shortcut off every hall. From any
  room you have at least two ways out, and no corridor is a dead end. Contesting a
  doorway never traps you — there is always a flank.
- **Sightlines:** genuinely mixed. Two long N-S conduit lanes and two long E-W
  hall lanes give rifle duels; the core and cryo/bridge give mid-range rooms; the
  cargo hold and warren are tight CQC. The reactor deliberately blocks the
  centre so the map's one big open space can't be cross-mapped in a single shot.
- **Cover rhythm:** every long lane has exactly one interrupting block, so crossing
  is a peek, not a naked sprint — but the rooms aren't cluttered mazes either.
- **Power items:** the **core health** sits exposed on the reactor's south apron —
  grab it and you're lit from three doors (risk = reward). Armor is tucked deep in
  the cargo maze and behind the substation transformer; secondary health hides in
  the warren and the SW cryo corner — each pulls players on a cross-map run.
- **Spawns:** one per ring room, tucked at a room edge facing inward. No spawn sees
  another spawn; every spawn sees a window.

## Before / after (honest look)

Same camera (gallery, facing north), old vs new:

- `docs/arena-before-gallery.png` — the old box: a wide, flat, empty floor with a
  couple of distant walls. This is the data center.
- `docs/arena-gallery.png` / `docs/arena-planet.png` — the new gallery: a central
  tech column, flanking container cover, the planet framed in the north window.

Zone tour (new deck): `arena-core` (orange reactor landmark), `arena-conduit-w`
(a real long grimy corridor), `arena-cargo` (container maze with a starfield
window beyond), `arena-warren` (tight teal maintenance run), `arena-bridge`
(dense command consoles), `arena-substation` (transformer bank + walkway),
`arena-coredoor` (a framed doorway showing room-to-room connectivity).

Honest read: it is genuinely more interesting — nine readable, distinct spaces
with real loops and a real sightline spread, not shuffled boxes. It is not a
photoreal AAA map; within a grid raycaster it is a well-composed arena.

## Validation

- `tools/validate-map.mjs deck7-derelict` → **pass**: 8 spawns, 8 viewports,
  5 pickups, closed hull, 0 blind spawns.
- `tools/verify.mjs` (2 headless clients) → connect, see each other, positions
  propagate, damage registers, frag registers. (The 7-shot frag check is mildly
  timing-flaky in the tool itself — damage always lands; a kill lands most runs.)
- Flood-fill: all 732 floor cells reachable from spawn — no sealed pockets.

## Tileset recommendations (optional, not blocking)

Ships fine on the existing six textures. Future art that would sharpen zone
identity, roughly in priority order:

1. **A dedicated crate/container tile** for the cargo hold (right now crates reuse
   `PILLAR`) — stenciled cargo markings would make the maze read instantly.
2. **A cryo-pod tile** (frosted glass + a body silhouette) for the SW bay, instead
   of reusing `PILLAR`.
3. **A distinct floor texture per zone** (the renderer currently floors everything
   the same) — e.g. grated engineering floor in the conduits, clean deck plate in
   the bridge — would do a lot of the zone-identity work that walls do now.
4. **An emissive transformer/coil tile** for the substation so it reads as live
   electrical gear without stealing the core's orange.
