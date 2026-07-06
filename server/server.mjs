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
  WEAPONS, DEFAULT_WEAPON, STARTING_WEAPONS, WEAPON_PICKUP_RESPAWN_MS,
  WEAPON_PICKUP_RADIUS, PLAYER_COLORS, PROTOCOL_VERSION, OBJECTIVE,
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

// Per-player weapon loadout: `weapon` is the CURRENT key, `clips` maps every
// OWNED weapon -> its remaining magazine (its keys are the ownership set). Reset to
// the starting loadout with freshLoadout() on spawn (drop-on-death arena rules).
function freshLoadout() {
  const clips = {};
  for (const k of STARTING_WEAPONS) clips[k] = WEAPONS[k].clip;
  return { weapon: DEFAULT_WEAPON, clips };
}
function makePlayer(ws) {
  const id = nextId++;
  const color = PLAYER_COLORS[colorIx++ % PLAYER_COLORS.length];
  const spawn = pickSpawn();
  const lo = freshLoadout();
  return {
    id, ws, color, name: `player${id}`,
    x: spawn.x, y: spawn.y, ang: spawn.ang,
    hp: PLAYER_HP, frags: 0, dead: false,
    moving: 0,
    weapon: lo.weapon, clips: lo.clips,   // current weapon + per-weapon ammo
    lastShot: 0, reloadUntil: 0, respawnAt: 0, fireT: 1e9, chargeStart: 0,
    joined: false,
  };
}

// Tell one player their authoritative weapon/ammo (after a pickup, switch, reload
// complete, or respawn). The client mirrors this onto its predicted viewmodel.
function sendWeapon(p) {
  send(p, {
    t: S2C.WEAPON, weapon: p.weapon,
    clip: p.clips[p.weapon] ?? 0, owned: Object.keys(p.clips),
  });
}

// Grant a weapon: add it to the loadout (topped-off mag) and, by default, switch to
// it. Guarded so an unknown key (e.g. a railgun pickup before its stats land) no-ops.
function giveWeapon(p, key, { switchTo = true } = {}) {
  const wp = WEAPONS[key];
  if (!wp) return false;
  p.clips[key] = wp.clip;                 // full mag on pickup
  if (switchTo) { p.weapon = key; p.reloadUntil = 0; p.chargeStart = 0; }   // switching cancels a reload + any charge
  return true;
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
  const lo = freshLoadout(); p.weapon = lo.weapon; p.clips = lo.clips;   // drop picked-up weapons
  p.reloadUntil = 0; p.respawnAt = 0; p.chargeStart = 0;
  broadcast({ t: S2C.SPAWN, id: p.id, x: p.x, y: p.y, ang: p.ang });
  sendWeapon(p);   // reset the client viewmodel to the carbine
}

// --- AIRLOCK OBJECTIVE: server-authoritative capture-point win mode ---------
// Dormant unless the compiled deck defines an airlock + consoles (hangar-bay).
// Loop: a live player standing on a console channels it to their name; hold all
// consoles at once -> the bay door opens -> the deck vents -> everyone but the
// majority console-holder is sucked out and the holder wins the round.
//
// Authority split: the server NEVER moves a player (movement is client-auth), so
// the vent KILL is decided here (truth) while the suck-toward-the-door PULL is
// purely the client's visual (spectacle). See shared/protocol.js OBJECTIVE.
const OBJ = map.airlock ? {
  phase: 'idle',              // idle -> arming -> opening -> venting -> (reset to idle)
  phaseUntil: 0,             // Date.now() the current timed phase ends (opening/venting)
  winner: null,              // { id, name, color } once a vent resolves
  lastArmer: null,           // player id who completed the most recent console (tie-break)
  consoles: map.consoles.map((c) => ({
    id: c.id, x: c.x, y: c.y, owner: null, color: null, progress: 0, armed: false,
  })),
} : null;

function objDist2(p, c) { const dx = p.x - c.x, dy = p.y - c.y; return dx * dx + dy * dy; }

// --- WEAPON PICKUPS: server-authoritative grab + respawn --------------------
// One state record per `{ kind:'weapon' }` entity in the compiled deck. A live
// player who walks within WEAPON_PICKUP_RADIUS grabs it (giveWeapon + switch),
// the pad goes dark for WEAPON_PICKUP_RESPAWN_MS, then respawns. Availability is
// pushed to clients as edge events (S2C.PICKUP) + seeded in the welcome snapshot.
const weaponPickups = map.pickups
  .filter((pk) => pk.kind === 'weapon' && WEAPONS[pk.weapon])
  .map((pk) => ({ id: pk.id, x: pk.x, y: pk.y, weapon: pk.weapon, taken: false, respawnAt: 0 }));
