// STARFRAG — static map validator (no browser, no server).
// Compiles a registered arena and asserts the invariants a fair deck must hold:
//   1. every spawn sits on open floor (not inside a wall / cover / the hull)
//   2. every pickup sits on open floor
//   3. the hull shell is closed — every perimeter cell is solid (viewports count
//      as solid: they're windows, not doors)
//   4. every spawn has a clear line of sight to at least one viewport (the
//      "always a window in view" rule from CONTRIBUTING)
// Exits non-zero if any map fails. Usage: node tools/validate-map.mjs [id ...]
import { MAPS, compileMap, isSolidCell, raycast, TEX } from '../shared/map.js';

const ids = process.argv.slice(2);
const targets = ids.length ? ids : Object.keys(MAPS);
let failed = false;

const seesAViewport = (m, x, y) => {
  // sample rays around the full circle; a spawn "sees a window" if the first
  // solid cell any ray hits is a VIEWPORT.
  for (let i = 0; i < 240; i++) {
    const a = (i / 240) * Math.PI * 2;
    const hit = raycast(m.grid, m.W, m.H, x, y, Math.cos(a), Math.sin(a), 64);
    if (hit.tex === TEX.VIEWPORT) return true;
  }
  return false;
};

for (const id of targets) {
  const arena = MAPS[id];
  const errs = [];
  const warns = [];
  if (!arena) { console.log(`✗ ${id}: not a registered map`); failed = true; continue; }
  const m = compileMap(arena);

  // 1 + 2: spawns and pickups on floor
  for (const s of m.spawns) {
    if (isSolidCell(m.grid, m.W, m.H, Math.floor(s.x), Math.floor(s.y)))
      errs.push(`spawn ${s.id} at (${s.x},${s.y}) is inside a solid cell`);
  }
  for (const p of m.pickups) {
    if (isSolidCell(m.grid, m.W, m.H, Math.floor(p.x), Math.floor(p.y)))
      errs.push(`pickup ${p.id} at (${p.x},${p.y}) is inside a solid cell`);
  }

  // 3: closed shell
  let gaps = 0;
  for (let x = 0; x < m.W; x++) { if (!isSolidCell(m.grid, m.W, m.H, x, 0)) gaps++; if (!isSolidCell(m.grid, m.W, m.H, x, m.H - 1)) gaps++; }
  for (let y = 0; y < m.H; y++) { if (!isSolidCell(m.grid, m.W, m.H, 0, y)) gaps++; if (!isSolidCell(m.grid, m.W, m.H, m.W - 1, y)) gaps++; }
  if (gaps) errs.push(`hull shell has ${gaps} open perimeter cell(s) — players can escape / rays leak`);

  // 4: spawn line-of-sight to a viewport
  let blind = 0;
  for (const s of m.spawns) if (!seesAViewport(m, s.x, s.y)) { blind++; warns.push(`spawn ${s.id} has no clear line to any viewport`); }

  const nSpawns = m.spawns.length, nViews = m.viewports.length, nPick = m.pickups.length;
  if (errs.length) {
    failed = true;
    console.log(`✗ ${id} — "${m.name}"  (${nSpawns} spawns, ${nViews} viewports, ${nPick} pickups)`);
    for (const e of errs) console.log(`    ERROR  ${e}`);
    for (const w of warns) console.log(`    warn   ${w}`);
  } else {
    console.log(`✓ ${id} — "${m.name}"  (${nSpawns} spawns, ${nViews} viewports, ${nPick} pickups, ${blind} blind spawns)`);
    for (const w of warns) console.log(`    warn   ${w}`);
  }
}

process.exit(failed ? 1 : 0);
