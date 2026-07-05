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

// The derelict orbital arena — one deck, symmetric-ish, lots of sightlines
// broken by cover, ringed with viewports so the planet is always somewhere.
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

    // --- viewports punched through the shell (windows to space) ----------
    // North wall: the big observation gallery — the planet hangs out here.
    { id: 'viewport-gallery-n', type: 'viewport', x: 9, y: 0, w: 14, h: 1 },
    // South wall: engineering-side ports.
    { id: 'viewport-aft-s', type: 'viewport', x: 6, y: 31, w: 8, h: 1 },
    { id: 'viewport-aft-s2', type: 'viewport', x: 19, y: 31, w: 8, h: 1 },
    // West + east slit windows.
    { id: 'viewport-w', type: 'viewport', x: 0, y: 12, w: 1, h: 8 },
    { id: 'viewport-e', type: 'viewport', x: 31, y: 12, w: 1, h: 8 },

    // --- central atrium cover: four tech pillars framing a reactor core ---
    { id: 'pillar-nw', type: 'wall-rect', x: 12, y: 12, w: 2, h: 2, tex: 'TECH' },
    { id: 'pillar-ne', type: 'wall-rect', x: 18, y: 12, w: 2, h: 2, tex: 'TECH' },
    { id: 'pillar-sw', type: 'wall-rect', x: 12, y: 18, w: 2, h: 2, tex: 'TECH' },
    { id: 'pillar-se', type: 'wall-rect', x: 18, y: 18, w: 2, h: 2, tex: 'TECH' },
    { id: 'reactor-core', type: 'wall-rect', x: 15, y: 15, w: 2, h: 2, tex: 'REACTOR' },

    // --- flanking cover blocks (break the long shots) --------------------
    { id: 'cover-nw', type: 'wall-rect', x: 6, y: 6, w: 3, h: 1, tex: 'PANEL' },
    { id: 'cover-ne', type: 'wall-rect', x: 23, y: 6, w: 3, h: 1, tex: 'PANEL' },
    { id: 'cover-sw', type: 'wall-rect', x: 6, y: 25, w: 3, h: 1, tex: 'PANEL' },
    { id: 'cover-se', type: 'wall-rect', x: 23, y: 25, w: 3, h: 1, tex: 'PANEL' },
    { id: 'cover-w', type: 'wall-rect', x: 5, y: 14, w: 1, h: 4, tex: 'PANEL' },
    { id: 'cover-e', type: 'wall-rect', x: 26, y: 14, w: 1, h: 4, tex: 'PANEL' },
    { id: 'crate-n', type: 'wall-rect', x: 15, y: 6, w: 2, h: 2, tex: 'PILLAR' },
    { id: 'crate-s', type: 'wall-rect', x: 15, y: 24, w: 2, h: 2, tex: 'PILLAR' },

    // --- spawns: ringed around the deck so nobody spawns on the core -----
    { id: 'spawn-nw', type: 'spawn', x: 3.5, y: 3.5, ang: 0.8 },
    { id: 'spawn-ne', type: 'spawn', x: 28.5, y: 3.5, ang: 2.4 },
    { id: 'spawn-sw', type: 'spawn', x: 3.5, y: 28.5, ang: -0.8 },
    { id: 'spawn-se', type: 'spawn', x: 28.5, y: 28.5, ang: 3.9 },
    { id: 'spawn-n', type: 'spawn', x: 16, y: 3.5, ang: 1.57 },
    { id: 'spawn-s', type: 'spawn', x: 16, y: 28.5, ang: -1.57 },
    { id: 'spawn-w', type: 'spawn', x: 3.5, y: 16, ang: 0 },
    { id: 'spawn-e', type: 'spawn', x: 28.5, y: 16, ang: 3.14 },

    // --- pickups (rendered as billboards; wiring is a claimable feature) --
    { id: 'pickup-core-health', type: 'pickup', kind: 'health', x: 16, y: 10 },
    { id: 'pickup-w-armor', type: 'pickup', kind: 'armor', x: 3, y: 16 },
    { id: 'pickup-e-armor', type: 'pickup', kind: 'armor', x: 29, y: 16 },
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
        pickups.push({ id: e.id, kind: e.kind, x: e.x, y: e.y });
        break;
    }
  }
  return { W, H, grid, spawns, pickups, viewports, id: arena.id, name: arena.name, sky: arena.sky };
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