const WPICK_R2 = WEAPON_PICKUP_RADIUS * WEAPON_PICKUP_RADIUS;

function pickupsView() {
  return weaponPickups.map((pk) => ({ id: pk.id, weapon: pk.weapon, taken: pk.taken }));
}

function updatePickups(now) {
  for (const pk of weaponPickups) {
    if (pk.taken) {
      if (now >= pk.respawnAt) { pk.taken = false; broadcast({ t: S2C.PICKUP, id: pk.id, taken: false }); }
      continue;
    }
    for (const p of players.values()) {
      if (!p.joined || p.dead) continue;
      const dx = p.x - pk.x, dy = p.y - pk.y;
      if (dx * dx + dy * dy > WPICK_R2) continue;
      if (p.weapon === pk.weapon && (p.clips[pk.weapon] || 0) >= WEAPONS[pk.weapon].clip) continue; // already holding it full
      giveWeapon(p, pk.weapon, { switchTo: true });
      sendWeapon(p);
      pk.taken = true; pk.respawnAt = now + WEAPON_PICKUP_RESPAWN_MS;
      broadcast({ t: S2C.PICKUP, id: pk.id, taken: true });
      break;   // one grab per pad per tick
    }
  }
}

// Public objective snapshot for the wire — the client renders exactly this.
function objectiveView(now) {
  return {
    mode: OBJECTIVE.MODE,
    phase: OBJ.phase,
    total: OBJ.consoles.length,
    armedCount: OBJ.consoles.filter((c) => c.armed).length,
    consoles: OBJ.consoles.map((c) => ({
      id: c.id, x: c.x, y: c.y, owner: c.owner, color: c.color,
      progress: +c.progress.toFixed(3), armed: c.armed,
    })),
    airlock: map.airlock,
    timer: OBJ.phaseUntil ? Math.max(0, OBJ.phaseUntil - now) : null,
    winner: OBJ.winner,
  };
}

function resetObjective() {
  OBJ.phase = 'idle'; OBJ.phaseUntil = 0; OBJ.winner = null; OBJ.lastArmer = null;
  for (const c of OBJ.consoles) { c.owner = null; c.color = null; c.progress = 0; c.armed = false; }
}

// The vent. Winner = whoever holds the most consoles (tie -> who armed the last
// one). Every other live player is sucked out the airlock (a server-side kill).
function ventTheDeck(now) {
  const tally = new Map();
  for (const c of OBJ.consoles) if (c.owner != null) tally.set(c.owner, (tally.get(c.owner) || 0) + 1);
  let winnerId = null, best = -1;
  for (const [id, n] of tally) {
    if (n > best || (n === best && id === OBJ.lastArmer)) { best = n; winnerId = id; }
  }
  const w = winnerId != null ? players.get(winnerId) : null;
  OBJ.winner = w ? { id: w.id, name: w.name, color: w.color } : null;
  if (w) w.frags += 1;                         // a round win counts as a frag

  for (const p of players.values()) {
    if (!p.joined || p.dead) continue;
    if (w && p.id === w.id) continue;          // the holder rides it out
    p.dead = true; p.hp = 0; p.respawnAt = now + RESPAWN_MS;
    broadcast({
      t: S2C.KILL, id: p.id, by: w ? w.id : p.id, weapon: 'airlock',
      names: { id: p.name, by: w ? w.name : 'THE VOID' },
    });
  }
}

