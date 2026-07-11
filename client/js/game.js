// STARFRAG — client. A 2.5D raycaster arena FPS in one canvas.
//
// Rendering technique is adapted from the HULLROT raycaster (per-column DDA
// walls, floor/ceiling casting, billboard sprites, a POV weapon viewmodel).
// Walls + floor sample real sprite-forge textures, the viewmodel is a keyed POV
// carbine sprite and enemies are a chroma-keyed trooper billboard (see
// assets/ART.md); the reactor emissive + starfield viewports stay procedural, and
// every art path falls back to procedural shading until its asset loads. The map,
// the wire protocol and the hitscan math all come from ../shared so client and
// server agree exactly.
import { WEAPONS, DEFAULT_WEAPON, WEAPON_SLOTS, C2S, S2C, OBJECTIVE, POWERUP } from '../shared/protocol.js';
import { compileMap, raycast, isSolidCell, TEX, pickArena } from '../shared/map.js';
import { Net } from './net.js';
import { createBot } from './bot.js';

// ---------------------------------------------------------------- setup
const SCREEN_W = 384, SCREEN_H = 240, HORIZON = SCREEN_H >> 1;
const FOV_HALF = 0.6;
const PROJ = (SCREEN_W / 2) / Math.tan(FOV_HALF);
const FOG_K = 0.085;

const params = new URLSearchParams(location.search);
// Which deck to render. ?map=<id> (e.g. hangar-bay) picks a registered arena;
// default is the derelict deck. The server authoritative-picks via STARFRAG_MAP —
// launch both with the same id (auto-sync between them is the map-rotation feature).
const world = compileMap(pickArena(params.get('map')));
const IS_BOT = params.get('bot') === '1';
const MY_NAME = (params.get('name') || (IS_BOT ? 'bot' : 'player')).slice(0, 16);

const screen = document.getElementById('screen');
const sctx = screen.getContext('2d');
sctx.imageSmoothingEnabled = false;
const img = new ImageData(SCREEN_W, SCREEN_H);
const fb = new Uint32Array(img.data.buffer);
const zbuf = new Float32Array(SCREEN_W);
const off = document.createElement('canvas');
off.width = SCREEN_W; off.height = SCREEN_H;
const octx = off.getContext('2d');

const packRGB = (r, g, b) => (255 << 24) | (b << 16) | (g << 8) | (r & 255);
const fog = (d) => Math.exp(-d * FOG_K);
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

// per-row floor/ceiling distance table
const rowDist = new Float32Array(SCREEN_H);
for (let y = HORIZON + 1; y < SCREEN_H; y++) rowDist[y] = (0.5 * PROJ) / (y - HORIZON + 0.5);

// ---------------------------------------------------------------- local player
const spawn0 = world.spawns[0];
const me = {
  x: spawn0.x, y: spawn0.y, ang: spawn0.ang,
  moving: 0, bobPhase: 0, strafeLean: 0,
  clip: WEAPONS[DEFAULT_WEAPON].clip, fireT: -1e9, reloadUntil: 0, wasReloading: false,
  dead: false, weapon: DEFAULT_WEAPON, id: null,
  // charge weapons (railgun): local hold clock for the HUD ring + viewmodel glow.
  // The SERVER owns the real charge (it times C2S.CHARGE→SHOOT); this is presentation.
  charging: false, chargeStart: 0,
  // per-weapon ammo mirror of the server loadout; `owned` = the ownership set.
  // Updated authoritatively by S2C.WEAPON (pickup / switch / reload / respawn), and
  // predicted locally between messages so the viewmodel + ammo HUD feel instant.
  clips: { [DEFAULT_WEAPON]: WEAPONS[DEFAULT_WEAPON].clip },
  owned: new Set([DEFAULT_WEAPON]),
};
const cam = { kickY: 0, kickX: 0, roll: 0, dmgFlash: 0, shake: 0, hitstop: 0,
  ventOffX: 0, ventOffY: 0, ventFlash: 0, door: 0, bodyPull: 0 };
const vm = { flash: 0, kick: 0, rail: 0, railCf: 0 };   // viewmodel fx (rail = first-person railgun beam flash)
// reactive crosshair: bloom grows with recoil/movement + tightens when still;
// hit/kill are hit-marker pips that pop on a confirmed landed shot (server truth).
const cross = { bloom: 0, hit: 0, kill: 0 };
let started = IS_BOT;                          // bots skip the click-to-start gate
const flashUntil = new Map();                 // playerId -> ms, remote muzzle flash
const killfeed = [];                          // { text, until }

// weapon pickups on the map. Positions come from the compiled deck; AVAILABILITY is
// server-authoritative (seeded in welcome, toggled by S2C.PICKUP). The client only
// renders the glowing pads and never decides a grab (server proximity owns that).
const weaponSpots = world.pickups.filter((p) => p.kind === 'weapon');
// sustain items (health / armor / ammo) — billboards in their kind's colour; availability
// is server-authoritative (S2C.PICKUP), the effect lands as hp/armor via S2C.STATE.
const itemSpots = world.pickups.filter((p) => p.kind === 'health' || p.kind === 'armor' || p.kind === 'ammo');
const pickupTaken = new Map();                 // pickup id -> true while grabbed (pad dark)
let pickupToast = { text: '', until: 0 };      // brief "PICKED UP <NAME>" banner
let lastTradeEvent = null;                     // last SYMMETRIC-TRADE toast I fired (sticky; QA reads it via __game.lastTrade)
// per-kind billboard colour + short label for the sustain items above.
const ITEM_STYLE = {
  health: { rgb: [90, 240, 130], label: '+HEALTH' },
  mega:   { rgb: [120, 230, 255], label: 'MEGA HEALTH' },
  armor:  { rgb: [120, 180, 255], label: '+ARMOR' },
  ammo:   { rgb: [255, 210, 90],  label: '+AMMO' },
};
const itemStyleFor = (pk) => (pk.kind === 'health' && pk.mega) ? ITEM_STYLE.mega : ITEM_STYLE[pk.kind];

// THE QUAD (deck7v2) — a TELEGRAPHED TIMED powerup: a far-corner pad that glows up on a
// fixed cycle with a HUD clock ("QUAD 0:12"), so everyone knows WHEN it's contested — the
// anti-snowball / casual on-ramp. The cycle is keyed to the WALL CLOCK (shared constants,
// so the SERVER gates the grab to the SAME window — telegraph and server truth agree). A
// grabbed pad goes dark via S2C.PICKUP; the carrier's damage multiplier + billboard tint +
// holder countdown are all driven by the server (STATE `quad` = ms left).
const powerSpots = world.pickups.filter((p) => p.kind === 'quad');
const QUAD_CYCLE_MS = POWERUP.QUAD_CYCLE_MS, QUAD_READY_MS = POWERUP.QUAD_READY_MS, QUAD_RAMP_MS = POWERUP.QUAD_RAMP_MS;
function quadState() {
  const ph = Date.now() % QUAD_CYCLE_MS;
  const ready = ph < QUAD_READY_MS;
  const secs = Math.ceil((ready ? QUAD_READY_MS - ph : QUAD_CYCLE_MS - ph) / 1000);   // ready: time left; else: time to next
  const ramp = ready ? 1 : Math.max(0, 1 - (QUAD_CYCLE_MS - ph) / QUAD_RAMP_MS);       // 0..1 build-up before ready
  return { ready, secs, ramp };
}
const QUAD_RGB = [200, 110, 255];

// ---------------------------------------------------------------- airlock objective (client render only)
// PURELY COSMETIC. The server (S2C.OBJECTIVE, 20Hz) owns every truth — who owns a
// console, when the door opens, who wins, who is vented. This client half only
// READS `objState` and paints it: console props + capture rings, the bay-door
// crank, the vent suck-toward-the-door drama, and the objective HUD. It makes ZERO
// authoritative decisions (see docs/objective-contract.md).
//   objState — latest OBJECTIVE snapshot (or welcome.objective), null on deck7.
//   prevObj  — last snapshot, for edge-triggered SFX (arm / door-crank / vent).
const airlock = world.airlock;                // static rect (a bay door, or deck7v2's core-implosion region), null on deathmatch
// Per-arena objective THEME + TIMING (the client compiles this arena locally, so it
// reads labels/timing straight from the data — nothing rides the wire). deck7v2 themes
// the SAME machine as "OVERLOAD THE CORE" with a long telegraphed countdown; hangar-bay
// omits `objective`, so these fall back to the airlock defaults.
const OBJ_LABELS = (world.objective && world.objective.labels) || {};
const OBJ_TIMING = {
  DOOR_OPEN_MS: OBJECTIVE.DOOR_OPEN_MS, VENT_MS: OBJECTIVE.VENT_MS,
  ...((world.objective && world.objective.timing) || {}),
};
let objState = null;
let prevObj = null;
// Edge-detect phase/console changes to fire one-shot SFX + FX (no per-frame spam).
function onObjective(m) {
  const prev = prevObj;
  // a console just finished capturing -> confirm chirp
  if (prev && m.consoles) {
    for (const c of m.consoles) {
      const pc = prev.consoles && prev.consoles.find((x) => x.id === c.id);
      if (c.armed && pc && !pc.armed) playSfx('console-arm', 0.55);
    }
  }
  if (prev && prev.phase !== m.phase) {
    if (m.phase === 'opening') playSfx('door-crank', 0.7);   // door begins to crank
    if (m.phase === 'venting') {                             // the deck blows
      playSfx('vent-whoosh', 0.85);
      cam.ventFlash = 1; cam.shake += 4.5;
    }
  }
  objState = m;
  prevObj = m;
}
// Where the vent sucks toward: the airlock rect's inner mouth (world cells).
function airlockPull() {
  if (!airlock) return null;
  const cx = airlock.x + airlock.w / 2;
  // pull toward the door plane just inside the rect (north door => small y)
  const cy = airlock.dir === 'south' ? airlock.y : airlock.y + airlock.h * 0.5;
  return { cx, cy };
}

// ---------------------------------------------------------------- combat feel: particles + bolts
// COMBAT-FEEL PASS (technique adapted from HULLROT's feel layer, sxs-doom/h-feel).
// Two client-side world-space systems, both PURELY COSMETIC — the server still
// owns every damage/kill decision (see resolveShot); the client only reacts to
// S2C.HIT / S2C.KILL / S2C.SHOT to paint what already happened.
//
//   particles[] — blood & sparks with (x,y,z) gravity; blood SETTLES into a
//                 persistent floor splat, so a fought-over spot stays painted.
//   bolts[]     — plasma projectiles that TRAVEL: spawned on every shot (mine +
//                 remotes, from S2C.SHOT), advance each frame, stop on a wall
//                 (spark + impact sfx). v1 IS CLIENT-VISUAL — damage is still the
//                 server's instant hitscan, so a bolt you dodge on screen may have
//                 already registered. Server-authoritative travel is the follow-up
//                 (spawn/advance/collide the bolt on server.mjs, damage on arrival).
const MAX_PARTICLES = 260, MAX_SPLATS = 140, MAX_BOLTS = 48, MAX_BEAMS = 8;
let particles = [];   // { x,y,z, dx,dy,dz, life, r,g,b, size, settle }
let splats = [];      // settled gore: { x,y, r,g,b, size } — persistent, FIFO-capped
let bolts = [];       // { x,y, dx,dy, life, r,g,b, own }
// railgun rails: a bright INSTANT beam from shooter along the shot ray, drawn full
// for a beat then faded. Unlike bolts it does not travel and is not wall-stopped — it
// draws THROUGH walls (dimmed) to sell the pierce. cf (0..1) = charge → brightness/width.
let beams = [];       // { x,y, dx,dy, len, life, maxLife, cf }
const RAIL_RGB = hexRGB((WEAPONS.railgun && WEAPONS.railgun.color) || '#c86bff');   // rail tint, parsed once

function spawnBurst(x, y, z, n, opts = {}) {
  if (IS_BOT) return;   // headless bot clients don't need the gore — save the box's CPU
  const { dirX = 0, dirY = 0, spread = 1, speed = 2.4, up = 1.5,
    r = 176, g = 20, b = 14, size = 1.5, settle = true, life = 1.1 } = opts;
  for (let i = 0; i < n; i++) {
    if (particles.length >= MAX_PARTICLES) break;
    const a = Math.random() * 2 * Math.PI;
    const sp = (0.3 + Math.random() * 0.7) * speed;
    const kR = 0.72 + Math.random() * 0.5;
    particles.push({
      x, y, z: z + (Math.random() - 0.5) * 0.12,
      dx: dirX * sp * 0.8 + Math.cos(a) * sp * spread * 0.45,
      dy: dirY * sp * 0.8 + Math.sin(a) * sp * spread * 0.45,
      dz: (Math.random() * 0.9 + 0.25) * up,
      life: life * (0.6 + Math.random() * 0.7),
      r: Math.min(255, r * kR) | 0, g: Math.min(255, g * kR) | 0, b: Math.min(255, b * kR) | 0,
      size: size * (0.7 + Math.random() * 0.7),
      settle,
    });
  }
}
function tickParticles(dt) {
  for (const p of particles) {
    p.life -= dt;
    p.x += p.dx * dt; p.y += p.dy * dt;
    p.dz -= 5.4 * dt;                    // gravity (z: 0 floor .. 1 ceiling-ish)
    p.z += p.dz * dt;
    if (isSolidCell(world.grid, world.W, world.H, p.x | 0, p.y | 0)) { p.life = 0; continue; }
    if (p.z <= 0.02) {                   // hits the deck
      if (p.settle) {
        splats.push({ x: p.x, y: p.y, r: (p.r * 0.5) | 0, g: (p.g * 0.5) | 0, b: (p.b * 0.5) | 0, size: p.size * 1.5 });
        if (splats.length > MAX_SPLATS) splats.shift();
      }
      p.life = 0;
    }
  }
  if (particles.length) particles = particles.filter((p) => p.life > 0);
}

// One traveling projectile. `own` bolts (mine) glow the weapon colour; incoming
// glow hot. opts overrides colour/speed/life so a scattergun can fan out short-lived
// orange pellets while the plasma/carbine fling one fast bolt.
function spawnBolt(x, y, ang, own, opts = {}) {
  if (IS_BOT) return;
  if (bolts.length >= MAX_BOLTS) bolts.shift();
  const speed = opts.speed ?? 30;                   // world-units/sec — fast plasma, still visibly travels
  bolts.push({
    x: x + Math.cos(ang) * 0.35, y: y + Math.sin(ang) * 0.35,
    dx: Math.cos(ang) * speed, dy: Math.sin(ang) * speed,
    life: opts.life ?? 1.4, own,
    r: opts.r ?? (own ? 120 : 255), g: opts.g ?? (own ? 235 : 150), b: opts.b ?? (own ? 255 : 90),
  });
}
function tickBolts(dt) {
  for (const b of bolts) {
    b.life -= dt;
    const nx = b.x + b.dx * dt, ny = b.y + b.dy * dt;
    if (isSolidCell(world.grid, world.W, world.H, nx | 0, ny | 0)) {
      // slammed into a wall: spark puff + impact ping, then die
      const inv = 1 / Math.hypot(b.dx, b.dy);
      spawnBurst(b.x, b.y, 0.5, 7, {
        dirX: -b.dx * inv, dirY: -b.dy * inv, speed: 2.0, up: 1.1, spread: 1.2,
        r: 255, g: 210, b: 120, size: 1.1, settle: false, life: 0.35,
      });
      if (b.own) playSfx('impact', 0.4);
      b.life = 0; continue;
    }
    b.x = nx; b.y = ny;
  }
  if (bolts.length) bolts = bolts.filter((b) => b.life > 0);
}
// One instant railgun rail. Drawn (drawBeam, in the render pass) from (x,y) along the
// ray for `len` cells; no travel, no collision. cf scales brightness + thickness.
function spawnBeam(x, y, ang, len, cf) {
  if (IS_BOT) return;
  if (beams.length >= MAX_BEAMS) beams.shift();
  beams.push({ x, y, dx: Math.cos(ang), dy: Math.sin(ang), len, life: 0.26, maxLife: 0.26, cf: Math.max(0, Math.min(1, cf)) });
}
function tickBeams(dt) {
  for (const b of beams) b.life -= dt;
  if (beams.length) beams = beams.filter((b) => b.life > 0);
}

