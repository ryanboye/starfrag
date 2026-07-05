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
import { WEAPONS, DEFAULT_WEAPON, C2S, S2C } from '../shared/protocol.js';
import { compileMap, raycast, isSolidCell, TEX } from '../shared/map.js';
import { Net } from './net.js';
import { createBot } from './bot.js';

// ---------------------------------------------------------------- setup
const SCREEN_W = 384, SCREEN_H = 240, HORIZON = SCREEN_H >> 1;
const FOV_HALF = 0.6;
const PROJ = (SCREEN_W / 2) / Math.tan(FOV_HALF);
const FOG_K = 0.085;

const world = compileMap();                 // { W, H, grid, spawns, pickups, sky, name }
const params = new URLSearchParams(location.search);
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
};
const cam = { kickY: 0, kickX: 0, roll: 0, dmgFlash: 0 };
const vm = { flash: 0, kick: 0 };            // viewmodel fx
let started = IS_BOT;                          // bots skip the click-to-start gate
const flashUntil = new Map();                 // playerId -> ms, remote muzzle flash
const killfeed = [];                          // { text, until }

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
let trooperSprite = null, gunSprite = null;
loadSprite(ART_DIR + 'trooper.png', (s) => { trooperSprite = s; });
loadSprite(ART_DIR + 'carbine.png', (s) => { gunSprite = s; });

// ---------------------------------------------------------------- sky / viewport
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
    const cr = 0x5a, cg = 0x7f, cb = 0xa8;              // planet base tint
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

// ---------------------------------------------------------------- renderer
const WALLCOL = {
  [TEX.HULL]: [96, 88, 78], [TEX.TECH]: [74, 92, 116], [TEX.PANEL]: [128, 126, 134],
  [TEX.PILLAR]: [128, 104, 66], [TEX.REACTOR]: [255, 150, 48],
};

