// STARFRAG — the arena, authored as NAMED DATA (playtest-link AGENT-INSTRUCTIONS #8).
//
// A level is NOT a soup of anonymous coordinates or hundreds of box() calls.
// It's a flat list of entities, each with an `id` and a semantic `type`, that a
// single generic pass (`compileMap`) turns into the runtime grid + spawn/pickup
// lists. Names carry intent across sessions; edits are list mutations; the same
// data compiles identically on the client (for rendering) and the server (for
// authoritative hitscan). To add or reshape geometry, edit `ARENA.entities`.
//
// See CONTRIBUTING.md → "How to add a map".

// Wall texture ids. 0 = open floor. VIEWPORT cells render the starfield/planet
// backdrop instead of a solid wall (the floor-to-ceiling windows of the derelict).
export const TEX = {
  EMPTY: 0,
  HULL: 1,      // grimy structural hull plating
  TECH: 2,      // panelled tech wall (conduits, readouts)
  PANEL: 3,     // lighter interior partition
  PILLAR: 4,    // structural column / crate stack
  VIEWPORT: 5,  // window to space — renders starfield + planet
  REACTOR: 6,   // glowing reactor housing (emissive accent)
};

// DECK 7 — a designed derelict-ship deck, not a box of boxes. The topology is a
// RING OF EIGHT DISTINCT ROOMS around a central contested REACTOR CORE. Four
// partition lines (x=10, x=21, y=10, y=21) carve the 32×32 into a 3×3 of blocks;
// door gaps in those lines wire every room to ≥2 neighbours, so there is a full
// outer LOOP (warren→gallery→cargo→conduit-E→substation→bridge→cryo→conduit-W)
// PLUS a core shortcut off every hall — no dead ends, always 2+ ways to go.
//
// Sightline plan: the door gaps ALIGN to make four "peeker's-lane" duel corridors
// — a long E-W lane across the GALLERY (north, under the planet window), a long
// E-W lane across the BRIDGE (south), and two long N-S lanes down the WEST and
// EAST CONDUITS. Each lane is deliberately interrupted by cover (a pillar / crate
// / console) so it is a peek-and-trade lane, not an instant-death rail. The rooms
// themselves span the full sightline gamut: the CARGO HOLD and MAINTENANCE WARREN
// are tight CQC cover-mazes, the conduits are mid-range flank lanes, the core is a
// mid room whose reactor blocks every straight cross-shot. See docs/arena-design.md.
export const ARENA = {
  id: 'deck7-derelict',
  name: 'DECK 7 — DERELICT ORBITAL ARENA',
  width: 32,
  height: 32,
  // Backdrop the viewports look onto (consumed by the client renderer).
  // planetAzimuth ≈ -1.4 rad frames the planet in the big north gallery window.
  sky: { planetAzimuth: -1.4, planetTint: '#5a7fa8', planetSize: 0.42 },
  entities: [
    // --- shell: a hollow hull box around the whole deck ------------------
    { id: 'hull-shell', type: 'wall-rect', x: 0, y: 0, w: 32, h: 32, tex: 'HULL', border: true },

    // === VIEWPORTS (windows to space; every room can see the planet) ======
    // North: the big observation gallery window — the planet hangs here.
    { id: 'viewport-gallery-n', type: 'viewport', x: 11, y: 0, w: 10, h: 1 },
    // Corner-room windows so their spawns get a clear look at space too.
    { id: 'viewport-cargo-n',   type: 'viewport', x: 25, y: 0,  w: 3, h: 1 },
    { id: 'viewport-warren-w',  type: 'viewport', x: 0,  y: 3,  w: 1, h: 3 },
    // West + east conduit slit windows (the long flank lanes look onto space).
    { id: 'viewport-conduit-w', type: 'viewport', x: 0,  y: 13, w: 1, h: 6 },
    { id: 'viewport-conduit-e', type: 'viewport', x: 31, y: 13, w: 1, h: 6 },
    // South: bridge + substation ports.
    { id: 'viewport-bridge-s',  type: 'viewport', x: 13, y: 31, w: 6, h: 1 },
    { id: 'viewport-cryo-s',    type: 'viewport', x: 4,  y: 31, w: 2, h: 1 },
    { id: 'viewport-sub-s',     type: 'viewport', x: 25, y: 31, w: 3, h: 1 },

    // === PARTITION LINES: the four walls that make the rooms ==============
    // Each is a 1-thick line broken by 2-wide doorways (the gaps). Doorways are
    // aligned across the map so the halls read as long lanes (see sightline plan).
    // --- x=10 (west band | centre): doors at y4-5, y15-16 (core-W), y25-26 -----
    { id: 'wall-x10-a', type: 'wall-rect', x: 10, y: 1,  w: 1, h: 3, tex: 'PANEL' },
    { id: 'wall-x10-b', type: 'wall-rect', x: 10, y: 6,  w: 1, h: 9, tex: 'PANEL' },
    { id: 'wall-x10-c', type: 'wall-rect', x: 10, y: 17, w: 1, h: 8, tex: 'PANEL' },
    { id: 'wall-x10-d', type: 'wall-rect', x: 10, y: 27, w: 1, h: 4, tex: 'PANEL' },
    // --- x=21 (centre | east band): doors at y4-5, y15-16 (core-E), y25-26 -----
    { id: 'wall-x21-a', type: 'wall-rect', x: 21, y: 1,  w: 1, h: 3, tex: 'PANEL' },
    { id: 'wall-x21-b', type: 'wall-rect', x: 21, y: 6,  w: 1, h: 9, tex: 'PANEL' },
    { id: 'wall-x21-c', type: 'wall-rect', x: 21, y: 17, w: 1, h: 8, tex: 'PANEL' },
    { id: 'wall-x21-d', type: 'wall-rect', x: 21, y: 27, w: 1, h: 4, tex: 'PANEL' },
    // --- y=10 (north band | centre): doors at x4-5, x15-16 (core-N), x25-26 ----
    { id: 'wall-y10-a', type: 'wall-rect', x: 1,  y: 10, w: 3, h: 1, tex: 'PANEL' },
    { id: 'wall-y10-b', type: 'wall-rect', x: 6,  y: 10, w: 9, h: 1, tex: 'PANEL' },
    { id: 'wall-y10-c', type: 'wall-rect', x: 17, y: 10, w: 8, h: 1, tex: 'PANEL' },
    { id: 'wall-y10-d', type: 'wall-rect', x: 27, y: 10, w: 4, h: 1, tex: 'PANEL' },
    // --- y=21 (centre | south band): doors at x4-5, x15-16 (core-S), x25-26 ----
    { id: 'wall-y21-a', type: 'wall-rect', x: 1,  y: 21, w: 3, h: 1, tex: 'PANEL' },
    { id: 'wall-y21-b', type: 'wall-rect', x: 6,  y: 21, w: 9, h: 1, tex: 'PANEL' },
    { id: 'wall-y21-c', type: 'wall-rect', x: 17, y: 21, w: 8, h: 1, tex: 'PANEL' },
    { id: 'wall-y21-d', type: 'wall-rect', x: 27, y: 21, w: 4, h: 1, tex: 'PANEL' },

    // === REACTOR CORE (centre, x11-20 y11-20): the power position =========
    // Reactor block dead-centre blocks every straight cross-core shot; four
    // corner pylons give cover by each of the four doors; the mega-health sits
    // exposed on the south apron — grab it and you are lit from three doors.
    { id: 'reactor-core', type: 'wall-rect', x: 15, y: 15, w: 2, h: 2, tex: 'REACTOR' },
    { id: 'core-pylon-nw', type: 'wall-rect', x: 12, y: 12, w: 1, h: 1, tex: 'TECH' },
    { id: 'core-pylon-ne', type: 'wall-rect', x: 19, y: 12, w: 1, h: 1, tex: 'TECH' },
    { id: 'core-pylon-sw', type: 'wall-rect', x: 12, y: 19, w: 1, h: 1, tex: 'TECH' },
    { id: 'core-pylon-se', type: 'wall-rect', x: 19, y: 19, w: 1, h: 1, tex: 'TECH' },

    // === GALLERY (north, x11-20 y1-9): open duel hall under the window =====
    // Two pylons sit ON the y4-5 lane so the long E-W shot is a peek, not a rail.
    { id: 'gallery-pylon-w', type: 'wall-rect', x: 13, y: 4, w: 1, h: 1, tex: 'TECH' },
    { id: 'gallery-pylon-e', type: 'wall-rect', x: 18, y: 4, w: 1, h: 1, tex: 'TECH' },
    { id: 'gallery-console', type: 'wall-rect', x: 15, y: 7, w: 2, h: 1, tex: 'TECH' },

    // === CARGO HOLD (NE, x22-30 y1-9): a container CQC maze ===============
    { id: 'cargo-crate-1', type: 'wall-rect', x: 23, y: 2, w: 2, h: 2, tex: 'PILLAR' },
    { id: 'cargo-crate-2', type: 'wall-rect', x: 27, y: 3, w: 2, h: 2, tex: 'PILLAR' },
    { id: 'cargo-crate-3', type: 'wall-rect', x: 24, y: 6, w: 2, h: 1, tex: 'PILLAR' },
    { id: 'cargo-crate-4', type: 'wall-rect', x: 28, y: 6, w: 1, h: 2, tex: 'PILLAR' },

    // === MAINTENANCE WARREN (NW, x1-9 y1-9): cramped zig-zag corridors ====
    { id: 'warren-wall-1', type: 'wall-rect', x: 3, y: 1, w: 1, h: 5, tex: 'PANEL' },
    { id: 'warren-wall-2', type: 'wall-rect', x: 6, y: 4, w: 1, h: 6, tex: 'PANEL' },
    { id: 'warren-stub',   type: 'wall-rect', x: 7, y: 7, w: 2, h: 1, tex: 'PANEL' },

    // === WEST CONDUIT (x1-9 y11-20): mid-range flank lane, cover mid-lane ==
    { id: 'conduit-w-block', type: 'wall-rect', x: 4, y: 14, w: 2, h: 2, tex: 'PILLAR' },
    { id: 'conduit-w-crate', type: 'wall-rect', x: 7, y: 12, w: 1, h: 2, tex: 'PILLAR' },
    { id: 'conduit-w-rack',  type: 'wall-rect', x: 2, y: 18, w: 2, h: 1, tex: 'PANEL' },

    // === EAST CONDUIT (x22-30 y11-20): mid-range flank, distinct cover =====
    { id: 'conduit-e-block', type: 'wall-rect', x: 25, y: 14, w: 2, h: 2, tex: 'PILLAR' },
    { id: 'conduit-e-crate', type: 'wall-rect', x: 28, y: 17, w: 1, h: 2, tex: 'PILLAR' },
    { id: 'conduit-e-stub',  type: 'wall-rect', x: 23, y: 13, w: 1, h: 1, tex: 'TECH' },

    // === CRYO BAY (SW, x1-9 y22-30): fat cryo-pod pillars, mid cover =======
    { id: 'cryo-pod-1', type: 'wall-rect', x: 2, y: 23, w: 2, h: 2, tex: 'PILLAR' },
    { id: 'cryo-pod-2', type: 'wall-rect', x: 6, y: 26, w: 2, h: 2, tex: 'PILLAR' },
    { id: 'cryo-pod-3', type: 'wall-rect', x: 3, y: 28, w: 1, h: 1, tex: 'TECH' },

    // === BRIDGE (south, x11-20 y22-30): command consoles under S window ====
    { id: 'bridge-console-c', type: 'wall-rect', x: 14, y: 25, w: 2, h: 2, tex: 'TECH' },
    { id: 'bridge-console-w', type: 'wall-rect', x: 12, y: 23, w: 1, h: 1, tex: 'TECH' },
    { id: 'bridge-console-e', type: 'wall-rect', x: 19, y: 27, w: 1, h: 1, tex: 'TECH' },

    // === SUBSTATION (SE, x22-30 y22-30): big transformer with a walkway ====
    // The 3×3 block leaves a ring of floor around it — a little loop inside the room.
    // TECH (not REACTOR) so the orange emissive stays UNIQUE to the core: one glow,
    // one landmark — players learn "orange = centre" and orient by it.
    { id: 'sub-transformer', type: 'wall-rect', x: 25, y: 24, w: 3, h: 3, tex: 'TECH' },

    // === SPAWNS: one per ring room, tucked at a room edge facing inward ====
    // Rooms are walled from each other, so no spawn stares down another spawn.
    { id: 'spawn-warren',    type: 'spawn', x: 1.5,  y: 2.5,  ang: 0.6 },
    { id: 'spawn-gallery',   type: 'spawn', x: 12.5, y: 8.5,  ang: -1.0 },
    { id: 'spawn-cargo',     type: 'spawn', x: 29.5, y: 2.5,  ang: 2.5 },
    { id: 'spawn-conduit-w', type: 'spawn', x: 1.5,  y: 12.5, ang: -0.4 },
    { id: 'spawn-conduit-e', type: 'spawn', x: 30.5, y: 19.5, ang: 3.5 },
    { id: 'spawn-cryo',      type: 'spawn', x: 1.5,  y: 29.5, ang: -0.7 },
    { id: 'spawn-bridge',    type: 'spawn', x: 18.5, y: 23.5, ang: 1.4 },
    { id: 'spawn-sub',       type: 'spawn', x: 30.5, y: 29.5, ang: 3.9 },

    // === PICKUPS: placed to pull players across the map on risk/reward runs =
    { id: 'pickup-core-health', type: 'pickup', kind: 'health', x: 16, y: 18 },  // exposed core power spot
    { id: 'pickup-cargo-armor', type: 'pickup', kind: 'armor',  x: 29, y: 8 },   // deep in the NE maze
    { id: 'pickup-cryo-health', type: 'pickup', kind: 'health', x: 8,  y: 29 },  // SW corner
    { id: 'pickup-sub-armor',   type: 'pickup', kind: 'armor',  x: 23, y: 29 },  // behind the transformer
    { id: 'pickup-warren-health', type: 'pickup', kind: 'health', x: 1.5, y: 6 },// tucked in the warren

    // === WEAPON PICKUPS: walk over one to grab + switch to it (server-authoritative).
    // Placed to pull players across the map: the scattergun sits exposed in the
    // north gallery under the planet window; the plasma repeater is out on the west
    // conduit flank. (Add a { kind:'weapon', weapon:'railgun' } here once tinyclaw's
    // railgun stats land in WEAPONS — the pickup/switch system grants it for free.)
    { id: 'weapon-scatter', type: 'pickup', kind: 'weapon', weapon: 'scatter', x: 15.5, y: 3 },
    { id: 'weapon-plasma',  type: 'pickup', kind: 'weapon', weapon: 'plasma',  x: 2.5,  y: 15.5 },
  ],
};