// ---------------------------------------------------------------- assets (procedural)
// One neutral-gray trooper sprite, tinted per player at draw time.
function makeTrooper() {
  const w = 30, h = 46, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  const rr = (x, y, ww, hh, col) => { g.fillStyle = col; g.fillRect(x, y, ww, hh); };
  // legs
  rr(9, 32, 4, 13, '#5a5a5a'); rr(17, 32, 4, 13, '#5a5a5a');
  rr(9, 43, 5, 3, '#3a3a3a'); rr(16, 43, 5, 3, '#3a3a3a');
  // torso (mid gray so a color multiply reads as that color, with edge shading)
  rr(8, 16, 14, 18, '#6e6e6e');
  rr(8, 16, 3, 18, '#565656'); rr(19, 16, 3, 18, '#565656');
  rr(10, 18, 10, 4, '#8a8a8a');                 // chest plate highlight
  // arms + slung rifle
  rr(5, 18, 4, 12, '#606060'); rr(21, 18, 4, 12, '#606060');
  rr(3, 24, 24, 3, '#2c2c2c');                  // rifle across the body
  // head + helmet + visor (visor stays brightish through the tint)
  rr(10, 5, 10, 11, '#767676'); rr(10, 5, 10, 3, '#8c8c8c');
  rr(11, 9, 8, 3, '#bfeaff');                   // cyan visor slit
  return { w, h, px: new Uint32Array(g.getImageData(0, 0, w, h).data.buffer) };
}
const trooper = makeTrooper();

// ---------------------------------------------------------------- assets (real art)
// sprite-forge output wired in: sci-fi wall/floor textures, a POV pulse-carbine
// viewmodel, and an enemy trooper billboard. Everything loads async and every draw
// path falls back to the procedural version above until its asset is ready, so
// liveness never depends on the network. Sprite magenta is removed with the forge
// keyer (forge/animate.md): m = min(r,b) - g; m>52 -> transparent; 18<m<=52 ->
// despill r,b -= (m-18)*0.8. Provenance: client/assets/ART.md.
const ART_DIR = 'assets/art/';

// Opaque power-of-two texture -> packed-RGBA Uint32Array we can sample per pixel.
function loadWallTex(src, size = 256) {
  const t = { px: null, size };
  const im = new Image();
  im.onload = () => {
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = true;
    g.drawImage(im, 0, 0, size, size);
    t.px = new Uint32Array(g.getImageData(0, 0, size, size).data.buffer);
  };
  im.onerror = () => console.warn('tex load failed:', src);
  im.src = src;
  return t;
}

// Chroma-key a magenta sprite, crop to its bounding box, hand back both a packed
// Uint32Array (for the software billboard blitter) and a canvas (for ctx.drawImage).
function loadSprite(src, cb) {
  const im = new Image();
  im.onload = () => {
    const W = im.naturalWidth, H = im.naturalHeight;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const id = g.getImageData(0, 0, W, H), d = id.data;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const m = Math.min(r, b) - gg;
      if (m > 52) { d[i + 3] = 0; continue; }
      if (m > 18) { const k = (m - 18) * 0.8; d[i] = Math.max(0, r - k) | 0; d[i + 2] = Math.max(0, b - k) | 0; }
      const x = p % W, y = (p / W) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX < minX) { minX = 0; minY = 0; maxX = W - 1; maxY = H - 1; }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const cc = document.createElement('canvas'); cc.width = bw; cc.height = bh;
    const gc = cc.getContext('2d');
    const cid = gc.createImageData(bw, bh), cd = cid.data;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const s = ((y + minY) * W + (x + minX)) * 4, o = (y * bw + x) * 4;
      cd[o] = d[s]; cd[o + 1] = d[s + 1]; cd[o + 2] = d[s + 2]; cd[o + 3] = d[s + 3];
    }
    gc.putImageData(cid, 0, 0);
    cb({ w: bw, h: bh, canvas: cc, px: new Uint32Array(cid.data.buffer) });
  };
  im.onerror = () => console.warn('sprite load failed:', src);
  im.src = src;
}

const WALLTEX = {
  [TEX.HULL]: loadWallTex(ART_DIR + 'wall_hull.png'),
  [TEX.TECH]: loadWallTex(ART_DIR + 'wall_tech.png'),
  [TEX.PANEL]: loadWallTex(ART_DIR + 'wall_panel.png'),
  [TEX.PILLAR]: loadWallTex(ART_DIR + 'wall_hull.png'),
};
const deckTex = loadWallTex(ART_DIR + 'floor_deck.png');
let gunSprite = null;
loadSprite(ART_DIR + 'carbine.png', (s) => { gunSprite = s; });

// --- animated weapon viewmodels (sprite-forge VIDEO→FRAMES pipeline) ----------
// The scattergun + plasma repeater are square POV frames authored on #FF00FF (hero
// still, plus FIRE and RELOAD strips extracted from a kling img2vid and repaired).
// Unlike the carbine sprite they are loaded UNCROPPED — every frame shares one 512²
// space so the animation never jitters — and chroma-keyed with the SAME keyer, in a
// canvas we can drawImage. `meta` tunes how big/low each viewmodel sits + where its
// muzzle is (flash overlay). Frames that don't exist yet just never load (hero-only).
function loadFrame(src, cb) {
  const im = new Image();
  im.onload = () => {
    const W = im.naturalWidth, H = im.naturalHeight;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const id = g.getImageData(0, 0, W, H), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const m = Math.min(r, b) - gg;
      if (m > 52) { d[i + 3] = 0; continue; }
      if (m > 18) { const k = (m - 18) * 0.8; d[i] = Math.max(0, r - k) | 0; d[i + 2] = Math.max(0, b - k) | 0; }
    }
    g.putImageData(id, 0, 0);
    cb({ canvas: c, w: W, h: H });
  };
  im.onerror = () => {};   // frame not generated (yet) — hero-only weapon still works
  im.src = src;
}
const WEAPON_ART = {
  // Square POV frames. `topFrac` = where the visible weapon's TOP (barrel tip) sits
  // within the square, measured from the top (heroes: scatter barrels ~0.24 down,
  // plasma barrel ~0.15 down). drawGun sizes each frame so that barrel tip lands at
  // a fixed low screen line — the gun stays in the BOTTOM ~46% of the view and never
  // balloons on wide-short (mobile-landscape) aspects. See GUN_TOP_Y in drawGun.
  scatter: { hero: null, fire: [], reload: [], meta: { topFrac: 0.24 } },
  plasma:  { hero: null, fire: [], reload: [], meta: { topFrac: 0.15 } },
  // railgun adds a CHARGE strip (indexed by charge fraction 0→1, not by time): the coils
  // spin up + the muzzle brightens as you hold. hero + fire + reload as usual. Until BMO's
  // frames land in assets/art/railgun/, hero is null and drawGun's procedural charge glow
  // carries it. `charge` count must match the frames BMO ships (coordinated on the branch).
  railgun: { hero: null, charge: [], fire: [], reload: [], meta: { topFrac: 0.20 } },
};
function loadWeaponArt(key, counts = {}) {
  const art = WEAPON_ART[key]; if (!art) return;
  loadFrame(`${ART_DIR}${key}/hero.png`, (f) => { art.hero = f; });
  for (const [kind, n] of Object.entries(counts)) {
    art[kind] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) loadFrame(`${ART_DIR}${key}/${kind}/f${i}.png`, (f) => { art[kind][i] = f; });
  }
}
loadWeaponArt('scatter', { reload: 8, fire: 5 });
loadWeaponArt('plasma',  { reload: 8, fire: 5 });
loadWeaponArt('railgun', { charge: 8, reload: 8, fire: 5 });   // BMO's strips: charge 8 (indexed 0→1), reload 8, fire 5

// 8-way directional enemy billboards (Doom/Build-engine style). Index = the VIEW
// the camera sees, going around the compass from S(front) counter-clockwise:
// [0:S 1:SE 2:E 3:NE 4:N 5:NW 6:W 7:SW]. S(front) reuses the canonical trooper.png;
// the other 7 are gpt-image-2 img2img angle-derivations of it (identity-locked,
// same armor/helmet/carbine — see ART.md). Each loads async; any slot not yet
// loaded falls back to the front sprite, then to the procedural trooper. The frame
// is chosen per-enemy from the angle between our line-of-sight and their server yaw.
const DIR8_FILES = ['trooper.png', 'trooper_se.png', 'trooper_e.png', 'trooper_ne.png',
                    'trooper_n.png', 'trooper_nw.png', 'trooper_w.png', 'trooper_sw.png'];
const trooperDir = new Array(8).fill(null);
DIR8_FILES.forEach((f, i) => loadSprite(ART_DIR + f, (s) => { trooperDir[i] = s; }));
// -1 because the world is y-down (left-handed): a west-facing enemy must read as
// facing screen-left. This mirrors the two side-arcs (front/back anchors are fixed).
// Verified by screenshot (tools/verify-dir8.mjs): the sign that makes a strafing
// enemy show the correct side and the on-screen facing match its world yaw.
const DIR8_HANDED = -1;
// Pick the directional sprite for enemy p as seen from the viewer at (me.x,me.y).
// rel = enemyYaw - angle(enemy->viewer): 0 => they face us (front/S), π => their
// back (N), ±π/2 => a side. Quantize to 8 buckets; fall back while art loads.
function pickTrooper(p) {
  const front = trooperDir[0];
  if (!front || !front.px) return { spr: trooper, real: false };
  const angToViewer = Math.atan2(me.y - p.y, me.x - p.x);
  let bucket = Math.round(((p.ang || 0) - angToViewer) / (Math.PI / 4));
  bucket = (((bucket * DIR8_HANDED) % 8) + 8) % 8;
  const cand = trooperDir[bucket];
  return { spr: (cand && cand.px) ? cand : front, real: true };
}

