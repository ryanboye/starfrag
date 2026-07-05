// STARFRAG — authoritative arena server.
//
// Responsibilities (kept intentionally small for a scaffold):
//   - accept WebSocket clients, assign each an id + color + spawn point
//   - receive client input (position + shoot + reload)
//   - run authoritative HITSCAN: a shot is resolved server-side against the
//     shared compiled map (wall occlusion) and every other player's body
//   - apply damage / death / frag-count / respawn
//   - broadcast the full player list at TICK_HZ and push killfeed events
//
// NOT done here (deliberate future hardening — see CONTRIBUTING.md):
//   - authoritative MOVEMENT (right now we trust the client's reported position)
//   - anti-cheat / input validation / lag compensation / interpolation
//   - multiple rooms (one shared arena for the scaffold)
//
// Config from env only (NO secrets in the repo):
//   STARFRAG_PORT  (default 8791)   STARFRAG_HOST (default 127.0.0.1)
//   STARFRAG_MAP   (default deck7-derelict; e.g. 'hangar-bay')

import { WebSocketServer } from 'ws';
import {
  C2S, S2C, TICK_HZ, RESPAWN_MS, PLAYER_HP, HIT_RADIUS,
  WEAPONS, DEFAULT_WEAPON, PLAYER_COLORS, PROTOCOL_VERSION,
} from '../shared/protocol.js';
import { compileMap, raycast, pickArena } from '../shared/map.js';

const PORT = +(process.env.STARFRAG_PORT || 8791);
const HOST = process.env.STARFRAG_HOST || '127.0.0.1';

// Which deck to run. STARFRAG_MAP selects a registered arena id (e.g.
// 'hangar-bay'); unset → the default derelict deck. Rotation is a future feature.
const arena = pickArena(process.env.STARFRAG_MAP);
const map = compileMap(arena);       // { W, H, grid, spawns, ... }
const players = new Map();           // id -> player record
let nextId = 1;
let colorIx = 0;
let spawnIx = 0;

function pickSpawn() {
  // round-robin through the named spawns, nudged so two joins in a row differ
  const s = map.spawns[spawnIx % map.spawns.length];
  spawnIx++;
  return { x: s.x, y: s.y, ang: s.ang };
}

function makePlayer(ws) {
  const id = nextId++;
  const color = PLAYER_COLORS[colorIx++ % PLAYER_COLORS.length];
  const spawn = pickSpawn();
  return {
    id, ws, color, name: `player${id}`,
    x: spawn.x, y: spawn.y, ang: spawn.ang,
    hp: PLAYER_HP, frags: 0, dead: false,
    moving: 0,
    clip: WEAPONS[DEFAULT_WEAPON].clip,
    lastShot: 0, reloadUntil: 0, respawnAt: 0, fireT: 1e9,
    joined: false,
  };
}

// public view of a player (what everybody else is allowed to see)
function stateOf(p) {
  return {
    id: p.id, name: p.name, color: p.color,
    x: +p.x.toFixed(3), y: +p.y.toFixed(3), ang: +p.ang.toFixed(3),
    hp: p.hp, frags: p.frags, dead: p.dead,
    fireT: p.fireT, reloading: Date.now() < p.reloadUntil,
  };
}

function send(p, msg) {
  if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}

function respawn(p) {
  const spawn = pickSpawn();
  p.x = spawn.x; p.y = spawn.y; p.ang = spawn.ang;
  p.hp = PLAYER_HP; p.dead = false;
  p.clip = WEAPONS[DEFAULT_WEAPON].clip;
  p.reloadUntil = 0; p.respawnAt = 0;
  broadcast({ t: S2C.SPAWN, id: p.id, x: p.x, y: p.y, ang: p.ang });
}