// HANGAR BAY — a second deck (Seb). The signature is a HUGE north bay-door
// viewport: nearly the whole forward wall is open to space, so the planet/starfield
// is the backdrop to every north-facing duel. Cover is deliberately sparse and
// central — a docked dropship parked nose-to-the-door — leaving the flanks as long,
// open sightlines (the exact opposite of deck7's cluttered atrium and the cryo maze).
export const HANGAR_BAY = {
  id: 'hangar-bay',
  name: 'HANGAR BAY — DOCKING DECK',
  width: 32,
  height: 32,
  // A big amber world looming in the open bay door (distinct from deck7's blue).
  sky: { planetAzimuth: -1.5, planetTint: '#b6794a', planetSize: 0.5 },
  entities: [
    // --- shell -----------------------------------------------------------
    { id: 'hull-shell', type: 'wall-rect', x: 0, y: 0, w: 32, h: 32, tex: 'HULL', border: true },

    // --- the open bay door: a huge viewport spanning most of the north wall
    { id: 'viewport-baydoor-n', type: 'viewport', x: 3, y: 0, w: 26, h: 1 },
    // secondary ports so the planet is glimpsable from the flanks + aft
    { id: 'viewport-w', type: 'viewport', x: 0, y: 9, w: 1, h: 6 },
    { id: 'viewport-e', type: 'viewport', x: 31, y: 9, w: 1, h: 6 },
    { id: 'viewport-aft-s', type: 'viewport', x: 14, y: 31, w: 4, h: 1 },

    // --- the docked dropship: central cover, nose toward the bay door -----
    { id: 'dropship-nose', type: 'wall-rect', x: 15, y: 10, w: 2, h: 2, tex: 'TECH' },
    { id: 'dropship-fuselage', type: 'wall-rect', x: 15, y: 12, w: 2, h: 8, tex: 'HULL' },
    { id: 'dropship-wing-w', type: 'wall-rect', x: 12, y: 13, w: 3, h: 1, tex: 'PILLAR' },
    { id: 'dropship-wing-e', type: 'wall-rect', x: 17, y: 13, w: 3, h: 1, tex: 'PILLAR' },
    { id: 'dropship-thruster', type: 'wall-rect', x: 15, y: 20, w: 2, h: 1, tex: 'REACTOR' },

    // --- sparse flank cover: cargo containers + a couple of racks ---------
    { id: 'crate-nw', type: 'wall-rect', x: 7, y: 6, w: 2, h: 2, tex: 'PILLAR' },
    { id: 'crate-ne', type: 'wall-rect', x: 23, y: 6, w: 2, h: 2, tex: 'PILLAR' },
    { id: 'crate-sw', type: 'wall-rect', x: 7, y: 24, w: 2, h: 2, tex: 'PILLAR' },
    { id: 'crate-se', type: 'wall-rect', x: 23, y: 24, w: 2, h: 2, tex: 'PILLAR' },
    { id: 'rack-w', type: 'wall-rect', x: 9, y: 15, w: 1, h: 3, tex: 'PANEL' },
    { id: 'rack-e', type: 'wall-rect', x: 22, y: 15, w: 1, h: 3, tex: 'PANEL' },
    { id: 'barrier-s', type: 'wall-rect', x: 14, y: 25, w: 4, h: 1, tex: 'PANEL' },

    // --- spawns: ringed, each with a clear look at the bay door -----------
    { id: 'spawn-nw', type: 'spawn', x: 3.5, y: 4.5, ang: 0.9 },
    { id: 'spawn-ne', type: 'spawn', x: 28.5, y: 4.5, ang: 2.2 },
    { id: 'spawn-w', type: 'spawn', x: 3.5, y: 16, ang: 0 },
    { id: 'spawn-e', type: 'spawn', x: 28.5, y: 16, ang: 3.14 },
    { id: 'spawn-sw', type: 'spawn', x: 4.5, y: 27.5, ang: -0.8 },
    { id: 'spawn-se', type: 'spawn', x: 27.5, y: 27.5, ang: 3.9 },
    { id: 'spawn-s-w', type: 'spawn', x: 11, y: 28.5, ang: -1.4 },
    { id: 'spawn-s-e', type: 'spawn', x: 20, y: 28.5, ang: -1.7 },

    // --- pickups (billboards; wiring is a separate feature) --------------
    { id: 'pickup-baydoor-health', type: 'pickup', kind: 'health', x: 16, y: 4 },
    { id: 'pickup-w-armor', type: 'pickup', kind: 'armor', x: 3, y: 16 },
    { id: 'pickup-e-armor', type: 'pickup', kind: 'armor', x: 28, y: 16 },
    // weapon pickups: scattergun beside the docked dropship (central risk), plasma
    // out on the exposed east flank.
    { id: 'weapon-scatter', type: 'pickup', kind: 'weapon', weapon: 'scatter', x: 16, y: 22.5 },
    { id: 'weapon-plasma',  type: 'pickup', kind: 'weapon', weapon: 'plasma',  x: 28, y: 22 },

    // --- AIRLOCK OBJECTIVE (Seb): four consoles ringing the docked dropship,
    // each with a clear look north to the bay door. Capture all four to open the
    // door and vent the deck. The airlock region IS the huge north bay door.
    { id: 'console-nw', type: 'console', x: 5.5,  y: 10.5 },
    { id: 'console-ne', type: 'console', x: 26.5, y: 10.5 },
    { id: 'console-sw', type: 'console', x: 5.5,  y: 21.5 },
    { id: 'console-se', type: 'console', x: 26.5, y: 21.5 },
    { id: 'airlock-baydoor', type: 'airlock', x: 3, y: 0, w: 26, h: 2, dir: 'north' },
  ],
};