// ---------------------------------------------------------------- sky / viewport
// The planet's base colour is the deck's sky.planetTint (parsed once here — skyPixel
// runs per-pixel), falling back to the classic blue. Lets each deck hang its own world.
const PLANET_RGB = (() => {
  const hex = String((world.sky && world.sky.planetTint) || '').replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) { const n = parseInt(hex, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  return [0x5a, 0x7f, 0xa8];
})();
// A pixel of the window-to-space: rotating planet + twinkling starfield, keyed
// to view azimuth so turning pans it and walking never smears it.
function skyPixel(az, y, t) {
  const sky = world.sky;
  // planet
  const dAz = angDiff(az, sky.planetAzimuth);
  const pdx = dAz * PROJ;
  const pcY = HORIZON - 2;
  const pdy = y - pcY;
  const R = sky.planetSize * PROJ * 1.05;
  const r2 = pdx * pdx + pdy * pdy;
  if (r2 < R * R) {
    const nx = pdx / R, ny = pdy / R, nz = Math.sqrt(Math.max(0, 1 - r2 / (R * R)));
    const lon = Math.atan2(nx, nz) + t * 0.03;
    const band = 0.5 + 0.5 * Math.sin(ny * 8 + Math.sin(lon * 2.3) * 0.7);
    let light = nx * -0.45 + ny * -0.35 + nz * 0.9;   // sun from upper-left-front
    light = Math.max(0.06, Math.min(1, light));
    const atmo = r2 > R * R * 0.86 ? 1.5 : 1;           // brighter limb
    const br = (0.35 + 0.65 * band) * light * atmo;
    const cr = PLANET_RGB[0], cg = PLANET_RGB[1], cb = PLANET_RGB[2];   // deck's sky.planetTint
    return packRGB(Math.min(255, cr * br * 1.4) | 0, Math.min(255, cg * br * 1.4) | 0, Math.min(255, cb * br * 1.6) | 0);
  }
  // stars
  const su = (az * 240) | 0;
  let h = (su * 374761393) ^ (y * 668265263);
  h = ((h ^ (h >> 13)) * 1274126177) | 0; h = (h ^ (h >> 16)) >>> 0;
  const v = h & 1023;
  if (v < 5) {
    const tw = 0.7 + 0.3 * Math.sin(t * (1.5 + (h >> 12 & 3)) + (h >> 8 & 63));
    const b = ((150 + (h >> 11 & 105)) * tw) | 0;
    return packRGB(b, b, Math.min(255, b + 20));
  }
  if (v < 20) { const b = 34 + (h >> 11 & 40); return packRGB(b * 0.8 | 0, b * 0.85 | 0, b); }
  return packRGB(6, 8, 16); // the void, faintly blue
}

// A pixel of a bay-door blast leaf: gunmetal with horizontal ridges, a diagonal
// hazard-chevron stripe across the middle, and a pulsing warning glow on the
// leading edge as it cranks. v = vertical 0..1, df = across-door 0..1, edge = 0..1
// proximity to the moving leaf edge, t = seconds.
function doorPixel(v, df, edge, t) {
  let r = 38, g = 43, b = 52;
  const band = (v * 22) % 1;                         // ridge lines down the leaf
  if (band < 0.14) { r += 22; g += 24; b += 28; }
  else if (band > 0.84) { r -= 12; g -= 12; b -= 12; }
  if (v > 0.4 && v < 0.6) {                          // hazard chevron stripe
    const hz = ((v + df) * 12) % 1;
    if (hz < 0.5) { r = 156; g = 116; b = 26; } else { r = 26; g = 25; b = 22; }
  }
  if (edge > 0.01) {                                 // leading-edge warning glow
    const pu = 0.55 + 0.45 * Math.sin(t * 8);
    r = Math.min(255, r + edge * 220 * pu);
    g = Math.min(255, g + edge * 120 * pu);
    b = Math.min(255, b + edge * 26 * pu);
  }
  return packRGB(r | 0, g | 0, b | 0);
}

// ---------------------------------------------------------------- renderer
const WALLCOL = {
  [TEX.HULL]: [96, 88, 78], [TEX.TECH]: [74, 92, 116], [TEX.PANEL]: [128, 126, 134],
  [TEX.PILLAR]: [128, 104, 66], [TEX.REACTOR]: [255, 150, 48],
};

function render(t) {
  const dirX = Math.cos(me.ang), dirY = Math.sin(me.ang);
  // camera ORIGIN = true position + the vent suck offset (render-only; the real
  // me.x/me.y is what we still send to the server, so the pull moves nothing).
  const ex = me.x + cam.ventOffX, ey = me.y + cam.ventOffY;
  const tanH = Math.tan(FOV_HALF);
  const planeX = -dirY * tanH, planeY = dirX * tanH;

  // --- floor & ceiling (procedural deck grid, cheap) ---
  const rdx0 = dirX - planeX, rdy0 = dirY - planeY;
  const rdx1 = dirX + planeX, rdy1 = dirY + planeY;
  for (let y = HORIZON + 1; y < SCREEN_H; y++) {
    const d = rowDist[y];
    const m = fog(d);
    let fx = ex + d * rdx0, fy = ey + d * rdy0;
    const sx = (d * (rdx1 - rdx0)) / SCREEN_W, sy = (d * (rdy1 - rdy0)) / SCREEN_W;
    let fi = y * SCREEN_W;
    const ci = (2 * HORIZON - y) * SCREEN_W;
    const dt = deckTex.px, dsz = deckTex.size, dmask = dsz - 1;
    for (let x = 0; x < SCREEN_W; x++, fi++) {
      const gx = fx - Math.floor(fx), gy = fy - Math.floor(fy);
      const seam = (gx < 0.045 || gy < 0.045);
      // floor: real deck-plate texture (one plate per world cell), fog-shaded
      if (dt) {
        const px = dt[(((gy * dsz) | 0) & dmask) * dsz + (((gx * dsz) | 0) & dmask)];
        fb[fi] = packRGB((px & 255) * m | 0, ((px >> 8) & 255) * m | 0, ((px >> 16) & 255) * m | 0);
      } else {
        const fr = seam ? 78 : 52, fg = seam ? 82 : 55, fbl = seam ? 92 : 62;
        fb[fi] = packRGB(fr * m | 0, fg * m | 0, fbl * m | 0);
      }
      // ceiling: darker, pipes (kept procedural — reads as unlit deckhead)
      if (ci >= 0) { const cm = m * 0.7; fb[ci + x] = packRGB((seam ? 40 : 22) * cm | 0, (seam ? 42 : 24) * cm | 0, (seam ? 50 : 30) * cm | 0); }
      fx += sx; fy += sy;
    }
  }

  // --- walls ---
  for (let x = 0; x < SCREEN_W; x++) {
    const cameraX = (2 * x) / SCREEN_W - 1;
    const rdx = dirX + planeX * cameraX, rdy = dirY + planeY * cameraX;
    const hit = raycast(world.grid, world.W, world.H, ex, ey, rdx, rdy, 64);
    const dist = hit.dist;
    zbuf[x] = dist;
    const lineH = PROJ / dist;
    let y0 = (HORIZON - lineH / 2) | 0, y1 = (HORIZON + lineH / 2) | 0;
    const cy0 = Math.max(0, y0), cy1 = Math.min(SCREEN_H, y1);

    if (hit.tex === TEX.VIEWPORT) {
      const az = Math.atan2(rdy, rdx);
      // BAY-DOOR: on the airlock viewport, blast leaves shut over the window and
      // CRANK apart as the objective opens (cam.door 0=shut .. 1=open). Two leaves
      // meet at centre and retract to the sides. Cosmetic — reads the OBJECTIVE phase.
      const isBayDoor = airlock && hit.mapY === airlock.y &&
                        hit.mapX >= airlock.x && hit.mapX < airlock.x + airlock.w;
      let covered = false, edge = 0, df = 0;
      if (isBayDoor) {
        df = (hit.mapX + hit.texX - airlock.x) / airlock.w;   // 0..1 across the door
        df = df < 0 ? 0 : df > 1 ? 1 : df;
        const lead = (1 - cam.door) * 0.5;                    // each leaf reaches this far in
        covered = (df <= lead || df >= 1 - lead);
        edge = Math.max(0, 1 - Math.min(Math.abs(df - lead), Math.abs(df - (1 - lead))) * 20);
      }
      let fi = cy0 * SCREEN_W + x;
      for (let y = cy0; y < cy1; y++, fi += SCREEN_W) {
        const v = (y - y0) / lineH;
        // metal window frame top & bottom
        if (v < 0.1 || v > 0.9) { const m = fog(dist); fb[fi] = packRGB(60 * m | 0, 62 * m | 0, 70 * m | 0); }
        else if (covered) fb[fi] = doorPixel(v, df, edge, t);
        else fb[fi] = skyPixel(az, y, t);
      }
      continue;
    }

    const side = hit.side === 1 ? 0.76 : 1;
    let m = fog(dist) * side;
    let er = 0, eg = 0, eb = 0;
    if (hit.tex === TEX.REACTOR) { const pulse = 0.7 + 0.3 * Math.sin(t * 4 + hit.mapX); m = Math.max(m, 0.55) * pulse + 0.25; er = 60 * pulse; eg = 26 * pulse; }
    const tex = WALLTEX[hit.tex];
    let fi = cy0 * SCREEN_W + x;
    if (tex && tex.px && hit.tex !== TEX.REACTOR) {
      // textured wall: sample the sci-fi panel per column (texX) and per row (v)
      const T = tex.size, mask = T - 1, tp = tex.px;
      const tcol = ((hit.texX * T) | 0) & mask;
      const tStep = T / lineH;
      let tRow = (cy0 - y0) * tStep;
      for (let y = cy0; y < cy1; y++, fi += SCREEN_W, tRow += tStep) {
        const px = tp[(((tRow | 0) & mask) * T) + tcol];
        fb[fi] = packRGB(Math.min(255, (px & 255) * m) | 0, Math.min(255, ((px >> 8) & 255) * m) | 0, Math.min(255, ((px >> 16) & 255) * m) | 0);
      }
    } else {
      // procedural fallback (reactor emissive, or any texture not yet loaded)
      const base = WALLCOL[hit.tex] || WALLCOL[TEX.HULL];
      for (let y = cy0; y < cy1; y++, fi += SCREEN_W) {
        const v = (y - y0) / lineH;
        let dm = 1;
        if (v < 0.06 || v > 0.94) dm = 0.62;                 // top/bottom trim
        else if (Math.abs(v - 0.5) < 0.015) dm = 0.82;        // mid seam
        const fx = hit.texX * 2; if (fx - Math.floor(fx) < 0.05) dm *= 0.8; // vertical seam
        const mm = m * dm;
        fb[fi] = packRGB(Math.min(255, base[0] * mm + er) | 0, Math.min(255, base[1] * mm + eg) | 0, Math.min(255, base[2] * mm + eb) | 0);
      }
    }
  }

  // --- sprites: other players (+ my own is skipped) ---
  const invDet = 1 / (planeX * dirY - dirX * planeY);
  // during venting, other bodies visually slide toward the airlock (cosmetic; the
  // server already decided who died — see the airlock killfeed). cam.bodyPull ramps.
  const ap = cam.bodyPull > 0.001 ? airlockPull() : null;
  const list = [];
  for (const p of Net.players.values()) {
    if (p.id === me.id || p.dead) continue;
    let px = p.x, py = p.y;
    if (ap) { const dx = ap.cx - px, dy = ap.cy - py, L = Math.hypot(dx, dy) || 1;
      px += (dx / L) * cam.bodyPull; py += (dy / L) * cam.bodyPull; }
    const relX = px - ex, relY = py - ey;
    const tx = invDet * (dirY * relX - dirX * relY);
    const ty = invDet * (-planeY * relX + planeX * relY);
    if (ty > 0.2) list.push({ p, tx, ty });
  }
  list.sort((a, b) => b.ty - a.ty);
  const nowMs = performance.now();
  for (const s of list) {
    const { p, tx, ty } = s;
    // real trooper art when loaded (8-way directional, drawn full-colour); tinted
    // procedural fallback until the sprites load. Frame = enemy facing vs our view.
    const { spr, real } = pickTrooper(p);
    const screenX = (SCREEN_W / 2) * (1 + tx / ty);
    const hPx = (1.15 * PROJ) / ty;
    const wPx = hPx * (spr.w / spr.h);
    const floorY = HORIZON + (0.5 * PROJ) / ty;
    const yEnd = floorY, yStart = yEnd - hPx;
    const x0 = (screenX - wPx / 2) | 0, x1 = (screenX + wPx / 2) | 0;
    if (x1 < 0 || x0 >= SCREEN_W) continue;
    const m = fog(ty);
    const col = hexRGB(p.color);
    const cx0 = Math.max(0, x0), cx1 = Math.min(SCREEN_W, x1);
    const cyy0 = Math.max(0, yStart | 0), cyy1 = Math.min(SCREEN_H, yEnd | 0);
    const stepTX = spr.w / wPx, stepTY = spr.h / hPx;
    // QUAD CARRIER — a pulsing purple wash over whoever the server says is holding it
    // (STATE `quad` > 0), so every player can see the threat coming. Presentation only.
    const qMix = (p.quad || 0) > 0 ? 0.42 + 0.16 * Math.sin(nowMs * 0.008) : 0;
    for (let x = cx0; x < cx1; x++) {
      if (ty >= zbuf[x]) continue;
      const sxp = ((x - x0) * stepTX) | 0;
      if (sxp < 0 || sxp >= spr.w) continue;
      let tyf = (cyy0 - yStart) * stepTY, fi = cyy0 * SCREEN_W + x;
      for (let y = cyy0; y < cyy1; y++, fi += SCREEN_W, tyf += stepTY) {
        const px = spr.px[((tyf | 0) * spr.w) + sxp];
        if ((px >>> 24) < 110) continue;
        const r = (px & 255), g = (px >> 8) & 255, b = (px >> 16) & 255;
        let rr, gg, bb;
        if (real) { rr = r * m; gg = g * m; bb = b * m; }
        else { rr = r * col[0] / 255 * m; gg = g * col[1] / 255 * m; bb = b * col[2] / 255 * m; }
        if (qMix) { rr = rr * (1 - qMix) + QUAD_RGB[0] * qMix; gg = gg * (1 - qMix) + QUAD_RGB[1] * qMix; bb = bb * (1 - qMix) + QUAD_RGB[2] * qMix; }
        fb[fi] = packRGB(rr | 0, gg | 0, bb | 0);
      }
    }
    // health bar
    const barY = (yStart - 4) | 0, barW = Math.max(6, wPx | 0);
    const hpFrac = Math.max(0, Math.min(1, (p.hp || 0) / 100));
    for (let x = cx0; x < Math.min(SCREEN_W, x0 + barW); x++) {
      if (barY < 0 || barY >= SCREEN_H) break;
      const on = (x - x0) / barW < hpFrac;
      fb[barY * SCREEN_W + x] = on ? packRGB(80, 230, 120) : packRGB(60, 20, 20);
    }
    // remote muzzle flash
    if ((flashUntil.get(p.id) || 0) > nowMs) {
      const fxp = screenX | 0, fyp = (yStart + hPx * 0.45) | 0, rad = Math.max(2, (wPx * 0.35) | 0);
      for (let yy = -rad; yy <= rad; yy++) for (let xx = -rad; xx <= rad; xx++) {
        if (xx * xx + yy * yy > rad * rad) continue;
        const X = fxp + xx, Y = fyp + yy;
        if (X < 0 || X >= SCREEN_W || Y < 0 || Y >= SCREEN_H) continue;
        if (ty >= zbuf[X]) continue;
        fb[Y * SCREEN_W + X] = packRGB(255, 230, 150);
      }
    }
  }

  // --- combat feel: splats (floor), blood/spark particles, plasma bolts ---
  // World-space billboards projected with the same camera basis as the sprites
  // above, depth-tested against the wall zbuf so gore hides behind cover.
  // opaque flat point (blood particle / floor splat)
  function drawPoint(wx, wy, z, size, pr, pg, pb) {
    const relX = wx - ex, relY = wy - ey;
    const ptx = invDet * (dirY * relX - dirX * relY);
    const pty = invDet * (-planeY * relX + planeX * relY);
    if (pty <= 0.2 || pty > 40) return;
    const sx = ((SCREEN_W / 2) * (1 + ptx / pty)) | 0;
    if (sx < 0 || sx >= SCREEN_W || pty >= zbuf[sx]) return;
    const sy = (HORIZON + ((0.5 - z) * PROJ) / pty) | 0;
    let m = fog(pty); if (m < 0.35) m = 0.35;
    const r = Math.min(255, pr * m) | 0, g = Math.min(255, pg * m) | 0, b = Math.min(255, pb * m) | 0;
    const col = packRGB(r, g, b);
    let w2 = (size * PROJ * 0.012) / pty; if (w2 < 1) w2 = 1; if (w2 > 9) w2 = 9;
    const h2 = z <= 0.02 ? Math.max(1, w2 * 0.4) : w2;   // floor splats lie flat
    const x0p = (sx - w2 / 2) | 0, y0p = (sy - h2 / 2) | 0;
    for (let yy = y0p; yy < y0p + h2; yy++) {
      if (yy < 0 || yy >= SCREEN_H) continue;
      for (let xx = Math.max(0, x0p); xx < Math.min(SCREEN_W, x0p + w2); xx++) {
        if (pty >= zbuf[xx]) continue;
        fb[yy * SCREEN_W + xx] = col;
      }
    }
  }
  // additive glowing plasma bolt with a bright core + falloff halo
  function drawBolt(b) {
    const relX = b.x - ex, relY = b.y - ey;
    const ptx = invDet * (dirY * relX - dirX * relY);
    const pty = invDet * (-planeY * relX + planeX * relY);
    if (pty <= 0.2 || pty > 40) return;
    const sx = ((SCREEN_W / 2) * (1 + ptx / pty)) | 0;
    const sy = (HORIZON + (0.5 * PROJ) / pty - (0.05 * PROJ) / pty) | 0;   // chest height
    let rad = (0.42 * PROJ) / pty; if (rad < 1.5) rad = 1.5; if (rad > 22) rad = 22;
    const x0 = Math.max(0, (sx - rad) | 0), x1 = Math.min(SCREEN_W - 1, (sx + rad) | 0);
    const y0 = Math.max(0, (sy - rad) | 0), y1 = Math.min(SCREEN_H - 1, (sy + rad) | 0);
    const r2 = rad * rad;
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        if (pty >= zbuf[xx]) continue;                 // behind a wall
        const dxp = xx - sx, dyp = yy - sy, d2 = dxp * dxp + dyp * dyp;
        if (d2 > r2) continue;
        const f = 1 - d2 / r2;                          // 0..1 radial falloff
        const glow = f * f;
        const core = d2 < 2.2 ? 1 : 0;                  // hot white centre
        const ar = Math.min(255, b.r * glow + core * 200) | 0;
        const ag = Math.min(255, b.g * glow + core * 200) | 0;
        const ab = Math.min(255, b.b * glow + core * 200) | 0;
        const i = yy * SCREEN_W + xx, px = fb[i];
        const nr = Math.min(255, (px & 255) + ar);
        const ng = Math.min(255, ((px >> 8) & 255) + ag);
        const nb = Math.min(255, ((px >> 16) & 255) + ab);
        fb[i] = packRGB(nr, ng, nb);
      }
    }
  }
  // railgun rail: sample the ray in world space, project each point (drawBolt's math)
  // and paint a bright additive line. It is drawn THROUGH walls — occluded samples are
  // dimmed rather than clipped — so you literally see the shot pierce the geometry.
  function drawBeam(bm) {
    const fade = bm.life / bm.maxLife;                 // 1 → 0 over the beam's life
    const col = RAIL_RGB, bright = (0.45 + 0.55 * bm.cf) * fade;
    const n = Math.max(2, (bm.len / 0.12) | 0);        // ~0.12-cell steps down the ray
    for (let s = 0; s <= n; s++) {
      const along = (s / n) * bm.len;
      const relX = bm.x + bm.dx * along - ex, relY = bm.y + bm.dy * along - ey;
      const pty = invDet * (-planeY * relX + planeX * relY);
      if (pty <= 0.15 || pty > 60) continue;
      const ptx = invDet * (dirY * relX - dirX * relY);
      const sx = ((SCREEN_W / 2) * (1 + ptx / pty)) | 0;
      if (sx < 0 || sx >= SCREEN_W) continue;
      const sy = (HORIZON + (0.5 * PROJ) / pty - (0.05 * PROJ) / pty) | 0;   // chest line (matches bolts)
      const amp = bright * (pty >= zbuf[sx] ? 0.3 : 1);  // behind a wall → ghosted (pierce)
      const half = Math.max(1, Math.min(6, (0.11 * PROJ / pty) | 0));
      for (let yy = sy - half; yy <= sy + half; yy++) {
        if (yy < 0 || yy >= SCREEN_H) continue;
        const f = amp * (1 - Math.abs(yy - sy) / (half + 1));
        const i = yy * SCREEN_W + sx, px = fb[i];
        fb[i] = packRGB(
          Math.min(255, (px & 255) + col[0] * f + f * 130) | 0,
          Math.min(255, ((px >> 8) & 255) + col[1] * f + f * 130) | 0,
          Math.min(255, ((px >> 16) & 255) + col[2] * f + f * 130) | 0);
      }
    }
  }
  for (const sp of splats) drawPoint(sp.x, sp.y, 0.006, sp.size, sp.r, sp.g, sp.b);
  for (const p of particles) drawPoint(p.x, p.y, Math.max(0.02, p.z), p.size, p.r, p.g, p.b);
  for (const b of bolts) drawBolt(b);
  for (const bm of beams) drawBeam(bm);

  // --- OBJECTIVE: console props + capture rings (world billboards) ---
  // Reads objState only. Each console is a pedestal + emissive screen (owner's
  // colour, neutral steel when unowned, white flicker when contested) with a
  // radial capture RING that fills to `progress`. Depth-tested against the walls.
  if (objState && objState.consoles) {
    const R2 = OBJECTIVE.ARM_RADIUS * OBJECTIVE.ARM_RADIUS;
    const nearCount = (c) => { let n = 0; for (const p of Net.players.values()) {
      if (p.dead) continue; const dx = p.x - c.x, dy = p.y - c.y; if (dx * dx + dy * dy <= R2) n++; } return n; };
    for (const c of objState.consoles) {
      const relX = c.x - ex, relY = c.y - ey;
      const ptx = invDet * (dirY * relX - dirX * relY);
      const pty = invDet * (-planeY * relX + planeX * relY);
      if (pty <= 0.25 || pty > 34) continue;
      const sx = (SCREEN_W / 2) * (1 + ptx / pty);
      const ccol = Math.round(sx);
      if (ccol < 0 || ccol >= SCREEN_W || pty >= zbuf[ccol]) continue;   // off-screen / behind wall
      const floorY = HORIZON + (0.5 * PROJ) / pty;
      const hPx = (0.62 * PROJ) / pty;
      const topY = floorY - hPx;
      const halfW = Math.max(1.5, hPx * 0.34);
      const fogm = Math.max(0.42, fog(pty));
      const owned = c.owner != null && !!c.color;
      const contested = !c.armed && nearCount(c) >= 2;
      let cr, cg, cb;
      if (contested) { cr = 235; cg = 245; cb = 255; }
      else if (owned) { const g = hexRGB(c.color); cr = g[0]; cg = g[1]; cb = g[2]; }
      else { cr = 96; cg = 150; cb = 172; }
      const x0 = Math.max(0, Math.floor(sx - halfW)), x1 = Math.min(SCREEN_W - 1, Math.ceil(sx + halfW));
      // pedestal body (gunmetal, edge-shaded) + emissive owner accent band
      const bodyTop = Math.max(0, Math.floor(topY + hPx * 0.36));
      const bodyBot = Math.min(SCREEN_H - 1, Math.floor(floorY));
      for (let x = x0; x <= x1; x++) {
        if (pty >= zbuf[x]) continue;
        const edgeX = Math.min(1, Math.abs((x - sx) / halfW));
        const sh = (1 - edgeX * 0.4) * fogm;
        for (let y = bodyTop; y <= bodyBot; y++) {
          const vy = (y - bodyTop) / Math.max(1, bodyBot - bodyTop);
          let r = 46 * sh, g = 50 * sh, b = 58 * sh;
          if (vy < 0.18) { r = cr * 0.5 * fogm; g = cg * 0.5 * fogm; b = cb * 0.5 * fogm; }  // accent band under screen
          fb[y * SCREEN_W + x] = packRGB(r | 0, g | 0, b | 0);
        }
      }
      // emissive screen head (pulses when armed)
      const armPulse = c.armed ? (0.72 + 0.28 * Math.sin(t * 6 + c.x)) : (owned ? 0.85 : 0.5);
      const headTop = Math.max(0, Math.floor(topY)), headBot = Math.min(SCREEN_H - 1, Math.floor(topY + hPx * 0.34));
      for (let x = x0; x <= x1; x++) {
        if (pty >= zbuf[x]) continue;
        for (let y = headTop; y <= headBot; y++) {
          const scan = ((y & 1) === 0) ? 1 : 0.72;   // scanline detail
          const g2 = armPulse * scan * fogm;
          fb[y * SCREEN_W + x] = packRGB(
            Math.min(255, cr * g2 + 22) | 0, Math.min(255, cg * g2 + 22) | 0, Math.min(255, cb * g2 + 26) | 0);
        }
      }
      // capture RING above the console — fills clockwise from the top to `progress`
      if (objState.phase !== 'venting') {
        const R = Math.max(3.5, hPx * 0.5);
        const rcx = sx, rcy = topY - R * 0.85;
        const segs = Math.max(28, (R * 2.2) | 0);
        const prog = c.armed ? 1 : Math.max(0, Math.min(1, c.progress || 0));
        for (let i = 0; i < segs; i++) {
          const frac = i / segs;
          const on = frac < prog;
          const a = -Math.PI / 2 + frac * 2 * Math.PI;
          const ca = Math.cos(a), sa = Math.sin(a);
          for (let rr = R - 1.6; rr <= R + 0.4; rr += 0.6) {
            const xx = Math.round(rcx + ca * rr), yy = Math.round(rcy + sa * rr);
            if (xx < 0 || xx >= SCREEN_W || yy < 0 || yy >= SCREEN_H) continue;
            if (pty >= zbuf[xx]) continue;
            let r, g, b;
            if (contested) { const fl = 0.5 + 0.5 * Math.sin(t * 22); r = 255 * fl + 60; g = 255 * fl + 60; b = 255; }
            else if (on) { const br = c.armed ? (0.8 + 0.2 * Math.sin(t * 6)) : 1; r = cr * br + 40; g = cg * br + 40; b = cb * br + 40; }
            else { r = 30; g = 40; b = 48; }   // unfilled track
            fb[yy * SCREEN_W + xx] = packRGB(Math.min(255, r) | 0, Math.min(255, g) | 0, Math.min(255, b) | 0);
          }
        }
      }
    }
  }

  // --- WEAPON PICKUPS: glowing floating pads (available ones only) ---
  // World billboards in the weapon's colour: a hovering additive diamond + a bright
  // ground marker, depth-tested against the walls so they hide behind cover.
  for (const pk of weaponSpots) {
    if (pickupTaken.get(pk.id)) continue;
    const wpc = WEAPONS[pk.weapon]; if (!wpc) continue;
    const relX = pk.x - ex, relY = pk.y - ey;
    const ptx = invDet * (dirY * relX - dirX * relY);
    const pty = invDet * (-planeY * relX + planeX * relY);
    if (pty <= 0.25 || pty > 36) continue;
    const sx = (SCREEN_W / 2) * (1 + ptx / pty);
    const ccol = Math.round(sx);
    if (ccol < 0 || ccol >= SCREEN_W || pty >= zbuf[ccol]) continue;
    const floorY = HORIZON + (0.5 * PROJ) / pty;
    const bob = Math.sin(t * 2.2 + pk.x * 1.7) * 0.1;              // hover
    const cy = HORIZON + ((0.5 - (0.34 + bob)) * PROJ) / pty;      // float above the deck
    const rad = Math.max(2, ((0.5 * PROJ) / pty) * 0.42);
    const col = hexRGB(wpc.color);
    const pulse = 0.65 + 0.35 * Math.sin(t * 5 + pk.x);
    const rh = rad * 1.7;
    for (let yy = -rh; yy <= rh; yy++) {
      const Y = (cy + yy) | 0; if (Y < 0 || Y >= SCREEN_H) continue;
      for (let xx = -rad; xx <= rad; xx++) {
        const X = (sx + xx) | 0; if (X < 0 || X >= SCREEN_W) continue;
        if (pty >= zbuf[X]) continue;
        const dn = Math.abs(xx) / rad + Math.abs(yy) / rh;         // diamond mask
        if (dn > 1) continue;
        const f = 1 - dn, core = dn < 0.32 ? 1 : 0;
        const i = Y * SCREEN_W + X, px = fb[i];
        const ar = Math.min(255, col[0] * f * pulse + core * 150);
        const ag = Math.min(255, col[1] * f * pulse + core * 150);
        const ab = Math.min(255, col[2] * f * pulse + core * 150);
        fb[i] = packRGB(Math.min(255, (px & 255) + ar) | 0, Math.min(255, ((px >> 8) & 255) + ag) | 0, Math.min(255, ((px >> 16) & 255) + ab) | 0);
      }
    }
    // bright ground marker so you can spot the pad on the floor
    const gy = floorY | 0;
    for (let xx = -rad; xx <= rad; xx++) {
      const X = (sx + xx) | 0; if (X < 0 || X >= SCREEN_W || gy < 0 || gy >= SCREEN_H) continue;
      if (pty >= zbuf[X]) continue;
      const i = gy * SCREEN_W + X, px = fb[i];
      fb[i] = packRGB(Math.min(255, (px & 255) + col[0] * 0.45) | 0, Math.min(255, ((px >> 8) & 255) + col[1] * 0.45) | 0, Math.min(255, ((px >> 16) & 255) + col[2] * 0.45) | 0);
    }
  }

  // --- SUSTAIN ITEMS: health / armor / ammo / mega pads (available ones only) ---
  // A hovering additive orb in the item's colour + a ground marker, depth-tested against
  // the walls. Availability is server truth (pickupTaken); mega reads a brighter cyan.
  for (const pk of itemSpots) {
    if (pickupTaken.get(pk.id)) continue;
    const st = itemStyleFor(pk); if (!st) continue;
    const relX = pk.x - ex, relY = pk.y - ey;
    const ptx = invDet * (dirY * relX - dirX * relY);
    const pty = invDet * (-planeY * relX + planeX * relY);
    if (pty <= 0.25 || pty > 36) continue;
    const sx = (SCREEN_W / 2) * (1 + ptx / pty);
    const ccol = Math.round(sx);
    if (ccol < 0 || ccol >= SCREEN_W || pty >= zbuf[ccol]) continue;
    const floorY = HORIZON + (0.5 * PROJ) / pty;
    const bob = Math.sin(t * 2.6 + pk.x * 1.3) * 0.09;
    const cy = HORIZON + ((0.5 - (0.32 + bob)) * PROJ) / pty;
    const rad = Math.max(2, ((0.5 * PROJ) / pty) * 0.36);
    const col = st.rgb;
    const pulse = 0.6 + 0.4 * Math.sin(t * 4 + pk.x);
    const r2 = rad * rad;
    for (let yy = -rad; yy <= rad; yy++) {
      const Y = (cy + yy) | 0; if (Y < 0 || Y >= SCREEN_H) continue;
      for (let xx = -rad; xx <= rad; xx++) {
        const X = (sx + xx) | 0; if (X < 0 || X >= SCREEN_W) continue;
        if (pty >= zbuf[X]) continue;
        const d2 = xx * xx + yy * yy; if (d2 > r2) continue;
        const f = 1 - d2 / r2, core = d2 < r2 * 0.16 ? 1 : 0;
        const i = Y * SCREEN_W + X, px = fb[i];
        const ar = Math.min(255, col[0] * f * pulse + core * 150);
        const ag = Math.min(255, col[1] * f * pulse + core * 150);
        const ab = Math.min(255, col[2] * f * pulse + core * 150);
        fb[i] = packRGB(Math.min(255, (px & 255) + ar) | 0, Math.min(255, ((px >> 8) & 255) + ag) | 0, Math.min(255, ((px >> 16) & 255) + ab) | 0);
      }
    }
    const gy = floorY | 0;
    for (let xx = -rad; xx <= rad; xx++) {
      const X = (sx + xx) | 0; if (X < 0 || X >= SCREEN_W || gy < 0 || gy >= SCREEN_H) continue;
      if (pty >= zbuf[X]) continue;
      const i = gy * SCREEN_W + X, px = fb[i];
      fb[i] = packRGB(Math.min(255, (px & 255) + col[0] * 0.4) | 0, Math.min(255, ((px >> 8) & 255) + col[1] * 0.4) | 0, Math.min(255, ((px >> 16) & 255) + col[2] * 0.4) | 0);
    }
  }

  // --- THE QUAD: a telegraphed powerup pad — a tall additive purple pillar of light
  // that is DIM while charging and blazes + pulses when READY (glow-ramp telegraph). ---
  if (powerSpots.length) {
    const qs = quadState();
    const intensity = 0.18 + 0.82 * qs.ramp;                         // dim..bright over the ramp
    const pulse = qs.ready ? (0.7 + 0.3 * Math.sin(t * 7)) : 1;
    for (const pk of powerSpots) {
      if (pickupTaken.get(pk.id)) continue;   // grabbed this cycle (server truth) → the pad is claimed
      const relX = pk.x - ex, relY = pk.y - ey;
      const ptx = invDet * (dirY * relX - dirX * relY);
      const pty = invDet * (-planeY * relX + planeX * relY);
      if (pty <= 0.25 || pty > 40) continue;
      const sx = (SCREEN_W / 2) * (1 + ptx / pty);
      const ccol = Math.round(sx);
      if (ccol < 0 || ccol >= SCREEN_W || pty >= zbuf[ccol]) continue;
      const floorY = HORIZON + (0.5 * PROJ) / pty;
      const topY = HORIZON + ((0.5 - 1.1) * PROJ) / pty;             // a tall column of light
      const rad = Math.max(2, ((0.5 * PROJ) / pty) * 0.5);
      const y0q = Math.max(0, topY | 0), y1q = Math.min(SCREEN_H - 1, floorY | 0);
      for (let X = Math.max(0, (sx - rad) | 0); X <= Math.min(SCREEN_W - 1, (sx + rad) | 0); X++) {
        if (pty >= zbuf[X]) continue;
        const dxn = Math.abs((X - sx) / rad);                        // 0 centre .. 1 edge
        const beam = (1 - dxn) * (1 - dxn) * intensity * pulse;
        for (let Y = y0q; Y <= y1q; Y++) {
          const i = Y * SCREEN_W + X, px = fb[i];
          fb[i] = packRGB(
            Math.min(255, (px & 255) + QUAD_RGB[0] * beam) | 0,
            Math.min(255, ((px >> 8) & 255) + QUAD_RGB[1] * beam) | 0,
            Math.min(255, ((px >> 16) & 255) + QUAD_RGB[2] * beam * 1.1) | 0);
        }
      }
    }
  }

  octx.putImageData(img, 0, 0);
}