// Authoritative hitscan: fire one ray per pellet from the shooter, stop at the
// first wall, and hit the nearest player body the ray passes within HIT_RADIUS.
function resolveShot(shooter, ang, weaponKey) {
  const wp = WEAPONS[weaponKey] || WEAPONS[DEFAULT_WEAPON];
  const now = Date.now();

  // fire-rate + ammo gates (authoritative)
  if (now - shooter.lastShot < wp.rateMs) return;
  if (now < shooter.reloadUntil) return;
  if (shooter.clip <= 0) return;
  shooter.lastShot = now;
  shooter.clip--;
  shooter.fireT = now;

  // tell everyone the shooter fired (muzzle flash on their billboard)
  broadcast({ t: S2C.SHOT, id: shooter.id, ang, weapon: weaponKey });

  for (let pel = 0; pel < wp.pellets; pel++) {
    const a = ang + (wp.spread ? (Math.random() - 0.5) * 2 * wp.spread : 0);
    const dx = Math.cos(a), dy = Math.sin(a);
    const wall = raycast(map.grid, map.W, map.H, shooter.x, shooter.y, dx, dy, wp.range);

    // nearest body along the ray, in front of the wall
    let best = null, bestAlong = Infinity;
    for (const t of players.values()) {
      if (t.id === shooter.id || t.dead) continue;
      const tx = t.x - shooter.x, ty = t.y - shooter.y;
      const along = tx * dx + ty * dy;              // projection down the ray
      if (along <= 0 || along > wall.dist) continue; // behind shooter / behind wall
      const perp = Math.abs(tx * dy - ty * dx);      // perpendicular distance to ray
      if (perp > HIT_RADIUS) continue;
      if (along < bestAlong) { bestAlong = along; best = t; }
    }
    if (!best) continue;

    const dmg = Math.round(wp.dmgLo + Math.random() * (wp.dmgHi - wp.dmgLo));
    best.hp = Math.max(0, best.hp - dmg);
    broadcast({ t: S2C.HIT, id: best.id, by: shooter.id, dmg, hp: best.hp });

    if (best.hp <= 0 && !best.dead) {
      best.dead = true;
      best.respawnAt = now + RESPAWN_MS;
      shooter.frags++;
      broadcast({
        t: S2C.KILL, id: best.id, by: shooter.id, weapon: weaponKey,
        names: { id: best.name, by: shooter.name },
      });
    }
  }
}

const wss = new WebSocketServer({ host: HOST, port: PORT });
console.log(`[starfrag] authoritative arena "${map.name}" on ws://${HOST}:${PORT} (protocol v${PROTOCOL_VERSION})`);

wss.on('connection', (ws) => {
  const p = makePlayer(ws);
  players.set(p.id, p);

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    switch (m.t) {
      case C2S.JOIN: {
        if (typeof m.name === 'string' && m.name.trim()) p.name = m.name.slice(0, 16);
        p.joined = true;
        send(p, {
          t: S2C.WELCOME,
          id: p.id,
          spawn: { x: p.x, y: p.y, ang: p.ang },
          mapName: map.name,
          mapId: map.id,
          players: [...players.values()].map(stateOf),
        });
        broadcast({ t: S2C.SPAWN, id: p.id, x: p.x, y: p.y, ang: p.ang });
        break;
      }
      case C2S.MOVE: {
        // scaffold: trust the client's position. Clamp to the map bounds so a
        // bad actor can't teleport off-grid, but real validation is future work.
        if (p.dead) break;
        if (Number.isFinite(m.x)) p.x = Math.max(0.2, Math.min(map.W - 0.2, m.x));
        if (Number.isFinite(m.y)) p.y = Math.max(0.2, Math.min(map.H - 0.2, m.y));
        if (Number.isFinite(m.ang)) p.ang = m.ang;
        p.moving = m.moving ? 1 : 0;
        break;
      }
      case C2S.SHOOT:
        if (!p.dead && Number.isFinite(m.ang)) resolveShot(p, m.ang, m.weapon || DEFAULT_WEAPON);
        break;
      case C2S.RELOAD: {
        const wp = WEAPONS[m.weapon || DEFAULT_WEAPON] || WEAPONS[DEFAULT_WEAPON];
        if (!p.dead && Date.now() >= p.reloadUntil && p.clip < wp.clip) {
          p.reloadUntil = Date.now() + wp.reloadMs;
          setTimeout(() => { if (players.has(p.id) && !p.dead) p.clip = wp.clip; }, wp.reloadMs);
        }
        break;
      }
      case C2S.PING:
        send(p, { t: S2C.PONG, ts: m.ts });
        break;
    }
  });

  ws.on('close', () => {
    players.delete(p.id);
    broadcast({ t: S2C.LEAVE, id: p.id });
  });
  ws.on('error', () => {});
});

// --- authoritative tick: respawns + state broadcast at TICK_HZ -------------
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    if (p.dead && p.respawnAt && now >= p.respawnAt) respawn(p);
  }
  broadcast({ t: S2C.STATE, players: [...players.values()].filter((p) => p.joined).map(stateOf) });
}, 1000 / TICK_HZ);