function render(t) {
  const dirX = Math.cos(me.ang), dirY = Math.sin(me.ang);
  const tanH = Math.tan(FOV_HALF);
  const planeX = -dirY * tanH, planeY = dirX * tanH;

  // --- floor & ceiling (procedural deck grid, cheap) ---
  const rdx0 = dirX - planeX, rdy0 = dirY - planeY;
  const rdx1 = dirX + planeX, rdy1 = dirY + planeY;
  for (let y = HORIZON + 1; y < SCREEN_H; y++) {
    const d = rowDist[y];
    const m = fog(d);
    let fx = me.x + d * rdx0, fy = me.y + d * rdy0;
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
    const hit = raycast(world.grid, world.W, world.H, me.x, me.y, rdx, rdy, 64);
    const dist = hit.dist;
    zbuf[x] = dist;
    const lineH = PROJ / dist;
    let y0 = (HORIZON - lineH / 2) | 0, y1 = (HORIZON + lineH / 2) | 0;
    const cy0 = Math.max(0, y0), cy1 = Math.min(SCREEN_H, y1);

    if (hit.tex === TEX.VIEWPORT) {
      const az = Math.atan2(rdy, rdx);
      let fi = cy0 * SCREEN_W + x;
      for (let y = cy0; y < cy1; y++, fi += SCREEN_W) {
        const v = (y - y0) / lineH;
        // metal window frame top & bottom
        if (v < 0.1 || v > 0.9) { const m = fog(dist); fb[fi] = packRGB(60 * m | 0, 62 * m | 0, 70 * m | 0); }
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
  const list = [];
  for (const p of Net.players.values()) {
    if (p.id === me.id || p.dead) continue;
    const relX = p.x - me.x, relY = p.y - me.y;
    const tx = invDet * (dirY * relX - dirX * relY);
    const ty = invDet * (-planeY * relX + planeX * relY);
    if (ty > 0.2) list.push({ p, tx, ty });
  }
  list.sort((a, b) => b.ty - a.ty);
  const nowMs = performance.now();
  for (const s of list) {
    const { p, tx, ty } = s;
    // real trooper art when loaded (drawn full-colour); tinted procedural fallback
    const spr = (trooperSprite && trooperSprite.px) ? trooperSprite : trooper;
    const real = spr === trooperSprite;
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
    for (let x = cx0; x < cx1; x++) {
      if (ty >= zbuf[x]) continue;
      const sxp = ((x - x0) * stepTX) | 0;
      if (sxp < 0 || sxp >= spr.w) continue;
      let tyf = (cyy0 - yStart) * stepTY, fi = cyy0 * SCREEN_W + x;
      for (let y = cyy0; y < cyy1; y++, fi += SCREEN_W, tyf += stepTY) {
        const px = spr.px[((tyf | 0) * spr.w) + sxp];
        if ((px >>> 24) < 110) continue;
        const r = (px & 255), g = (px >> 8) & 255, b = (px >> 16) & 255;
        fb[fi] = real
          ? packRGB((r * m) | 0, (g * m) | 0, (b * m) | 0)
          : packRGB((r * col[0] / 255 * m) | 0, (g * col[1] / 255 * m) | 0, (b * col[2] / 255 * m) | 0);
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

  octx.putImageData(img, 0, 0);
}

function hexRGB(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

// ---------------------------------------------------------------- weapon viewmodel
function drawGun(ctx, t) {
  const wp = WEAPONS[me.weapon];
  const bobA = me.moving;
  const bx = Math.sin(me.bobPhase) * 6 * bobA - me.strafeLean * 6;
  const by = (1 - Math.cos(me.bobPhase * 2)) * 3 * bobA;
  const kick = vm.kick * 10;
  let dip = 0, roll = 0;
  const rem = me.reloadUntil - performance.now();
  if (rem > 0) { const k = 1 - rem / wp.reloadMs; dip = Math.sin(k * Math.PI) * 46; roll = Math.sin(k * Math.PI) * 0.25; }

  const cx = SCREEN_W / 2 + bx + cam.kickX * 0.4;
  const baseY = SCREEN_H + kick + dip + by + cam.kickY * 0.3;

  let muzzleY = baseY - 120;   // procedural fallback muzzle height
  ctx.save();
  ctx.translate(cx, baseY);
  ctx.rotate(roll);
  if (gunSprite) {
    // real POV pulse carbine (sprite-forge / gpt-image-2), anchored bottom-centre
    const gw = SCREEN_W * 0.7;
    const gh = gw * (gunSprite.h / gunSprite.w);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(gunSprite.canvas, -gw / 2, -gh, gw, gh);
    muzzleY = baseY - gh * 0.96;   // flash at the foreshortened barrel tip
  } else {
    // procedural fallback (draws until the sprite loads)
    ctx.fillStyle = '#20242c'; ctx.fillRect(-34, -46, 68, 60);
    ctx.fillStyle = '#2c323c'; ctx.fillRect(-30, -70, 60, 30);
    ctx.fillStyle = '#171a20'; ctx.fillRect(-12, -118, 24, 60);   // barrel/receiver up to muzzle
    ctx.fillStyle = '#3a4450'; ctx.fillRect(-8, -116, 16, 10);    // barrel shroud band
    // energy cell (glowing)
    ctx.fillStyle = '#0a3a44'; ctx.fillRect(-26, -40, 10, 34);
    ctx.fillStyle = me.clip > 0 ? '#3cd6ff' : '#ff3c4a';
    ctx.fillRect(-24, -38 + 30 * (1 - me.clip / wp.clip), 6, 30 * (me.clip / wp.clip) + 1);
    // sight
    ctx.fillStyle = '#3a4450'; ctx.fillRect(-3, -128, 6, 12);
  }
  ctx.restore();

  // muzzle flash — separate additive overlay, fired via vm.flash (never baked in)
  if (vm.flash > 0.35) {
    const mx = cx, my = muzzleY;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(mx, my);
    ctx.rotate(Math.random() * 6.28);
    const s = 26 + Math.random() * 16;
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, s);
    grd.addColorStop(0, 'rgba(255,245,200,0.95)');
    grd.addColorStop(0.5, 'rgba(255,180,90,0.7)');
    grd.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = i / 8 * 6.28, r = i % 2 ? s : s * 0.4; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.fill();
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
  if (me.dead || nowMs - me.fireT < wp.rateMs || nowMs < me.reloadUntil) return;
  if (me.clip <= 0) { startReload(); return; }
  me.clip--; me.fireT = nowMs;
  vm.flash = 1; vm.kick = 1; cam.kickY += 4;
  playSfx('shoot');
  Net.shoot(me.ang, me.weapon);
  window.PlaytestLink && PlaytestLink.event('shot', { clip: me.clip, weapon: me.weapon });
}
function startReload() {
  const wp = WEAPONS[me.weapon], nowMs = performance.now();
  if (me.dead || nowMs < me.reloadUntil || me.clip >= wp.clip) return;
  me.reloadUntil = nowMs + wp.reloadMs; me.wasReloading = true;
  playSfx('reload');
  Net.reload(me.weapon);
  window.PlaytestLink && PlaytestLink.event('reload', {});
}

// ---------------------------------------------------------------- audio
// Playback only — BMO's ElevenLabs `gen-sfx.mjs` (sprite-forge) generates the
// actual sounds and drops mp3s into client/assets/sfx/. This layer just plays
// them by name and no-ops gracefully until the files exist. Event -> filename:
//   shoot.mp3  reload.mp3  hurt.mp3  death.mp3  spawn.mp3
const SFX_DIR = 'assets/sfx/';
const sfxTemplates = {};
let audioUnlocked = false; // set on the human's first gesture; bots stay silent
function playSfx(name) {
  if (!audioUnlocked) return;
  try {
    let base = sfxTemplates[name];
    if (!base) { base = sfxTemplates[name] = new Audio(SFX_DIR + name + '.mp3'); base.volume = 0.5; }
    const node = base.cloneNode();     // clone so overlapping shots don't cut each other
    node.volume = base.volume;
    node.play().catch(() => {});       // missing file / not-yet-generated -> silent
  } catch {}
}

// ---------------------------------------------------------------- net effects
Net.onWelcome = (m) => {
  me.id = m.id; me.x = m.spawn.x; me.y = m.spawn.y; me.ang = m.spawn.ang;
  document.getElementById('arena').textContent = 'STARFRAG · ' + m.mapName;
};
Net.on(S2C.SHOT, (m) => { if (m.id !== me.id) flashUntil.set(m.id, performance.now() + 90); });
Net.on(S2C.HIT, (m) => {
  if (m.id === me.id) { cam.dmgFlash = 1; cam.kickY += 6; playSfx('hurt'); window.PlaytestLink && PlaytestLink.event('player_hit', { dmg: m.dmg, hp: m.hp }); }
});
Net.on(S2C.KILL, (m) => {
  const nm = m.names || {};
  killfeed.push({ text: `${nm.by || m.by} ⟶ ${nm.id || m.id}`, until: performance.now() + 6000 });
  if (killfeed.length > 5) killfeed.shift();
  if (m.by === me.id) window.PlaytestLink && PlaytestLink.event('kill', { victim: m.id });
  if (m.id === me.id) { playSfx('death'); window.PlaytestLink && PlaytestLink.event('death', { by: m.by }); }
});
Net.on(S2C.SPAWN, (m) => {
  if (m.id === me.id) { me.x = m.x; me.y = m.y; me.ang = m.ang; me.dead = false; me.clip = WEAPONS[me.weapon].clip; playSfx('spawn'); }
});

// ---------------------------------------------------------------- input
const keys = {};
let fireHeld = false;
if (!IS_BOT) {
  addEventListener('keydown', (e) => {
    if (window.PlaytestLink && (e.code === 'KeyT' || e.code === 'KeyM')) return; // owned by playtest-link
    keys[e.code] = true;
    if (e.code === 'KeyR') startReload();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  screen.addEventListener('click', () => { if (started && !document.pointerLockElement) screen.requestPointerLock?.(); });
  addEventListener('mousemove', (e) => { if (document.pointerLockElement === screen) me.ang += e.movementX * 0.0032; });
  addEventListener('mousedown', () => { if (document.pointerLockElement === screen) fireHeld = true; });
  addEventListener('mouseup', () => { fireHeld = false; });
  const overlay = document.getElementById('overlay');
  overlay.addEventListener('click', () => {
    started = true;
    overlay.classList.add('hide');
    audioUnlocked = true;   // browsers only allow audio after a user gesture
    screen.requestPointerLock?.();
  });
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
  if (mine) { me.dead = mine.dead; me._hp = mine.hp; me._frags = mine.frags; }

  // reload completion
  if (me.wasReloading && performance.now() >= me.reloadUntil) { me.clip = WEAPONS[me.weapon].clip; me.wasReloading = false; }

  // movement intent
  let f = 0, s = 0;
  if (IS_BOT) { botThink(dt); const mv = me._botMove(); f = mv.f; s = mv.s; if (me.clip <= 0) startReload(); }
  else if (started && !me.dead) {
    if (keys.KeyW || keys.ArrowUp) f += 1;
    if (keys.KeyS || keys.ArrowDown) f -= 1;
    if (keys.KeyA) s -= 1;
    if (keys.KeyD) s += 1;
    if (keys.ArrowLeft) me.ang -= 2.4 * dt;
    if (keys.ArrowRight) me.ang += 2.4 * dt;
    if (fireHeld) fire();
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

  // decay fx
  vm.flash = Math.max(0, vm.flash - dt * 8);
  vm.kick = Math.max(0, vm.kick - dt * 6);
  cam.kickY *= Math.max(0, 1 - dt * 9);
  cam.kickX *= Math.max(0, 1 - dt * 9);
  cam.dmgFlash = Math.max(0, cam.dmgFlash - dt * 1.6);

  // send position to server ~20Hz
  netAcc += dt;
  if (netAcc >= 0.05) { netAcc = 0; if (Net.connected) Net.move(+me.x.toFixed(3), +me.y.toFixed(3), +me.ang.toFixed(3), me.moving > 0.2 ? 1 : 0); }

  // draw
  render(t);
  sctx.fillStyle = '#05060a'; sctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  sctx.drawImage(off, cam.kickX * 0.3, cam.kickY * 0.3);
  if (!me.dead) drawGun(sctx, t);
  updateHUD();
}

// ---------------------------------------------------------------- HUD
const $ = (id) => document.getElementById(id);
function updateHUD() {
  const hp = me._hp ?? 100;
  $('hp').textContent = Math.max(0, hp | 0);
  const bar = $('hpbar').firstElementChild;
  bar.style.width = Math.max(0, hp) + '%';
  bar.style.background = hp > 55 ? '#ffb03a' : hp > 25 ? '#ff7a1a' : '#ff3c4a';
  $('ammo').textContent = me.dead ? '—' : me.clip;
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
}

// ---------------------------------------------------------------- boot
Net.connect(MY_NAME);

// __game hook (playtest-link AGENT-INSTRUCTIONS bar 7) + QA teleport
window.__game = {
  get phase() { return me.dead ? 'dead' : 'playing'; },
  get hp() { return me._hp ?? 100; },
  get frags() { return me._frags ?? 0; },
  get x() { return me.x; },
  get y() { return me.y; },
  get yaw() { return me.ang; },
  get zone() { return world.name; },
  get players() { return Net.players.size; },
  get id() { return me.id; },
  get connected() { return Net.connected; },
  snapshot() { return [...Net.players.values()]; }, // authoritative view of all players
  teleport(x, y, ang) { me.x = x; me.y = y; if (ang !== undefined) me.ang = ang; },
  setPos(x, y, ang) { this.teleport(x, y, ang); },
  fire() { me.fireT = -1e9; fire(); },
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

requestAnimationFrame(frame);