function hexRGB(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

// ---------------------------------------------------------------- weapon viewmodel
// Two paths: the CARBINE draws its single cropped POV sprite (+ procedural reload
// dip); the SCATTERGUN + PLASMA draw video-derived frame strips (sprite-forge kling
// pipeline) — reload frames win over fire frames, and the real motion carries the
// animation so the procedural dip is suppressed. Muzzle flash is always a separate
// additive overlay, tinted per weapon, never baked into the frame.
function drawGun(ctx, t) {
  const wp = WEAPONS[me.weapon];
  const art = WEAPON_ART[me.weapon];
  const bobA = me.moving;
  const bx = Math.sin(me.bobPhase) * 6 * bobA - me.strafeLean * 6;
  const by = (1 - Math.cos(me.bobPhase * 2)) * 3 * bobA;
  const kick = vm.kick * 10;
  const nowMs = performance.now();
  const rem = me.reloadUntil - nowMs;
  const fireMs = Math.min(wp.rateMs * 0.7, 360);   // how long the fire strip plays

  let frame = null, dip = 0, roll = 0;
  const hasReload = art && art.reload.some(Boolean);
  const hasFire = art && art.fire.some(Boolean);
  const hasCharge = art && art.charge && art.charge.some(Boolean);
  // charge progress for the viewmodel (whole-hold 0..1, so the coils spin up from idle)
  const chargeK = (me.charging && wp.charge) ? Math.max(0, Math.min(1, (nowMs - me.chargeStart) / wp.charge.fullMs)) : 0;
  if (art && art.hero) {
    if (rem > 0 && hasReload) {
      const k = 1 - rem / wp.reloadMs;                                  // 0..1 through the reload
      frame = art.reload[Math.min(art.reload.length - 1, (k * art.reload.length) | 0)] || art.hero;
    } else if (me.charging && hasCharge) {
      frame = art.charge[Math.min(art.charge.length - 1, (chargeK * art.charge.length) | 0)] || art.hero;  // spin-up strip
    } else if (hasFire && (nowMs - me.fireT) < fireMs) {
      const k = (nowMs - me.fireT) / fireMs;                            // 0..1 through the shot
      frame = art.fire[Math.min(art.fire.length - 1, (k * art.fire.length) | 0)] || art.hero;
    } else {
      frame = art.hero;
      if (rem > 0) { const k = 1 - rem / wp.reloadMs; dip = Math.sin(k * Math.PI) * 40; } // no reload frames -> procedural dip
    }
  } else if (rem > 0) {
    // carbine (or art still loading): classic procedural reload dip + roll
    const k = 1 - rem / wp.reloadMs; dip = Math.sin(k * Math.PI) * 46; roll = Math.sin(k * Math.PI) * 0.25;
  }

  const cx = SCREEN_W / 2 + bx + cam.kickX * 0.4;
  let muzzleY = SCREEN_H - 120;
  // HARD SIZING RULE (awfml QA gate, flagged twice): the viewmodel must sit LOW and
  // never cover the crosshair or the upper view — critical on wide-short mobile
  // landscape. The visible barrel tip lands on GUN_TOP_Y (~54% down); the gun fills
  // only the bottom ~46% of the FIXED 384x240 framebuffer, so object-fit:contain
  // keeps it out of the way on every aspect ratio.
  const GUN_TOP_Y = SCREEN_H * 0.54;

  if (frame) {
    // video-derived square frame: size so the barrel tip (meta.topFrac down the
    // square) sits at GUN_TOP_Y, anchored to just below the screen bottom.
    const meta = art.meta;
    const frameBottom = SCREEN_H + 8 + kick + dip + by + cam.kickY * 0.3;
    const gh = (frameBottom - GUN_TOP_Y) / (1 - meta.topFrac), gw = gh;   // square
    ctx.save();
    ctx.translate(cx, frameBottom);
    ctx.rotate(roll);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(frame.canvas, -gw / 2, -gh, gw, gh);
    ctx.restore();
    muzzleY = frameBottom - gh * (1 - meta.topFrac);   // barrel tip == GUN_TOP_Y
  } else {
    const baseY = SCREEN_H + 6 + kick + dip + by + cam.kickY * 0.3;
    ctx.save();
    ctx.translate(cx, baseY);
    ctx.rotate(roll);
    if (gunSprite && me.weapon === 'carbine') {
      // real POV pulse carbine — width-derived, but HEIGHT-CAPPED so it never
      // exceeds the bottom ~46% band (mobile-landscape safe).
      let gw = SCREEN_W * 0.5, gh = gw * (gunSprite.h / gunSprite.w);
      const maxH = baseY - GUN_TOP_Y;
      if (gh > maxH) { gh = maxH; gw = gh * (gunSprite.w / gunSprite.h); }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(gunSprite.canvas, -gw / 2, -gh, gw, gh);
      muzzleY = baseY - gh * 0.96;   // flash at the foreshortened barrel tip
    } else {
      // procedural fallback (draws until a sprite loads)
      ctx.fillStyle = '#20242c'; ctx.fillRect(-34, -46, 68, 60);
      ctx.fillStyle = '#2c323c'; ctx.fillRect(-30, -70, 60, 30);
      ctx.fillStyle = '#171a20'; ctx.fillRect(-12, -118, 24, 60);   // barrel/receiver up to muzzle
      ctx.fillStyle = '#3a4450'; ctx.fillRect(-8, -116, 16, 10);    // barrel shroud band
      ctx.fillStyle = '#0a3a44'; ctx.fillRect(-26, -40, 10, 34);
      ctx.fillStyle = me.clip > 0 ? '#3cd6ff' : '#ff3c4a';
      ctx.fillRect(-24, -38 + 30 * (1 - me.clip / wp.clip), 6, 30 * (me.clip / wp.clip) + 1);
      ctx.fillStyle = '#3a4450'; ctx.fillRect(-3, -128, 6, 12);
      muzzleY = baseY - 120;
    }
    ctx.restore();
  }

  // muzzle flash — separate additive overlay, fired via vm.flash (never baked in),
  // tinted to the weapon's colour and beefier for the scattergun.
  if (vm.flash > 0.35) {
    const c = hexRGB(wp.color || '#ffd28c');
    const big = me.weapon === 'scatter' ? 1.7 : me.weapon === 'plasma' ? 1.15 : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(cx, muzzleY);
    ctx.rotate(Math.random() * 6.28);
    const s = (26 + Math.random() * 16) * big;
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, s);
    grd.addColorStop(0, 'rgba(255,250,232,0.95)');
    grd.addColorStop(0.5, `rgba(${c[0]},${c[1]},${c[2]},0.72)`);
    grd.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    ctx.fillStyle = grd;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = i / 8 * 6.28, r = i % 2 ? s : s * 0.4; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // railgun RAIL flash (first-person) — a rail fired down your own view axis collapses to
  // the screen centre, so paint it as a bright vertical bloom from the muzzle up through the
  // crosshair for a beat. (Other players see the world-space streak via drawBeam.) cf → width.
  if (vm.rail > 0.02) {
    const c = RAIL_RGB, a = vm.rail, topY = HORIZON - 4;      // up to just above the crosshair
    const w = (3 + vm.railCf * 7) * (0.6 + 0.4 * a);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const grd = ctx.createLinearGradient(cx - w, 0, cx + w, 0);
    grd.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    grd.addColorStop(0.5, `rgba(255,255,255,${0.85 * a})`);
    grd.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    ctx.fillStyle = grd;
    ctx.fillRect(cx - w, topY, w * 2, muzzleY - topY);
    // hot white core line
    ctx.fillStyle = `rgba(255,255,255,${0.9 * a})`;
    ctx.fillRect(cx - 0.6, topY, 1.2, muzzleY - topY);
    ctx.restore();
  }

  // railgun CHARGE glow — an additive energy ball gathering at the muzzle that grows
  // with the hold + a jitter, snapping white the moment it's armed (past charge.minMs).
  // Purely procedural (works before BMO's charge strip lands; complements it after).
  if (me.charging && wp.charge) {
    const c = RAIL_RGB;
    const armed = (nowMs - me.chargeStart) >= wp.charge.minMs;
    const s = (6 + chargeK * 26) * (0.9 + 0.1 * Math.sin(nowMs / 45));   // grows + flickers
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(cx + (Math.random() - 0.5) * chargeK * 3, muzzleY + (Math.random() - 0.5) * chargeK * 3);
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, s);
    const core = armed ? '255,255,255' : '255,150,150';
    grd.addColorStop(0, `rgba(${core},${0.5 + 0.45 * chargeK})`);
    grd.addColorStop(0.5, `rgba(${c[0]},${c[1]},${c[2]},${0.5 * chargeK})`);
    grd.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(0, 0, s, 0, 6.2832); ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------- gameplay
function blocked(x, y, r) {
  for (let ty = (y - r) | 0; ty <= (y + r) | 0; ty++)
    for (let tx = (x - r) | 0; tx <= (x + r) | 0; tx++)
      if (isSolidCell(world.grid, world.W, world.H, tx, ty)) return true;
  return false;
}
function moveMe(dx, dy) {
  const r = 0.22;
  if (!blocked(me.x + dx, me.y, r)) me.x += dx;
  if (!blocked(me.x, me.y + dy, r)) me.y += dy;
}

function fire() {
  const wp = WEAPONS[me.weapon], nowMs = performance.now();
  if (wp.charge) return;   // charge weapons fire on RELEASE via beginCharge/releaseCharge, never the auto-fire path
  if (me.dead || nowMs - me.fireT < wp.rateMs || nowMs < me.reloadUntil) return;
  if (me.clip <= 0) { startReload(); return; }
  me.clip--; me.clips[me.weapon] = me.clip; me.fireT = nowMs;
  // punchy recoil: viewmodel snap + view kicks up-and-slightly-sideways + a touch of
  // roll, crosshair blooms open. The scattergun hits noticeably harder + shakes.
  const heavy = me.weapon === 'scatter';
  vm.flash = 1; vm.kick = 1;
  cam.kickY += heavy ? 8.5 : 5.5;
  cam.kickX += (Math.random() - 0.5) * (heavy ? 4.6 : 3.2);
  cam.roll += (Math.random() - 0.5) * (heavy ? 0.03 : 0.016);
  cross.bloom = Math.min(1.7, cross.bloom + (heavy ? 1.5 : 0.9));
  if (heavy) cam.shake = Math.max(cam.shake, 2.6);
  // per-weapon projectile visuals (client-visual v1; the server hitscan is the truth):
  // a scattergun fans out short orange pellets, everything else flings one fast bolt.
  const c = hexRGB(wp.color);
  if (wp.pellets > 1) {
    for (let i = 0; i < wp.pellets; i++) {
      const a = me.ang + (Math.random() - 0.5) * 2 * wp.spread;
      spawnBolt(me.x, me.y, a, true, { speed: 26, life: 0.5, r: c[0], g: c[1], b: c[2] });
    }
  } else {
    spawnBolt(me.x, me.y, me.ang, true, { speed: 32, r: c[0], g: c[1], b: c[2] });
    playSfx('whoosh', 0.22);                  // plasma/carbine launch layer, under the report
  }
  playSfx(wp.fireSfx || 'shoot');
  Net.shoot(me.ang, me.weapon);
  window.PlaytestLink && PlaytestLink.event('shot', { clip: me.clip, weapon: me.weapon });
}

// --- charge weapons (railgun): HOLD to spin up, RELEASE to fire -----------------
// The SERVER times the real hold (C2S.CHARGE→SHOOT) and owns the fizzle/damage call.
// These just drive the local clock (HUD ring, viewmodel glow, beam intensity) and the
// optimistic clip prediction, mirroring what fire() does for instant weapons.
function chargeFrac() {                       // 0 at charge.minMs, 1 at charge.fullMs
  const wp = WEAPONS[me.weapon];
  if (!me.charging || !wp.charge) return 0;
  const held = performance.now() - me.chargeStart;
  return Math.max(0, Math.min(1, (held - wp.charge.minMs) / (wp.charge.fullMs - wp.charge.minMs)));
}
function beginCharge() {
  const wp = WEAPONS[me.weapon], nowMs = performance.now();
  if (me.dead || me.charging || !wp.charge) return;
  if (nowMs - me.fireT < wp.rateMs || nowMs < me.reloadUntil) return;
  if (me.clip <= 0) { startReload(); return; }
  me.charging = true; me.chargeStart = nowMs;
  Net.charge();                                // start the server's authoritative clock
  playSfx('railgun-charge', 0.5);
}
function releaseCharge() {
  const wp = WEAPONS[me.weapon], nowMs = performance.now();
  if (!me.charging) return;
  const held = nowMs - me.chargeStart, cf = chargeFrac();
  me.charging = false; me.chargeStart = 0;
  // ALWAYS tell the server we let go, so it clears its charge clock (fizzle or shot).
  Net.shoot(me.ang, me.weapon);
  if (me.dead) return;
  if (!wp.charge || held < wp.charge.minMs) { playSfx('railgun-fizzle', 0.4); return; }  // dud → no ammo, no beam
  // real shot — predict the clip + recoil + rail exactly like fire() does for its weapon
  me.clip--; me.clips[me.weapon] = me.clip; me.fireT = nowMs;
  vm.flash = 1; vm.kick = 1; vm.rail = 1; vm.railCf = cf;   // first-person rail flash, scaled by charge
  cam.kickY += 7 + cf * 4; cam.kickX += (Math.random() - 0.5) * 3.0;
  cam.roll += (Math.random() - 0.5) * 0.02; cam.shake = Math.max(cam.shake, 2.2 + cf * 1.8);
  cross.bloom = Math.min(1.7, cross.bloom + 1.2);
  spawnBeam(me.x, me.y, me.ang, wp.range, cf);
  playSfx(wp.fireSfx || 'railgun-fire');
  window.PlaytestLink && PlaytestLink.event('shot', { clip: me.clip, weapon: me.weapon, charge: +cf.toFixed(2) });
}
function cancelCharge() { me.charging = false; me.chargeStart = 0; }

function startReload() {
  const wp = WEAPONS[me.weapon], nowMs = performance.now();
  if (me.dead || nowMs < me.reloadUntil || me.clip >= wp.clip) return;
  cancelCharge();                              // reloading cancels a charge (server does the same)
  me.reloadUntil = nowMs + wp.reloadMs; me.wasReloading = true;
  playSfx(wp.reloadSfx || 'reload');
  Net.reload(me.weapon);
  window.PlaytestLink && PlaytestLink.event('reload', { weapon: me.weapon });
}
// Switch to an OWNED weapon (number keys / scroll / touch). Predict locally for an
// instant viewmodel swap; the server confirms via S2C.WEAPON. Switching cancels a reload.
function switchWeapon(key) {
  if (me.dead || key === me.weapon || !me.owned.has(key) || !WEAPONS[key]) return;
  cancelCharge();                              // switching away cancels a charge (server does the same)
  me.weapon = key;
  me.clip = me.clips[key] ?? WEAPONS[key].clip; me.clips[key] = me.clip;
  me.reloadUntil = 0; me.wasReloading = false;
  playSfx('switch', 0.4);
  Net.switchWeapon(key);
}
function cycleWeapon(dir) {
  const owned = Object.values(WEAPON_SLOTS).filter((k) => me.owned.has(k));   // slot order
  if (owned.length < 2) return;
  const i = owned.indexOf(me.weapon);
  switchWeapon(owned[(i + dir + owned.length) % owned.length]);
}

// ---------------------------------------------------------------- audio
// Playback only — BMO's ElevenLabs `gen-sfx.mjs` (sprite-forge) generates the
// actual sounds and drops mp3s into client/assets/sfx/. This layer just plays
// them by name and no-ops gracefully until the files exist. Event -> filename:
//   shoot.mp3  reload.mp3  hurt.mp3  death.mp3  spawn.mp3
const SFX_DIR = 'assets/sfx/';
const sfxTemplates = {};
let audioUnlocked = false; // set on the human's first gesture; bots stay silent
function playSfx(name, vol = 0.5) {
  if (!audioUnlocked) return;
  try {
    let base = sfxTemplates[name];
    if (!base) { base = sfxTemplates[name] = new Audio(SFX_DIR + name + '.mp3'); }
    const node = base.cloneNode();     // clone so overlapping shots don't cut each other
    node.volume = Math.max(0, Math.min(1, vol));
    node.play().catch(() => {});       // missing file / not-yet-generated -> silent
  } catch {}
}

// Powerup cues are SYNTHESIZED (WebAudio) rather than sampled — short arena-shooter blips
// with no asset files to ship. Same unlock gate as playSfx; bots stay silent.
let _actx = null;
function audioCtx() {
  if (IS_BOT || !audioUnlocked) return null;
  try {
    if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
    if (_actx.state === 'suspended') _actx.resume().catch(() => {});
    return _actx;
  } catch { return null; }
}
function synthTone(ctx, t0, freq, dur, type, vol, freqEnd) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(t0); o.stop(t0 + dur + 0.03);
}
function playSynth(kind, loud = true) {
  const ctx = audioCtx(); if (!ctx) return;
  const t0 = ctx.currentTime, v = loud ? 0.24 : 0.1;
  if (kind === 'quad') {                                   // ominous rising power chord
    synthTone(ctx, t0, 174, 0.5, 'sawtooth', v, 349);
    synthTone(ctx, t0 + 0.02, 261, 0.5, 'sawtooth', v * 0.8, 523);
    synthTone(ctx, t0 + 0.24, 392, 0.42, 'square', v * 0.6, 784);
  } else if (kind === 'trade') {                           // THE SYMMETRIC TRADE — the quad chord, darkened + FALLING (one buff spent for the other)
    synthTone(ctx, t0, 174, 0.4, 'sawtooth', v * 0.9, 116);
    synthTone(ctx, t0 + 0.02, 261, 0.4, 'sawtooth', v * 0.6, 174);
    synthTone(ctx, t0 + 0.2, 330, 0.3, 'square', v * 0.45, 220);
  } else if (kind === 'mega') {                            // warm ascending two-tone
    synthTone(ctx, t0, 330, 0.22, 'sine', v, 494);
    synthTone(ctx, t0 + 0.13, 494, 0.3, 'sine', v, 659);
  } else if (kind === 'armor') {                           // metallic clank
    synthTone(ctx, t0, 220, 0.12, 'triangle', v, 330);
    synthTone(ctx, t0 + 0.05, 440, 0.16, 'square', v * 0.5);
  } else if (kind === 'ammo') {                            // mechanical chunk
    synthTone(ctx, t0, 520, 0.07, 'square', v * 0.7, 300);
  } else {                                                 // health — soft blip
    synthTone(ctx, t0, 587, 0.14, 'sine', v, 880);
  }
}

// ---------------------------------------------------------------- net effects
Net.onWelcome = (m) => {
  me.id = m.id; me.x = m.spawn.x; me.y = m.spawn.y; me.ang = m.spawn.ang;
  document.getElementById('arena').textContent = 'STARFRAG · ' + m.mapName;
  // render the objective immediately from the welcome snapshot (null on deathmatch)
  if (m.objective) { objState = m.objective; prevObj = m.objective; }
  // seed weapon-pickup availability (server truth)
  if (m.pickups) for (const pk of m.pickups) pickupTaken.set(pk.id, !!pk.taken);
};
// authoritative loadout: pickup grant / switch confirm / reload complete / respawn.
// Sync the predicted mirror; a NEW weapon (owned grew) pops a pickup toast + swap sfx.
Net.on(S2C.WEAPON, (m) => {
  const grew = m.owned && m.owned.some((k) => !me.owned.has(k));
  if (m.owned) me.owned = new Set(m.owned);
  // an authoritative weapon SWAP (pickup grant / server switch) invalidates any in-flight
  // charge — cancel it, else me.charging can stay true onto a non-charge weapon and the
  // charge HUD/viewmodel deref wp.charge. Only on a real change: the per-shot clip resync
  // sends a same-weapon WEAPON, and cancelling there could kill a just-started next charge.
  if (m.weapon !== me.weapon) cancelCharge();
  me.weapon = m.weapon;
  if (Number.isFinite(m.clip)) { me.clip = m.clip; me.clips[m.weapon] = m.clip; }
  me.reloadUntil = 0; me.wasReloading = false;
  if (grew) {
    pickupToast = { text: 'PICKED UP ' + (WEAPONS[m.weapon]?.name || m.weapon), until: performance.now() + 1800 };
    playSfx('switch', 0.5);
  }
});
// a map pickup pad (weapon/item/quad) became (un)available — toggle its pad
Net.on(S2C.PICKUP, (m) => { pickupTaken.set(m.id, !!m.taken); });
// someone grabbed a sustain/quad item — the grabber gets a toast + cue; a quad grab also
// announces to everyone (a fainter cue) so the room knows the carrier is out there.
Net.on(S2C.POWERUP, (m) => {
  const mine = m.by === me.id;
  // THE SYMMETRIC TRADE — grabbing one buff SPENT the other (server flags `traded`). An
  // unannounced swap reads as a bug, so call it out explicitly both ways + a darker 'trade' cue.
  // (The purple carrier tint + holder countdown drop on their own via STATE the instant quad ends.)
  if (mine && m.traded) {
    const label = m.traded === 'quad'
      ? `◈ QUAD SPENT — ${m.kind === 'mega' ? 'MEGA' : 'ARMOR'} UP`   // spent the quad to take a defensive
      : 'PLATES SPENT — ◈ QUAD DAMAGE';                               // spent the defensive to take the quad
    pickupToast = { text: label, until: performance.now() + 2200 };
    lastTradeEvent = { traded: m.traded, kind: m.kind, text: label, at: performance.now() };
    playSynth('trade', true);
    return;
  }
  const label = m.kind === 'quad' ? 'QUAD DAMAGE' : (ITEM_STYLE[m.kind]?.label || 'PICKUP');
  if (mine) { pickupToast = { text: label, until: performance.now() + 1800 }; playSynth(m.kind, true); }
  else if (m.kind === 'quad') playSynth('quad', false);
});
// server-authoritative objective state @20Hz — render only, decide nothing
Net.on(S2C.OBJECTIVE, onObjective);
Net.on(S2C.SHOT, (m) => {
  if (m.id === me.id) return;                 // my own bolt/rail is spawned locally in fire()/releaseCharge()
  flashUntil.set(m.id, performance.now() + 90);
  const sh = Net.players.get(m.id);
  if (!sh || !Number.isFinite(m.ang)) return;
  // railgun shots carry `charge` (0..1) — everyone sees the piercing rail, not a bolt
  if (m.weapon === 'railgun') spawnBeam(sh.x, sh.y, m.ang, (WEAPONS.railgun && WEAPONS.railgun.range) || 60, m.charge ?? 0);
  else spawnBolt(sh.x, sh.y, m.ang, false);   // a plasma bolt travels from the enemy — you SEE it come
});
Net.on(S2C.HIT, (m) => {
  // I took damage — punchy vignette + a flinch AWAY from the shooter's direction
  if (m.id === me.id) {
    cam.dmgFlash = Math.min(1, cam.dmgFlash + 0.6);
    cam.shake += 3.2;
    const sh = Net.players.get(m.by);
    if (sh) {
      let rel = Math.atan2(sh.y - me.y, sh.x - me.x) - me.ang;
      rel -= Math.round(rel / (2 * Math.PI)) * 2 * Math.PI;
      const side = Math.sin(rel);
      cam.kickX += -side * 7; cam.roll += -side * 0.05; cam.kickY += Math.abs(Math.cos(rel)) * 3.5;
    } else cam.kickY += 6;
    playSfx('hurt');
    window.PlaytestLink && PlaytestLink.event('player_hit', { dmg: m.dmg, hp: m.hp });
  }
  // MY shot landed on someone (server confirmed) — hit-marker + blood at the wound
  if (m.by === me.id && m.id !== me.id) {
    const isKill = m.hp <= 0;
    cross.hit = 1;
    if (!isKill) playSfx('hitmarker', 0.5);   // the kill sound covers the killing blow
    const v = Net.players.get(m.id);
    if (v) {
      let dx = v.x - me.x, dy = v.y - me.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      spawnBurst(v.x - dx * 0.15, v.y - dy * 0.15, 0.42, isKill ? 4 : 10, {
        dirX: dx, dirY: dy, speed: 2.6, up: 1.5, size: 1.5,
      });
    }
  }
});
Net.on(S2C.KILL, (m) => {
  const nm = m.names || {};
  // objective kills (machine weapon 'airlock') read as "VENTED"/"OVERLOADED"; frags stay ⟶
  const text = m.weapon === 'airlock'
    ? `${nm.by || m.by} ✦ ${OBJ_LABELS.feed || 'VENTED'} ${nm.id || m.id}`
    : `${nm.by || m.by} ⟶ ${nm.id || m.id}`;
  killfeed.push({ text, until: performance.now() + 6000 });
  if (killfeed.length > 5) killfeed.shift();
  // I got the frag — kill-marker, a heavier hitstop punch + gib burst
  if (m.by === me.id && m.id !== me.id) {
    cross.hit = 1; cross.kill = 1;
    cam.hitstop = 0.05; cam.kickY += 4; cam.shake += 2.2;
    playSfx('killconfirm', 0.6);
    const v = Net.players.get(m.id);
    if (v) {
      spawnBurst(v.x, v.y, 0.4, 22, { speed: 3.4, up: 2.2, spread: 1.3, size: 2.2, life: 1.4 });
      spawnBurst(v.x, v.y, 0.5, 8, { speed: 1.6, up: 2.6, size: 3.0, life: 1.7, r: 130, g: 12, b: 10 });
    }
    window.PlaytestLink && PlaytestLink.event('kill', { victim: m.id });
  }
  if (m.id === me.id) { playSfx('death'); window.PlaytestLink && PlaytestLink.event('death', { by: m.by }); }
});
Net.on(S2C.SPAWN, (m) => {
  if (m.id === me.id) {
    me.x = m.x; me.y = m.y; me.ang = m.ang; me.dead = false;
    // respawn drops picked-up weapons back to the carbine (server does the same);
    // the S2C.WEAPON that follows confirms it.
    me.weapon = DEFAULT_WEAPON; me.owned = new Set([DEFAULT_WEAPON]);
    me.clips = { [DEFAULT_WEAPON]: WEAPONS[DEFAULT_WEAPON].clip }; me.clip = me.clips[DEFAULT_WEAPON];
    playSfx('spawn');
  }
});

// ---------------------------------------------------------------- input
const keys = {};
let fireHeld = false;
// mobile twin-stick intent — additive, provably inert on desktop (tmove stays {0,0} and
// touchFireHeld stays false unless the touch layer at the bottom of this file installs).
const tmove = { f: 0, s: 0 };
let touchFireHeld = false;
let qaHeld = false;   // synthetic fire-intent for the __game QA hooks (routes charge through the real input path)
if (!IS_BOT) {
  addEventListener('keydown', (e) => {
    if (window.PlaytestLink && (e.code === 'KeyT' || e.code === 'KeyM')) return; // owned by playtest-link
    keys[e.code] = true;
    if (e.code === 'KeyR') startReload();
    // weapon switch: number keys pick a slot directly, Q cycles owned weapons
    const dm = /^Digit([1-9])$/.exec(e.code);
    if (dm) { const k = WEAPON_SLOTS[+dm[1]]; if (k) switchWeapon(k); }
    if (e.code === 'KeyQ') cycleWeapon(1);
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('wheel', (e) => { if (started && !me.dead) cycleWeapon(e.deltaY > 0 ? 1 : -1); }, { passive: true });
  screen.addEventListener('click', () => { if (started && !document.pointerLockElement) screen.requestPointerLock?.(); });
  addEventListener('mousemove', (e) => { if (document.pointerLockElement === screen) me.ang += e.movementX * 0.0032; });
  addEventListener('mousedown', () => { if (document.pointerLockElement === screen) fireHeld = true; });
  addEventListener('mouseup', () => { fireHeld = false; });
  const overlay = document.getElementById('overlay');
  const enter = () => {
    started = true;
    overlay.classList.add('hide');
    audioUnlocked = true;   // browsers only allow audio after a user gesture
    screen.requestPointerLock?.();
  };
  // background click / center-tap enters the CURRENTLY LOADED arena (this preserves
  // every existing tap-to-enter path — verify.mjs, mobile-verify, a plain click).
  overlay.addEventListener('click', enter);

  // ---- START-SCREEN MAP PICKER (the LIGHTEST "both arenas live + selectable") ----
  // The server is single-arena-per-process, so each deck is its own instance and the
  // arena is chosen by URL: this menu just sets ?map= and reloads onto the matching
  // server (net.js routes the WS by ?map=). "Player chooses when spinning up a room."
  // Gated to the two USER arenas so dev/verify maps (hangar-bay) keep the plain screen.
  const PICKS = [
    { id: 'deck7-derelict', name: 'ORIGINAL', tag: 'RING OF 8 · DEATHMATCH', accent: '#3cd6ff' },
    { id: 'deck7v2',        name: 'DECK7 · V2', tag: '5 ZONES · OVERLOAD THE CORE', accent: '#ffb03a' },
  ];
  if (PICKS.some((p) => p.id === world.id)) {
    const go = (id) => {                                   // switch arena = reload with ?map=id (keeps other params)
      const q = new URLSearchParams(location.search);
      q.set('map', id);
      location.search = q.toString();
    };
    const pick = document.createElement('div');
    pick.id = 'arenapick';
    for (const p of PICKS) {
      const cur = p.id === world.id;
      const card = document.createElement('div');
      card.className = 'acard' + (cur ? ' cur' : '');
      card.style.setProperty('--ac', p.accent);
      card.innerHTML = `<div class="an">${p.name}</div><div class="at">${p.tag}</div>`
        + `<div class="ago">${cur ? '▶ ENTER' : 'SWITCH ›'}</div>`;
      card.addEventListener('click', (e) => { e.stopPropagation(); if (cur) enter(); else go(p.id); });
      pick.appendChild(card);
    }
    const go1 = overlay.querySelector('.go');
    if (go1) { go1.textContent = 'pick an arena — or click anywhere to enter'; go1.style.fontSize = '11px'; go1.style.border = 'none'; go1.style.opacity = '0.7'; }
    overlay.insertBefore(pick, go1 || null);
  }
} else {
  document.getElementById('overlay').classList.add('hide');
}

// ---------------------------------------------------------------- bot wiring
let botThink = null;
if (IS_BOT) {
  let botF = 0, botS = 0;
  botThink = createBot({
    me,
    players: () => [...Net.players.values()],
    world, raycast, isSolidCell, spawns: world.spawns,
    fire, reload: startReload,
    setMove: (f, s) => { botF = f; botS = s; },
    WEAPONS, weaponKey: me.weapon,
  });
  me._botMove = () => ({ f: botF, s: botS });
}

// ---------------------------------------------------------------- loop
let last = 0, netAcc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const t = now / 1000;
  const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
  last = now;

  // read authoritative bits about myself from server state
  const mine = Net.players.get(me.id);
  if (mine) { me.dead = mine.dead; me._hp = mine.hp; me._frags = mine.frags; me._armor = mine.armor || 0; me._quad = mine.quad || 0; }
  if (me.dead && me.charging) cancelCharge();   // died mid-charge — drop the clock

  // reload completion (predicted; server also confirms via S2C.WEAPON)
  if (me.wasReloading && performance.now() >= me.reloadUntil) { me.clip = WEAPONS[me.weapon].clip; me.clips[me.weapon] = me.clip; me.wasReloading = false; }

  // KILL HITSTOP: for one beat the local sim holds its breath so a frag lands
  // with weight. Networking + rendering keep running; only input/movement/decay
  // pause (~50ms), and it's disabled for headless bots. This just skips a couple
  // of local frames — the server clock is untouched, so it's netcode-safe.
  const frozen = !IS_BOT && cam.hitstop > 0;
  if (frozen) cam.hitstop -= dt;

  if (!frozen) {
    // movement intent
    let f = 0, s = 0;
    if (IS_BOT) { botThink(dt); const mv = me._botMove(); f = mv.f; s = mv.s; if (me.clip <= 0) startReload(); }
    else if (started && !me.dead) {
      if (keys.KeyW || keys.ArrowUp) f += 1;
      if (keys.KeyS || keys.ArrowDown) f -= 1;
      if (keys.KeyA) s -= 1;
      if (keys.KeyD) s += 1;
      f += tmove.f; s += tmove.s;                   // mobile twin-stick (0,0 on desktop)
      if (keys.ArrowLeft) me.ang -= 2.4 * dt;
      if (keys.ArrowRight) me.ang += 2.4 * dt;
      // fire input: instant weapons auto-fire while held; charge weapons (railgun)
      // spin up on press and fire on RELEASE (server times the hold).
      const held = fireHeld || touchFireHeld || qaHeld;   // qaHeld: synthetic intent for QA hooks
      if (WEAPONS[me.weapon].charge) {
        if (held && !me.charging) beginCharge();
        else if (!held && me.charging) releaseCharge();
      } else {
        if (me.charging) cancelCharge();             // e.g. switched off a charge weapon mid-hold
        if (held) fire();
      }
    }
    if (!me.dead) {
      const len = Math.hypot(f, s); if (len > 1) { f /= len; s /= len; }
      const SPEED = 3.4;
      const dirX = Math.cos(me.ang), dirY = Math.sin(me.ang);
      moveMe((dirX * f - dirY * s) * SPEED * dt, (dirY * f + dirX * s) * SPEED * dt);
      me.moving += ((len > 0.1 ? 1 : 0) - me.moving) * Math.min(1, dt * 10);
      if (len > 0.1) me.bobPhase += dt * 8.5;
      me.strafeLean += (s - me.strafeLean) * Math.min(1, dt * 6);
    }

    // combat feel: advance gore + traveling bolts + fading rails
    tickParticles(dt);
    tickBolts(dt);
    tickBeams(dt);

    // decay fx (springs)
    vm.flash = Math.max(0, vm.flash - dt * 8);
    vm.kick = Math.max(0, vm.kick - dt * 6);
    vm.rail = Math.max(0, vm.rail - dt * 6);      // first-person rail flash (~165ms)
    cam.kickY *= Math.max(0, 1 - dt * 9);
    cam.kickX *= Math.max(0, 1 - dt * 9);
    cam.roll *= Math.max(0, 1 - dt * 7);
    cam.shake = Math.max(0, cam.shake - dt * 22);
    cam.dmgFlash = Math.max(0, cam.dmgFlash - dt * 1.6);
    cross.bloom = Math.max(0, cross.bloom - dt * 4);      // crosshair tightens back
    cross.hit = Math.max(0, cross.hit - dt * 3.2);
    cross.kill = Math.max(0, cross.kill - dt * 2.5);

    // --- OBJECTIVE camera FX (all cosmetic): bay-door crank + vent suck ---
    // Reads objState/phase only; never touches me.x/me.y (what the server sees).
    let doorTarget = 0;
    if (objState && airlock) {
      const ph = objState.phase, tot = objState.total || 1;
      if (ph === 'arming') doorTarget = 0.06 + 0.22 * ((objState.armedCount || 0) / tot);   // cracks as consoles arm
      else if (ph === 'opening') { const fr = objState.timer != null ? 1 - objState.timer / OBJ_TIMING.DOOR_OPEN_MS : 1; doorTarget = 0.3 + 0.7 * Math.max(0, Math.min(1, fr)); }
      else if (ph === 'venting') doorTarget = 1;           // idle stays 0 (shut)
    }
    cam.door += (doorTarget - cam.door) * Math.min(1, dt * 3.2);

    const venting = !!(objState && objState.phase === 'venting');
    const iAmWinner = venting && objState.winner && objState.winner.id === me.id;
    if (venting && airlock) {
      const ramp = objState.timer != null ? Math.max(0, Math.min(1, 1 - objState.timer / OBJ_TIMING.VENT_MS)) : 1;
      const ap = airlockPull();
      const dx = ap.cx - me.x, dy = ap.cy - me.y, L = Math.hypot(dx, dy) || 1;
      const camMax = iAmWinner ? 0.14 : 1.15;              // the holder braces; everyone else is sucked out
      cam.ventOffX += ((dx / L) * camMax * ramp - cam.ventOffX) * Math.min(1, dt * 4);
      cam.ventOffY += ((dy / L) * camMax * ramp - cam.ventOffY) * Math.min(1, dt * 4);
      cam.bodyPull = (iAmWinner ? 0.5 : 2.0) * ramp;
      if (!iAmWinner) cam.shake = Math.max(cam.shake, 1.0 + ramp * 1.6);
      for (const p of particles) { const gx = ap.cx - p.x, gy = ap.cy - p.y, gl = Math.hypot(gx, gy) || 1; p.dx += (gx / gl) * 9 * dt; p.dy += (gy / gl) * 9 * dt; }
    } else {
      cam.ventOffX *= Math.max(0, 1 - dt * 3);
      cam.ventOffY *= Math.max(0, 1 - dt * 3);
      cam.bodyPull *= Math.max(0, 1 - dt * 4);
    }
    cam.ventFlash = Math.max(0, cam.ventFlash - dt * 1.4);
  }

  // send position to server ~20Hz (never gated — keep the connection warm)
  netAcc += dt;
  if (netAcc >= 0.05) { netAcc = 0; if (Net.connected) Net.move(+me.x.toFixed(3), +me.y.toFixed(3), +me.ang.toFixed(3), me.moving > 0.2 ? 1 : 0); }

  // draw — composite the world with camera kick, roll and a hit-shake jitter.
  // SKIP the entire draw for bots: their AI runs off server state, never reads a
  // pixel, so software-rendering raycaster frames just pins a CPU core for nothing
  // (tinyclaw/VoX load flag). Game logic + net above still run at full rate.
  if (!IS_BOT) {
    render(t);
    const shx = cam.shake ? (Math.random() - 0.5) * cam.shake : 0;
    const shy = cam.shake ? (Math.random() - 0.5) * cam.shake : 0;
    sctx.save();
    sctx.fillStyle = '#05060a'; sctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    sctx.translate(SCREEN_W / 2, SCREEN_H / 2);
    sctx.rotate(cam.roll);
    const over = 1 + Math.abs(cam.roll) * 1.6;      // scale up to hide corners the roll exposes
    sctx.scale(over, over);
    sctx.drawImage(off, -SCREEN_W / 2 + cam.kickX * 0.3 + shx, -SCREEN_H / 2 + cam.kickY * 0.3 + shy);
    sctx.restore();
    if (!me.dead) drawGun(sctx, t);
    if (!me.dead) drawCrosshair(sctx);
  }
  updateHUD();   // cheap DOM (no GPU) — keep it for bots too, feeds state hooks
}

// reactive crosshair + hit-marker, drawn straight on the display canvas so it
// blooms with recoil/movement and confirms landed shots (white pip; red on a kill).
function drawCrosshair(ctx) {
  const cx = SCREEN_W / 2, cy = HORIZON;
  const gap = 2.5 + cross.bloom * 6 + me.moving * 2.5, len = 3.5, th = 1;
  ctx.save();
  ctx.fillStyle = 'rgba(60,214,255,0.9)';
  ctx.fillRect(cx - th / 2, cy - gap - len, th, len);
  ctx.fillRect(cx - th / 2, cy + gap, th, len);
  ctx.fillRect(cx - gap - len, cy - th / 2, len, th);
  ctx.fillRect(cx + gap, cy - th / 2, len, th);
  ctx.fillRect(cx - 0.5, cy - 0.5, 1, 1);
  if (cross.hit > 0) {
    const k = Math.min(1, cross.hit), hr = 4 + (1 - k) * 5, hl = 4;
    ctx.globalAlpha = k;
    ctx.strokeStyle = cross.kill > 0 ? 'rgba(255,70,80,1)' : 'rgba(255,255,255,1)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.moveTo(cx + sx * hr, cy + sy * hr);
      ctx.lineTo(cx + sx * (hr + hl), cy + sy * (hr + hl));
    }
    ctx.stroke();
  }
  // CHARGE RING (railgun): a ring that sweeps clockwise from 12 o'clock as you hold.
  // DIM red arc = still under the min gate (a release now duds); it snaps to the rail
  // colour + a full white pulse the instant you're armed, so the min/full timing is
  // legible without looking at the ammo. Whole thing only shows while charging.
  if (me.charging && WEAPONS[me.weapon].charge) {   // wp.charge guard mirrors drawGun (defends a mid-charge weapon swap)
    const wp = WEAPONS[me.weapon];
    const held = performance.now() - me.chargeStart;
    const armed = held >= wp.charge.minMs;
    const cf = chargeFrac();                                  // 0 at min, 1 at full
    const sweep = Math.max(0, Math.min(1, held / wp.charge.fullMs));  // whole-hold fill 0..1
    const R = 12;
    ctx.globalAlpha = armed ? 0.95 : 0.55;
    ctx.lineWidth = armed ? 2 : 1.4;
    ctx.strokeStyle = armed ? 'rgba(200,107,255,1)' : 'rgba(255,80,80,1)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + sweep * Math.PI * 2);
    ctx.stroke();
    if (cf >= 1) {                                            // fully charged — bright pulse ring
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(performance.now() / 60);
      ctx.strokeStyle = 'rgba(255,255,255,1)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(cx, cy, R + 2.5, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- HUD
const $ = (id) => document.getElementById(id);
function updateHUD() {
  const hp = me._hp ?? 100;
  $('hp').textContent = Math.max(0, hp | 0);
  const bar = $('hpbar').firstElementChild;
  bar.style.width = Math.max(0, Math.min(100, hp)) + '%';   // overheal (>100) reads via colour, not an overflowing bar
  bar.style.background = hp > 100 ? '#7ce6ff' : hp > 55 ? '#ffb03a' : hp > 25 ? '#ff7a1a' : '#ff3c4a';
  // ARMOR — plates absorb ~2/3 of each hit until spent; dim the readout when empty
  const armor = me._armor ?? 0;
  const aw = $('armorwrap');
  if (aw) {
    $('armor').textContent = Math.max(0, armor | 0);
    const abar = $('armorbar').firstElementChild; if (abar) abar.style.width = Math.max(0, Math.min(100, armor)) + '%';
    aw.style.opacity = armor > 0 ? '0.95' : '0.28';
  }
  $('ammo').textContent = me.dead ? '—' : me.clip;
  // weapon name (weapon-coloured); briefly flashes the "PICKED UP …" toast on a grab
  const wp = WEAPONS[me.weapon] || WEAPONS[DEFAULT_WEAPON];
  const wEl = $('weapon');
  if (wEl) {
    const toast = pickupToast.until > performance.now();
    wEl.textContent = toast ? pickupToast.text : (me.dead ? '' : wp.name);
    wEl.style.color = wp.color || '';
  }
  $('dmgflash').style.opacity = cam.dmgFlash * 0.7;
  $('status').textContent = me.dead ? 'RESPAWNING…' : (Net.connected ? '' : 'reconnecting…');

  // scoreboard
  const ps = [...Net.players.values()].sort((a, b) => b.frags - a.frags).slice(0, 6);
  $('scoreboard').innerHTML = ps.map((p) =>
    `<div class="row ${p.id === me.id ? 'me' : ''}" style="color:${p.id === me.id ? '' : p.color}">${p.name} · ${p.frags}</div>`).join('');
  // killfeed
  const nowMs = performance.now();
  while (killfeed.length && killfeed[0].until < nowMs) killfeed.shift();
  $('killfeed').innerHTML = killfeed.map((k) => `<div>${k.text}</div>`).join('');

  // objective banner (only on objective decks — deck7 deathmatch stays blank)
  updateObjectiveHUD();
  const vf = $('ventflash'); if (vf) vf.style.opacity = cam.ventFlash * 0.55;

  // THE QUAD clock (only on decks with a quad — deck7v2). Three states, server-driven:
  //   I'm the CARRIER  -> my remaining quad time, bright + pulsing;
  //   someone else HAS it (pad grabbed) -> "HELD";
  //   otherwise -> the wall-clock telegraph (up in / next in), matching the pad glow.
  const qc = $('quadclock');
  if (qc) {
    if (!powerSpots.length) qc.style.display = 'none';
    else {
      qc.style.display = 'block';
      const myQuad = me._quad || 0;
      const grabbed = powerSpots.some((pk) => pickupTaken.get(pk.id));
      if (myQuad > 0) {
        const s = Math.ceil(myQuad / 1000);
        qc.className = 'hud ready';
        qc.textContent = `◈ QUAD DAMAGE · 0:${String(s).padStart(2, '0')}`;
      } else if (grabbed) {
        qc.className = 'hud';
        qc.textContent = '◈ QUAD  HELD';
      } else {
        const qs = quadState();
        qc.className = 'hud' + (qs.ready ? ' ready' : '');
        const mm = Math.floor(qs.secs / 60), ss = String(qs.secs % 60).padStart(2, '0');
        qc.textContent = qs.ready ? `◈ QUAD  UP · ${mm}:${ss}` : `◈ QUAD  ${mm}:${ss}`;
      }
    }
  }
}

// The objective HUD: phase label, consoles armedCount/total with per-owner pips,
// a phase timer, and the winner on the vent. Reads objState (server truth) only.
function updateObjectiveHUD() {
  const el = $('objective'); if (!el) return;
  if (!objState) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const o = objState, tot = o.total || 0, armed = o.armedCount || 0;
  const secs = o.timer != null ? Math.max(0, Math.ceil(o.timer / 1000)) : null;
  // themed labels (deck7v2 -> OVERLOAD; airlock defaults otherwise)
  const L = OBJ_LABELS;
  let phaseTxt, sub, cls = '';
  if (o.phase === 'opening') {
    phaseTxt = L.defend || 'DEFEND THE AIRLOCK';
    sub = `${L.defendSub || 'DOOR OPENING'}${secs != null ? ` · ${secs}s` : ''}`;
    cls = 'warn';
  } else if (o.phase === 'venting') {
    const w = o.winner;
    phaseTxt = w ? `${w.name} ${L.win || 'WINS'}` : (L.voidWin || 'THE VOID WINS');
    sub = `${L.winSub || 'VENTING'}${secs != null ? ` · ${secs}s` : ''}`;
    cls = 'vent';
    if (w && w.color) el.style.setProperty('--win', w.color);
  } else { phaseTxt = L.arm || 'ARM THE CONSOLES'; sub = `${L.armSub || 'CONSOLES'} ${armed}/${tot}`; }
  const pips = (o.consoles || []).map((c) => {
    const col = c.armed && c.color ? c.color : (c.owner != null && c.color ? c.color : '#3a4a52');
    const fill = c.armed ? 1 : Math.max(0, Math.min(1, c.progress || 0));
    return `<span class="pip" style="border-color:${col};box-shadow:0 0 5px ${c.armed ? col : 'transparent'}">`
      + `<i style="background:${col};height:${Math.round(fill * 100)}%"></i></span>`;
  }).join('');
  // action prompt: teach the loop while there's still a console to grab (idle/arming)
  const showPrompt = (o.phase === 'idle' || o.phase === 'arming') && armed < tot && L.pad;
  const prompt = showPrompt ? `<div class="prompt">${L.pad}</div>` : '';
  el.className = 'hud ' + cls;
  el.innerHTML = `<div class="phase">${phaseTxt}</div><div class="sub">${sub}</div><div class="pips">${pips}</div>${prompt}`;
}

// ---------------------------------------------------------------- boot
// the reactive crosshair + hit-marker are drawn on the canvas now — retire the
// static DOM one so they don't double up.
const _domCross = document.getElementById('cross');
if (_domCross) _domCross.style.display = 'none';

Net.connect(MY_NAME);

// __game hook (playtest-link AGENT-INSTRUCTIONS bar 7) + QA teleport
window.__game = {
  get phase() { return me.dead ? 'dead' : 'playing'; },
  get hp() { return me._hp ?? 100; },
  get armor() { return me._armor ?? 0; },            // QA: authoritative armor plates
  get quadMs() { return me._quad ?? 0; },            // QA: ms of QUAD damage left on ME (0 = none)
  get toast() { return pickupToast.until > performance.now() ? pickupToast.text : ''; }, // QA: active pickup/trade toast text ('' when none)
  get lastTrade() { return lastTradeEvent; },        // QA: last SYMMETRIC-TRADE I fired { traded, kind, text, at } (sticky; null if none)
  get frags() { return me._frags ?? 0; },
  get x() { return me.x; },
  get y() { return me.y; },
  get yaw() { return me.ang; },
  get zone() { return world.name; },
  get players() { return Net.players.size; },
  get id() { return me.id; },
  get connected() { return Net.connected; },
  get clip() { return me.clip; },                   // QA: rounds in the current magazine
  get fireT() { return me.fireT; },                 // QA: last-shot timestamp (monotonic; advances per fired shot)
  snapshot() { return [...Net.players.values()]; }, // authoritative view of all players
  counts() { return { particles: particles.length, splats: splats.length, bolts: bolts.length }; }, // QA: feel-fx liveness
  get objective() { return objState; },             // QA: server objective snapshot (null on deathmatch)
  get objLabels() { return OBJ_LABELS; },           // QA: themed objective labels for this deck
  get quad() { return powerSpots.length ? { ...quadState(), spots: powerSpots.length } : null; }, // QA: THE QUAD telegraph state
  get mapId() { return world.id; },                 // QA: which arena this client compiled
  get door() { return cam.door; },                  // QA: bay-door crank 0..1
  get ventPull() { return [+cam.ventOffX.toFixed(3), +cam.ventOffY.toFixed(3)]; }, // QA: render-only vent camera offset
  get weapon() { return me.weapon; },               // QA: current authoritative weapon key
  get owned() { return [...me.owned]; },             // QA: owned weapon keys
  get reloading() { return me.reloadUntil > performance.now(); },
  pickups() { return weaponSpots.map((p) => ({ id: p.id, weapon: p.weapon, taken: !!pickupTaken.get(p.id) })); },
  items() { return [...itemSpots, ...powerSpots].map((p) => ({ id: p.id, kind: p.mega ? 'mega' : p.kind, taken: !!pickupTaken.get(p.id) })); }, // QA: sustain + quad pad state
  teleport(x, y, ang) { me.x = x; me.y = y; if (ang !== undefined) me.ang = ang; },
  setPos(x, y, ang) { this.teleport(x, y, ang); },
  fire() { me.fireT = -1e9; fire(); },
  charge() { me.fireT = -1e9; qaHeld = true; },        // QA: press-and-hold (the loop starts the charge)
  release() { qaHeld = false; },                       // QA: let go → the loop fires/fizzles per hold time
  get charging() { return me.charging; },             // QA: mid-charge?
  get chargeFrac() { return chargeFrac(); },          // QA: 0 at min-gate, 1 at full
  get beams() { return beams.length; },               // QA: live rail count
  reload() { startReload(); },                       // QA: trigger a reload
  switchWeapon(k) { switchWeapon(k); },              // QA: request a switch
  start() { started = true; const o = document.getElementById('overlay'); if (o) o.classList.add('hide'); }, // QA: enter without a click
};

// playtest-link: the player's (and every bot's) direct line to BMO.
//
// CRITICAL for a networked shooter: getState/getAim report the SERVER-
// AUTHORITATIVE snapshot (Net.players is filled straight from S2C.STATE), NOT
// the client's local dead-reckoned prediction. If a report said "he was over
// THERE / I shot through a wall", it must carry the positions the server's
// hitscan actually used — otherwise we'd debug a lie. We fall back to the local
// prediction only before the first server snapshot arrives.
if (window.PlaytestLink) try {
  const authMe = () => Net.players.get(me.id);
  PlaytestLink.init({
    canvas: screen,
    endpoint: '/sxs-assets/api',
    game: 'starfrag',
    version: 'version.json',
    autoReportCrashes: true,
    fps: 12, bitrate: 600000, clipSec: 4,   // netcode client — keep recorder cost low
    getState: () => {
      const a = authMe();
      const src = a || me;                    // authoritative when we have it
      return {
        zone: world.name, authoritative: !!a,
        x: +src.x.toFixed(2), y: +src.y.toFixed(2), yaw: +(a ? a.ang : me.ang).toFixed(2),
        hp: a ? a.hp : (me._hp ?? 100), frags: a ? a.frags : 0, dead: a ? a.dead : me.dead,
        clip: me.clip, bot: IS_BOT, players: Net.players.size,
        // other players as the SERVER sees them, so "he was over there" is checkable
        others: [...Net.players.values()].filter((p) => p.id !== me.id)
          .map((p) => `${p.name}@${p.x.toFixed(1)},${p.y.toFixed(1)}${p.dead ? '(dead)' : ''}`),
      };
    },
    getAim: () => {
      // resolve the crosshair in SERVER-truth space (authoritative origin + yaw)
      const a = authMe() || me;
      const ox = a.x, oy = a.y, oa = a.ang;
      const dirX = Math.cos(oa), dirY = Math.sin(oa);
      const hit = raycast(world.grid, world.W, world.H, ox, oy, dirX, dirY, 40);
      for (const p of Net.players.values()) {
        if (p.id === me.id || p.dead) continue;
        const d = Math.hypot(p.x - ox, p.y - oy);
        if (d < hit.dist) {
          const ad = angDiff(Math.atan2(p.y - oy, p.x - ox), oa);
          if (Math.abs(Math.sin(ad)) * d < 0.6 && Math.cos(ad) > 0) return `${p.name} ${d.toFixed(1)}m`;
        }
      }
      return `wall '${hit.tex}' (${hit.mapX},${hit.mapY}) ${hit.dist.toFixed(1)}m`;
    },
    keys: { mark: 'KeyM', invoke: 'KeyT' },
  });
} catch (e) { console.warn('playtest-link init failed (non-fatal):', e && e.message); }

// ---------------------------------------------------------------- mobile twin-stick
// Pocket controls, touchscreen only: left thumb = floating move stick, right half =
// look-drag (yaw), on-screen FIRE (hold) / RLD / MARK. Feeds the SAME movement intent
// and fire() the desktop path uses (tmove + touchFireHeld, spliced into the loop).
// Gated on a PRIMARY coarse pointer, so mouse devices — desktop AND touch-laptops —
// install nothing here and stay byte-for-byte identical.
(() => {
  const coarse = window.matchMedia ? matchMedia('(pointer: coarse)').matches : ('ontouchstart' in window);
  const TOUCH = coarse || params.get('touch') === '1';   // ?touch=1 = force controls (preview/verify; inert for real desktop)
  if (!TOUCH || IS_BOT) return;
  document.body.classList.add('touch');   // scopes the touch-only HUD shim below

  const css = document.createElement('style');
  css.textContent = `
    #tc { position:fixed; inset:0; z-index:15; pointer-events:auto; touch-action:none;
      -webkit-user-select:none; user-select:none; display:none; }
    #tc .stick { position:fixed; width:118px; height:118px; border-radius:50%; pointer-events:none;
      border:2px solid rgba(60,214,255,.45); background:rgba(60,214,255,.07);
      transform:translate(-50%,-50%); display:none; }
    #tc .knob { position:absolute; left:50%; top:50%; width:54px; height:54px; border-radius:50%;
      pointer-events:none; background:rgba(60,214,255,.32); border:2px solid rgba(60,214,255,.85);
      transform:translate(-50%,-50%); }
    #tc .btn { position:fixed; pointer-events:auto; border-radius:50%; display:flex;
      align-items:center; justify-content:center; font:600 11px 'Courier New',monospace;
      letter-spacing:1px; touch-action:none; width:66px; height:66px; }
    #tc .btn:active { filter:brightness(1.35); }
    #tc .fire   { width:84px; height:84px; right:calc(env(safe-area-inset-right) + 18px);
      bottom:calc(env(safe-area-inset-bottom) + 20px); background:rgba(255,60,74,.26);
      border:2px solid var(--hot,#ff3c4a); color:#ffd7db; }
    #tc .reload { right:calc(env(safe-area-inset-right) + 116px);
      bottom:calc(env(safe-area-inset-bottom) + 20px); background:rgba(60,214,255,.14);
      border:2px solid #3cd6ff; color:#bff0ff; }
    #tc .mark   { right:calc(env(safe-area-inset-right) + 116px);
      bottom:calc(env(safe-area-inset-bottom) + 98px); background:rgba(255,176,58,.14);
      border:2px solid #ffb03a; color:#ffe0b0; }
    #tc .wpn    { right:calc(env(safe-area-inset-right) + 18px);
      bottom:calc(env(safe-area-inset-bottom) + 116px); background:rgba(140,255,90,.14);
      border:2px solid #8cff5a; color:#d6ffbf; }
    /* lift the bottom-right ammo readout clear of the thumb cluster (touch only) */
    body.touch #ammowrap { bottom:calc(env(safe-area-inset-bottom) + 178px); right:20px; }
  `;
  document.head.appendChild(css);

  const mk = (cls, txt) => { const d = document.createElement('div'); d.className = cls; if (txt) d.textContent = txt; return d; };
  const tc = mk('', ''); tc.id = 'tc';
  const stick = mk('stick'), knob = mk('knob'); stick.appendChild(knob); tc.appendChild(stick);
  const fireBtn = mk('btn fire', 'FIRE'), reloadBtn = mk('btn reload', 'RLD'), markBtn = mk('btn mark', 'MARK');
  const wpnBtn = mk('btn wpn', 'WPN');
  tc.append(fireBtn, reloadBtn, markBtn, wpnBtn);
  document.body.appendChild(tc);

  // buttons own their touches — they never drive look/move
  const btn = (node, down, up) => {
    node.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); down(); }, { passive: false });
    if (up) {
      const h = (e) => { e.preventDefault(); e.stopPropagation(); up(); };
      node.addEventListener('touchend', h, { passive: false });
      node.addEventListener('touchcancel', h, { passive: false });
    }
  };
  btn(fireBtn, () => { touchFireHeld = true; }, () => { touchFireHeld = false; });
  btn(reloadBtn, () => startReload());
  btn(markBtn, () => { window.PlaytestLink && PlaytestLink.mark(); });
  btn(wpnBtn, () => cycleWeapon(1));   // cycle owned weapons

  // field: simultaneous move (left half) + look (right half), tracked per touch id
  const STICK_R = 46, TAP_PX = 12, LOOK = 0.006;
  const look = new Map();                 // identifier -> { x, moved }
  let moveId = null, ox = 0, oy = 0;

  tc.addEventListener('touchstart', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (moveId === null && t.clientX < innerWidth / 2) {
        moveId = t.identifier; ox = t.clientX; oy = t.clientY;
        stick.style.left = ox + 'px'; stick.style.top = oy + 'px';
        knob.style.left = '50%'; knob.style.top = '50%'; stick.style.display = 'block';
      } else {
        look.set(t.identifier, { x: t.clientX, moved: 0 });
      }
    }
  }, { passive: false });

  tc.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) {
        let dx = t.clientX - ox, dy = t.clientY - oy;
        const m = Math.hypot(dx, dy);
        if (m > STICK_R) { dx = dx / m * STICK_R; dy = dy / m * STICK_R; }
        knob.style.left = `calc(50% + ${dx}px)`; knob.style.top = `calc(50% + ${dy}px)`;
        tmove.f = -dy / STICK_R; tmove.s = dx / STICK_R;
      } else {
        const st = look.get(t.identifier); if (!st) continue;
        const dx = t.clientX - st.x;
        me.ang += dx * LOOK; st.moved += Math.abs(dx); st.x = t.clientX;
      }
    }
  }, { passive: false });

  const end = (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) {
        moveId = null; tmove.f = 0; tmove.s = 0; stick.style.display = 'none';
      } else {
        const st = look.get(t.identifier);
        if (st) { if (st.moved < TAP_PX && started && !me.dead) fire(); look.delete(t.identifier); }
      }
    }
  };
  tc.addEventListener('touchend', end, { passive: false });
  tc.addEventListener('touchcancel', end, { passive: false });

  // controls show only in-play (hidden under the start / respawn overlay)
  const sync = () => { const on = started ? 'block' : 'none'; if (tc.style.display !== on) tc.style.display = on; };
  sync(); setInterval(sync, 200);

  // touch-friendly overlay copy
  const hint = document.querySelector('#overlay .keys');
  if (hint) hint.textContent = 'LEFT drag move · RIGHT drag look · FIRE / RLD · 📣 report · MARK';
  const go = document.querySelector('#overlay .go');
  if (go) go.textContent = 'TAP TO ENTER THE ARENA';
})();

requestAnimationFrame(frame);