function updateObjective(now) {
  if (!OBJ) return;
  if (OBJ.phase === 'idle' || OBJ.phase === 'arming') {
    const rate = (1000 / TICK_HZ) / OBJECTIVE.ARM_MS;
    const R2 = OBJECTIVE.ARM_RADIUS * OBJECTIVE.ARM_RADIUS;
    for (const c of OBJ.consoles) {
      let near = null, nCount = 0;
      for (const p of players.values()) {
        if (p.joined && !p.dead && objDist2(p, c) <= R2) { near = p; nCount++; }
      }
      if (nCount === 1) {
        if (c.owner === near.id) { c.progress = 1; c.armed = true; }      // owner holds/tops off
        else if (c.owner != null) {                                       // enemy neutralizes first
          c.progress -= rate;
          if (c.progress <= 0) { c.progress = 0; c.owner = null; c.color = null; c.armed = false; }
        } else {                                                          // unowned -> capture
          c.progress += rate;
          if (c.progress >= 1) {
            c.progress = 1; c.owner = near.id; c.color = near.color; c.armed = true; OBJ.lastArmer = near.id;
          }
        }
      }
      // nCount === 0 -> hold (armed stays armed, partials sit); >= 2 -> contested freeze
    }
    const armed = OBJ.consoles.filter((c) => c.armed).length;
    OBJ.phase = armed > 0 ? 'arming' : 'idle';
    if (OBJ.consoles.length > 0 && armed === OBJ.consoles.length) {
      OBJ.phase = 'opening'; OBJ.phaseUntil = now + OBJECTIVE.DOOR_OPEN_MS;   // lock in; door cranks open
    }
  } else if (OBJ.phase === 'opening') {
    if (now >= OBJ.phaseUntil) { OBJ.phase = 'venting'; OBJ.phaseUntil = now + OBJECTIVE.VENT_MS; ventTheDeck(now); }
  } else if (OBJ.phase === 'venting') {
    if (now >= OBJ.phaseUntil) resetObjective();
  }
}

// Authoritative hitscan: fire one ray per pellet from the shooter, stop at the
// first wall, and hit the nearest player body the ray passes within HIT_RADIUS.
// The weapon is the shooter's AUTHORITATIVE current weapon (the client can't spoof
// which gun it's holding — only the server decides that from pickups/switches).
// Apply one hit (damage + death/frag broadcast). Shared by the nearest-body path and
// the railgun's pierce path (which calls it once per body along the ray).
function applyHit(shooter, target, dmg, weaponKey, now) {
  target.hp = Math.max(0, target.hp - dmg);
  broadcast({ t: S2C.HIT, id: target.id, by: shooter.id, dmg, hp: target.hp });
  if (target.hp <= 0 && !target.dead) {
    target.dead = true;
    target.respawnAt = now + RESPAWN_MS;
    shooter.frags++;
    broadcast({
      t: S2C.KILL, id: target.id, by: shooter.id, weapon: weaponKey,
      names: { id: target.name, by: shooter.name },
    });
  }
}