// Registry of all decks, keyed by id. `pickArena` resolves a map id (from the
// server's STARFRAG_MAP env or the client's ?map= param) back to its arena,
// falling back to the default derelict deck. Full rotation/voting between rounds
// is a separate open feature; this is just the lookup seam both sides share.
export const MAPS = {
  [ARENA.id]: ARENA,
  [HANGAR_BAY.id]: HANGAR_BAY,
};
export function pickArena(id) {
  return (id && MAPS[id]) || ARENA;
}

// Compile the named data into runtime structures. Pure function — same input,
// same output on client and server.
export function compileMap(arena = ARENA) {
  const W = arena.width, H = arena.height;
  const grid = new Int16Array(W * H); // 0 = floor, else TEX id
  const spawns = [];
  const pickups = [];
  const viewports = [];
  const consoles = [];   // airlock-objective capture points (floor devices, not solid)
  let airlock = null;    // the vent region (a bay door) the objective opens

  const put = (x, y, tex) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    grid[y * W + x] = tex;
  };

  for (const e of arena.entities) {
    switch (e.type) {
      case 'wall-rect': {
        const tex = TEX[e.tex] ?? TEX.HULL;
        for (let y = e.y; y < e.y + e.h; y++) {
          for (let x = e.x; x < e.x + e.w; x++) {
            if (e.border && x > e.x && x < e.x + e.w - 1 && y > e.y && y < e.y + e.h - 1) continue;
            put(x, y, tex);
          }
        }
        break;
      }
      case 'viewport': {
        for (let y = e.y; y < e.y + e.h; y++) {
          for (let x = e.x; x < e.x + e.w; x++) put(x, y, TEX.VIEWPORT);
        }
        viewports.push(e);
        break;
      }
      case 'spawn':
        spawns.push({ id: e.id, x: e.x, y: e.y, ang: e.ang || 0 });
        break;
      case 'pickup':
        // weapon pickups carry a `weapon` key; health/armor carry only `kind`.
        pickups.push({ id: e.id, kind: e.kind, x: e.x, y: e.y, weapon: e.weapon });
        break;
      // Airlock-objective entities. Consoles are floor devices (NOT put in the
      // grid — players stand on them to channel), the airlock is the vent region.
      case 'console':
        consoles.push({ id: e.id, x: e.x, y: e.y });
        break;
      case 'airlock':
        airlock = { id: e.id, x: e.x, y: e.y, w: e.w, h: e.h, dir: e.dir || 'north' };
        break;
    }
  }
  return { W, H, grid, spawns, pickups, viewports, consoles, airlock, id: arena.id, name: arena.name, sky: arena.sky };
}

// Is a world cell solid? VIEWPORT counts as solid wall for collision + occlusion.
export function isSolidCell(grid, W, H, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= W || cy >= H) return true;
  return grid[cy * W + cx] !== 0;
}

// DDA raycast shared by the client renderer (per-column walls) and the server
// (authoritative hitscan line-of-sight). Returns the first solid cell hit.
//   dx,dy must be a normalized-ish direction (any nonzero vector works).
// Result: { dist, tex, texX(0..1 along the wall face), side(0=x,1=y), mapX, mapY }
export function raycast(grid, W, H, px, py, dx, dy, maxDist = 64) {
  let mapX = Math.floor(px), mapY = Math.floor(py);
  const ddx = Math.abs(1 / dx), ddy = Math.abs(1 / dy);
  const stepX = dx < 0 ? -1 : 1, stepY = dy < 0 ? -1 : 1;
  let sdx = (dx < 0 ? (px - mapX) : (mapX + 1 - px)) * ddx;
  let sdy = (dy < 0 ? (py - mapY) : (mapY + 1 - py)) * ddy;
  let side = 0;
  for (let i = 0; i < 256; i++) {
    if (sdx < sdy) { sdx += ddx; mapX += stepX; side = 0; }
    else { sdy += ddy; mapY += stepY; side = 1; }
    if (mapX < 0 || mapY < 0 || mapX >= W || mapY >= H) break;
    const tex = grid[mapY * W + mapX];
    if (tex !== 0) {
      const dist = side === 0
        ? (mapX - px + (1 - stepX) / 2) / dx
        : (mapY - py + (1 - stepY) / 2) / dy;
      let wallX = side === 0 ? py + dist * dy : px + dist * dx;
      wallX -= Math.floor(wallX);
      let texX = wallX;
      if ((side === 0 && dx > 0) || (side === 1 && dy < 0)) texX = 1 - texX;
      return { dist: Math.max(dist, 0.01), tex, texX, side, mapX, mapY };
    }
    if (Math.min(sdx, sdy) > maxDist) break;
  }
  return { dist: maxDist, tex: 0, texX: 0, side: 0, mapX, mapY };
}