// `chargeFrac` (0..1) is authoritative for charge weapons — the caller derives it from the
// SERVER-timed hold (C2S.CHARGE→SHOOT), never from a client-sent value. Non-charge weapons
// ignore it and roll dmgLo..dmgHi as before. Pierce weapons ignore wall occlusion and hit
// EVERY body along `range`, not just the nearest.
function resolveShot(shooter, ang, chargeFrac = 0) {
  const weaponKey = shooter.weapon;
  const wp = WEAPONS[weaponKey] || WEAPONS[DEFAULT_WEAPON];
  const now = Date.now();

  // fire-rate + ammo gates (authoritative)
  if (now - shooter.lastShot < wp.rateMs) return;
  if (now < shooter.reloadUntil) return;
  if ((shooter.clips[weaponKey] || 0) <= 0) return;
  shooter.lastShot = now;
  shooter.clips[weaponKey]--;
  shooter.fireT = now;

  // damage source: charge weapons scale lo→hi by the server-timed charge; others roll lo..hi
  const cf = wp.charge ? Math.max(0, Math.min(1, chargeFrac)) : 0;
  const dmgFor = wp.charge
    ? () => Math.round(wp.dmgLo + (wp.dmgHi - wp.dmgLo) * cf)
    : () => Math.round(wp.dmgLo + Math.random() * (wp.dmgHi - wp.dmgLo));

  // tell everyone the shooter fired (muzzle flash on their billboard; charge → beam intensity)
  broadcast({ t: S2C.SHOT, id: shooter.id, ang, weapon: weaponKey, ...(wp.charge ? { charge: cf } : {}) });

  for (let pel = 0; pel < wp.pellets; pel++) {
    const a = ang + (wp.spread ? (Math.random() - 0.5) * 2 * wp.spread : 0);
    const dx = Math.cos(a), dy = Math.sin(a);
    const wall = raycast(map.grid, map.W, map.H, shooter.x, shooter.y, dx, dy, wp.range);
    const maxAlong = wp.pierce ? wp.range : wall.dist;   // pierce ignores wall occlusion

    if (wp.pierce) {
      // hit EVERY body within HIT_RADIUS along [0, range] — through walls and through bodies
      for (const t of players.values()) {
        if (t.id === shooter.id || t.dead) continue;
        const tx = t.x - shooter.x, ty = t.y - shooter.y;
        const along = tx * dx + ty * dy;
        if (along <= 0 || along > maxAlong) continue;
        if (Math.abs(tx * dy - ty * dx) > HIT_RADIUS) continue;
        applyHit(shooter, t, dmgFor(), weaponKey, now);
      }
    } else {
      // nearest body along the ray, in front of the wall (standard hitscan)
      let best = null, bestAlong = Infinity;
      for (const t of players.values()) {
        if (t.id === shooter.id || t.dead) continue;
        const tx = t.x - shooter.x, ty = t.y - shooter.y;
        const along = tx * dx + ty * dy;              // projection down the ray
        if (along <= 0 || along > maxAlong) continue; // behind shooter / behind wall
        if (Math.abs(tx * dy - ty * dx) > HIT_RADIUS) continue; // perpendicular distance to ray
        if (along < bestAlong) { bestAlong = along; best = t; }
      }
      if (best) applyHit(shooter, best, dmgFor(), weaponKey, now);
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
          objective: OBJ ? objectiveView(Date.now()) : null,
          pickups: pickupsView(),
        });
        broadcast({ t: S2C.SPAWN, id: p.id, x: p.x, y: p.y, ang: p.ang });
        sendWeapon(p);   // seed the client's authoritative loadout
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
      case C2S.SHOOT: {
        // the server hitscans with p's AUTHORITATIVE weapon (client can't spoof it).
        // Charge weapons: the server TIMES the hold (C2S.CHARGE → now) — the client's
        // claimed charge is never trusted; released below charge.minMs = a fizzle.
        if (p.dead || !Number.isFinite(m.ang)) break;
        const wp = WEAPONS[p.weapon] || WEAPONS[DEFAULT_WEAPON];
        if (wp.charge) {
          const held = p.chargeStart ? (Date.now() - p.chargeStart) : 0;
          p.chargeStart = 0;
          if (held >= wp.charge.minMs) {                      // past the gate → a real shot (else a fizzle: no shot, no ammo)
            const cf = Math.max(0, Math.min(1, (held - wp.charge.minMs) / (wp.charge.fullMs - wp.charge.minMs)));
            resolveShot(p, m.ang, cf);
          }
          // resync the authoritative clip: the server times the charge on its own clock, so
          // the client's fizzle-vs-shot prediction can differ by a round at the minMs boundary
          // under ping jitter. One WEAPON message per trigger corrects it (charge weapons are slow).
          sendWeapon(p);
        } else {
          resolveShot(p, m.ang);
        }
        break;
      }
      case C2S.CHARGE:
        // fire pressed on a charge weapon → start the server's charge clock (idempotent while held)
        if (!p.dead) { const w = WEAPONS[p.weapon]; if (w && w.charge && !p.chargeStart) p.chargeStart = Date.now(); }
        break;
      case C2S.RELOAD: {
        const key = p.weapon;
        const wp = WEAPONS[key];
        p.chargeStart = 0;                                    // reloading cancels a charge
        if (!p.dead && Date.now() >= p.reloadUntil && (p.clips[key] || 0) < wp.clip) {
          p.reloadUntil = Date.now() + wp.reloadMs;
          setTimeout(() => {
            // only complete if still alive AND still holding the same weapon
            if (players.has(p.id) && !p.dead && p.weapon === key) { p.clips[key] = wp.clip; sendWeapon(p); }
          }, wp.reloadMs);
        }
        break;
      }
      case C2S.SWITCH: {
        // switch to an OWNED weapon (ownership = a key in p.clips). Cancels a reload.
        const key = m.weapon;
        if (!p.dead && WEAPONS[key] && (key in p.clips) && key !== p.weapon) {
          p.weapon = key; p.reloadUntil = 0; p.chargeStart = 0;   // switching cancels a charge
          sendWeapon(p);
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
  updateObjective(now);
  updatePickups(now);
  broadcast({ t: S2C.STATE, players: [...players.values()].filter((p) => p.joined).map(stateOf) });
  if (OBJ) broadcast({ t: S2C.OBJECTIVE, ...objectiveView(now) });
}, 1000 / TICK_HZ);
