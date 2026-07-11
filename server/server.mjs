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
  WEAPON_PICKUP_RADIUS, PLAYER_COLORS, PROTOCOL_VERSION, OBJECTIVE, POWERUP,
} from '../shared/protocol.js';
import { compileMap, raycast, pickArena, isSolidCell } from '../shared/map.js';
import { createBot } from '../client/js/bot.js';   // the ?bot=1 brain, reused verbatim server-side

const PORT = +(process.env.STARFRAG_PORT || 8791);
const HOST = process.env.STARFRAG_HOST || '127.0.0.1';

// Which deck to run. STARFRAG_MAP selects a registered arena id (e.g.
// 'hangar-bay'); unset → the default derelict deck. Rotation is a future feature.
const arena = pickArena(process.env.STARFRAG_MAP);
const map = compileMap(arena);       // { W, H, grid, spawns, ... }
// The objective STATE MACHINE is generic; a deck may override its DURATIONS (and
// theme) via `arena.objective` (see deck7v2 — a long DOOR_OPEN_MS = the telegraphed
// OVERLOAD countdown). Defaults to the shared OBJECTIVE, so hangar-bay is unchanged.
const OBJT = { ...OBJECTIVE, ...((arena.objective && arena.objective.timing) || {}) };
const OBJ_MODE = (arena.objective && arena.objective.mode) || OBJECTIVE.MODE;
const players = new Map();           // id -> player record (humans AND bots)
let nextId = 1;
let colorIx = 0;
let spawnIx = 0;

// --- SERVER-SIDE BOTS: on-demand, in-process AI opponents (no browser) --------
// A bot is an internal player entity that lives in `players` (so every human sees it
// via the normal STATE broadcast, identical to a real player) AND in `bots` (for the
// AI tick). It reuses the exact client ?bot=1 brain (client/js/bot.js createBot) via a
// server-side `api` shim, and is driven by the SERVER's own movement + fire resolution
// — so bots are naturally server-authoritative and keep bot.js's human-fair (no-aimbot)
// aim handicaps. Lifecycle: spawned when a human is present, ALL despawned when the last
// one leaves, so an idle server runs zero bot AI. STARFRAG_BOTS (default 3) = the count a
// lone human faces; set 0 to disable (e.g. isolation QA harnesses).
const TARGET_BOTS = Math.max(0, +(process.env.STARFRAG_BOTS ?? 3) || 0);
const BOT_WS = { readyState: 3 };    // stub socket: send()/broadcast() only touch OPEN(1) sockets, so bots are skipped
const BOT_NAMES = ['VEX', 'HELIX', 'NOVA', 'RAZR', 'ONYX', 'ZEPH', 'KILO', 'JINX', 'WISP', 'ORBIT', 'FANG', 'ECHO'];
const bots = new Map();              // id -> bot record (a subset of `players`)
let botNameIx = 0;
let botLast = 0;                     // timestamp of the last bot tick (for dt)
let simLast = 0;                     // timestamp of the last authoritative tick (overheal-decay dt)

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
    hp: PLAYER_HP, armor: 0, quadUntil: 0, frags: 0, dead: false,   // armor plates + quad expiry (Date.now)
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

// public view of a player (what everybody else is allowed to see). hp/armor are the
// authoritative combat totals; `quad` (ms left) lets every client tint the carrier's
// billboard and the holder render their own countdown — no separate powerup snapshot.
function stateOf(p) {
  const now = Date.now();
  return {
    id: p.id, name: p.name, color: p.color,
    x: +p.x.toFixed(3), y: +p.y.toFixed(3), ang: +p.ang.toFixed(3),
    hp: Math.round(p.hp), armor: Math.round(p.armor), frags: p.frags, dead: p.dead,
    fireT: p.fireT, reloading: now < p.reloadUntil,
    quad: p.quadUntil > now ? p.quadUntil - now : 0,
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
  p.hp = PLAYER_HP; p.armor = 0; p.quadUntil = 0; p.dead = false;   // fresh: no plates, no quad, no overheal
  const lo = freshLoadout(); p.weapon = lo.weapon; p.clips = lo.clips;   // drop picked-up weapons
  p.reloadUntil = 0; p.respawnAt = 0; p.chargeStart = 0;
  broadcast({ t: S2C.SPAWN, id: p.id, x: p.x, y: p.y, ang: p.ang });
  sendWeapon(p);   // reset the client viewmodel to the carbine
}

// Start a reload of p's CURRENT weapon. Shared by the C2S.RELOAD handler and by bots
// (api.reload). Guards: alive, not mid-reload, mag not already full. Completes on a timer
// only if p still exists, is alive, and still holds the same weapon. Reloading cancels a charge.
function beginReload(p) {
  const key = p.weapon;
  const wp = WEAPONS[key];
  p.chargeStart = 0;
  if (!p.dead && Date.now() >= p.reloadUntil && (p.clips[key] || 0) < wp.clip) {
    p.reloadUntil = Date.now() + wp.reloadMs;
    setTimeout(() => {
      if (players.has(p.id) && !p.dead && p.weapon === key) { p.clips[key] = wp.clip; sendWeapon(p); }
    }, wp.reloadMs);
  }
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

// --- PICKUPS: server-authoritative grab + respawn ---------------------------
// One state record per pickup entity in the compiled deck. A live player who walks
// within its radius grabs it, the pad goes dark for a respawn window, then reappears.
// Availability is pushed to clients as edge events (S2C.PICKUP) + seeded in welcome;
// the EFFECT (weapon / hp / armor / ammo / quad) is applied here, authoritatively.
//   weapon  -> giveWeapon + switch (as before)
//   health  -> +25 to 100  (or, `mega`, +100 to a 200 overheal that decays back to 100)
//   armor   -> +50 to 100  (soaks a share of incoming damage; see applyHit)
//   ammo    -> tops off the CURRENT weapon's magazine
//   quad    -> the timed damage multiplier (telegraphed; grab gated to the glow window)
//
// TEST KNOBS (env, off in prod — the live units don't set them): shorten the item respawn
// and quad duration, and force the quad always-grabbable, so tools/powerups-test.mjs can
// prove decay/respawn/expiry without waiting out the 25s/22s/30s live clocks.
const ITEM_RESPAWN_MS = +(process.env.STARFRAG_ITEM_RESPAWN_MS || POWERUP.ITEM_RESPAWN_MS);
const QUAD_MS = +(process.env.STARFRAG_QUAD_MS || POWERUP.QUAD_MS);
const QUAD_ALWAYS = !!(+process.env.STARFRAG_QUAD_ALWAYS || 0);

const weaponPickups = map.pickups
  .filter((pk) => pk.kind === 'weapon' && WEAPONS[pk.weapon])
  .map((pk) => ({ id: pk.id, kind: 'weapon', x: pk.x, y: pk.y, weapon: pk.weapon, taken: false, respawnAt: 0 }));
// health/armor/ammo pads (instant effects). `mega` health overheals + decays.
const itemPickups = map.pickups
  .filter((pk) => pk.kind === 'health' || pk.kind === 'armor' || pk.kind === 'ammo')
  .map((pk) => ({ id: pk.id, kind: pk.kind, mega: !!pk.mega, x: pk.x, y: pk.y, taken: false, respawnAt: 0 }));
// THE QUAD — at most one per deck. Grabbable only inside its telegraph glow window (so the
// grab lines up with the "QUAD UP" clock every client already shows), then the pad stays
// dark until the next window. `quadDarkUntil` = when it can reappear (grabbed → next cycle).
const quadPad = (map.pickups.find((pk) => pk.kind === 'quad')) || null;
const quad = quadPad ? { id: quadPad.id, x: quadPad.x, y: quadPad.y, taken: false } : null;
let quadDarkUntil = 0;
const WPICK_R2 = WEAPON_PICKUP_RADIUS * WEAPON_PICKUP_RADIUS;
const IPICK_R2 = POWERUP.PICKUP_RADIUS * POWERUP.PICKUP_RADIUS;

// Is the quad's telegraph window open right now? Wall-clock cycle, identical to the client's
// quadState() — so server truth and client telegraph never disagree (QUAD_ALWAYS in tests).
function quadWindowOpen(now) {
  return QUAD_ALWAYS || (now % POWERUP.QUAD_CYCLE_MS) < POWERUP.QUAD_READY_MS;
}
// Start of the next telegraph cycle — how long the pad stays dark after a grab (live).
function nextCycleStart(now) { return Math.ceil((now + 1) / POWERUP.QUAD_CYCLE_MS) * POWERUP.QUAD_CYCLE_MS; }

function pickupsView() {
  const v = [
    ...weaponPickups.map((pk) => ({ id: pk.id, kind: 'weapon', weapon: pk.weapon, taken: pk.taken })),
    ...itemPickups.map((pk) => ({ id: pk.id, kind: pk.kind, mega: pk.mega, taken: pk.taken })),
  ];
  if (quad) v.push({ id: quad.id, kind: 'quad', taken: quad.taken });
  return v;
}

// Apply an instant item's effect. Returns true if it was actually consumed (a full-HP
// player walking over a health pad leaves it for someone who needs it — classic).
function applyItem(p, pk, now) {
  if (pk.kind === 'health') {
    const max = pk.mega ? POWERUP.MEGA_MAX : POWERUP.HEALTH_MAX;
    const add = pk.mega ? POWERUP.MEGA_ADD : POWERUP.HEALTH_ADD;
    if (p.hp >= max) return false;
    p.hp = Math.min(max, p.hp + add);
    return true;
  }
  if (pk.kind === 'armor') {
    if (p.armor >= POWERUP.ARMOR_MAX) return false;
    p.armor = Math.min(POWERUP.ARMOR_MAX, p.armor + POWERUP.ARMOR_ADD);
    return true;
  }
  if (pk.kind === 'ammo') {
    const wp = WEAPONS[p.weapon] || WEAPONS[DEFAULT_WEAPON];
    if ((p.clips[p.weapon] || 0) >= wp.clip) return false;   // mag already full
    p.clips[p.weapon] = wp.clip;
    p.reloadUntil = 0;                                        // a fresh mag cancels a reload
    sendWeapon(p);
    return true;
  }
  return false;
}

function updatePickups(now) {
  // weapon pads (grab + switch)
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
  // sustain pads (health/armor/ammo) — instant effect, then a timed respawn
  for (const pk of itemPickups) {
    if (pk.taken) {
      if (now >= pk.respawnAt) { pk.taken = false; broadcast({ t: S2C.PICKUP, id: pk.id, taken: false }); }
      continue;
    }
    for (const p of players.values()) {
      if (!p.joined || p.dead) continue;
      const dx = p.x - pk.x, dy = p.y - pk.y;
      if (dx * dx + dy * dy > IPICK_R2) continue;
      if (!applyItem(p, pk, now)) continue;   // no effect (already capped) → leave the pad up
      pk.taken = true; pk.respawnAt = now + ITEM_RESPAWN_MS;
      broadcast({ t: S2C.PICKUP, id: pk.id, taken: true });
      broadcast({ t: S2C.POWERUP, kind: pk.mega ? 'mega' : pk.kind, id: pk.id, by: p.id });
      break;
    }
  }
  // THE QUAD — grabbable only inside its telegraph window; grants the timed multiplier.
  // `quad.taken` means GRABBED (dark until the next telegraph cycle) — NOT merely "window
  // closed": the client already renders the dim build-up telegraph off the shared wall clock,
  // so we only flip `taken` on a real grab, else the pillar would blink every cycle.
  if (quad) {
    if (quad.taken && now >= quadDarkUntil) {         // cooldown over → the pad returns
      quad.taken = false;
      broadcast({ t: S2C.PICKUP, id: quad.id, taken: false });
    }
    if (!quad.taken && quadWindowOpen(now)) {
      for (const p of players.values()) {
        if (!p.joined || p.dead) continue;
        const dx = p.x - quad.x, dy = p.y - quad.y;
        if (dx * dx + dy * dy > IPICK_R2) continue;
        p.quadUntil = now + QUAD_MS;                  // grant / refresh
        quad.taken = true;
        quadDarkUntil = QUAD_ALWAYS ? now + 1500 : nextCycleStart(now);   // dark till the next telegraph window (live)
        broadcast({ t: S2C.PICKUP, id: quad.id, taken: true });
        broadcast({ t: S2C.POWERUP, kind: 'quad', id: quad.id, by: p.id });
        break;
      }
    }
  }
}

// Overheal bleed: any hp above 100 decays back at MEGA_DECAY/s (mega-health only pushes
// hp past 100). Runs on the authoritative tick; `dt` is seconds since the last tick.
function decayOverheal(dt) {
  const drop = POWERUP.MEGA_DECAY * dt;
  for (const p of players.values()) {
    if (p.dead) continue;
    if (p.hp > POWERUP.HEALTH_MAX) p.hp = Math.max(POWERUP.HEALTH_MAX, p.hp - drop);
  }
}

// Public objective snapshot for the wire — the client renders exactly this.
function objectiveView(now) {
  return {
    mode: OBJ_MODE,
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
    const rate = (1000 / TICK_HZ) / OBJT.ARM_MS;
    const R2 = OBJT.ARM_RADIUS * OBJT.ARM_RADIUS;
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
      OBJ.phase = 'opening'; OBJ.phaseUntil = now + OBJT.DOOR_OPEN_MS;   // lock in; door cranks open (v2: overload countdown)
    }
  } else if (OBJ.phase === 'opening') {
    if (now >= OBJ.phaseUntil) { OBJ.phase = 'venting'; OBJ.phaseUntil = now + OBJT.VENT_MS; ventTheDeck(now); }
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
  // QUAD — the SHOOTER's timed damage multiplier (server-timed; a client can't fake it).
  if (shooter.quadUntil > now) dmg = Math.round(dmg * POWERUP.QUAD_MULT);
  // ARMOR — the TARGET's plates soak a fraction of the blow before it reaches HP; when the
  // plates run out the overflow carries through. `dmg` reported to clients is the total dealt.
  if (target.armor > 0 && dmg > 0) {
    const absorbed = Math.min(target.armor, Math.round(dmg * POWERUP.ARMOR_ABSORB));
    target.armor -= absorbed;
    target.hp = Math.max(0, target.hp - (dmg - absorbed));
  } else {
    target.hp = Math.max(0, target.hp - dmg);
  }
  broadcast({ t: S2C.HIT, id: target.id, by: shooter.id, dmg, hp: Math.round(target.hp), armor: Math.round(target.armor) });
  if (target.hp <= 0 && !target.dead) {
    target.dead = true;
    target.armor = 0; target.quadUntil = 0;   // death ends the quad (drops nothing) + strips plates
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

// --- bot AI plumbing --------------------------------------------------------
// The `api` shim createBot(api) expects. It reads state (world/players/me) and emits
// intent (setMove/fire/reload); it never touches pixels, so it runs fine here. `me` is
// the bot's own record — bot.js reads me.id/x/y/ang/dead/clip and WRITES me.ang (its aim),
// which lands straight on the broadcast field, so every human sees the bot turn.
function botApi(bot) {
  return {
    me: bot,
    players: () => [...players.values()].filter((p) => p.joined),   // bots fight humans AND each other
    world: map, spawns: map.spawns,
    fire: () => botFire(bot),
    reload: () => beginReload(bot),
    setMove: (f, s) => { bot._botF = f; bot._botS = s; },
  };
}

// A bot record has the SAME shape makePlayer builds (so stateOf/resolveShot/respawn treat
// it identically), plus isBot, a compiled think(dt), and a live scalar `clip` view that
// bot.js reads (the human client carries `me.clip`; the server carries per-weapon `clips`).
function makeBot() {
  const id = nextId++;
  const color = PLAYER_COLORS[colorIx++ % PLAYER_COLORS.length];
  const spawn = pickSpawn();
  const lo = freshLoadout();
  const bot = {
    id, ws: BOT_WS, color, name: BOT_NAMES[botNameIx++ % BOT_NAMES.length],
    x: spawn.x, y: spawn.y, ang: spawn.ang,
    hp: PLAYER_HP, armor: 0, quadUntil: 0, frags: 0, dead: false, moving: 0,   // bots grab items too (visible to humans via STATE)
    weapon: lo.weapon, clips: lo.clips,
    lastShot: 0, reloadUntil: 0, respawnAt: 0, fireT: 1e9, chargeStart: 0,
    joined: true, isBot: true, _botF: 0, _botS: 0,
  };
  Object.defineProperty(bot, 'clip', { get() { return this.clips[this.weapon] ?? 0; }, configurable: true });
  bot.think = createBot(botApi(bot));
  return bot;
}

// Bots fire through the SERVER's own resolveShot (authoritative — same ammo/rate gates as a
// human). Charge weapons (a railgun pickup) start the server charge clock here; updateBots
// releases at full charge. The no-aimbot handicaps live in bot.js and are untouched.
function botFire(bot) {
  if (bot.dead) return;
  const wp = WEAPONS[bot.weapon] || WEAPONS[DEFAULT_WEAPON];
  if (wp.charge) { if (!bot.chargeStart) bot.chargeStart = Date.now(); return; }
  resolveShot(bot, bot.ang);
}

// Server-side movement — a faithful port of the client's moveMe(): humans are movement-
// authoritative, so for a bot the server IS the client. Same SPEED, same 0.22 body radius,
// same axis-separated wall slide, same bounds clamp as the C2S.MOVE path.
function botBlocked(x, y, r) {
  for (let ty = (y - r) | 0; ty <= (y + r) | 0; ty++)
    for (let tx = (x - r) | 0; tx <= (x + r) | 0; tx++)
      if (isSolidCell(map.grid, map.W, map.H, tx, ty)) return true;
  return false;
}
function moveBot(bot, f, s, dt) {
  let len = Math.hypot(f, s);
  if (len < 1e-3) { bot.moving = 0; return; }
  if (len > 1) { f /= len; s /= len; }
  const SPEED = 3.4, r = 0.22;
  const dirX = Math.cos(bot.ang), dirY = Math.sin(bot.ang);
  const dx = (dirX * f - dirY * s) * SPEED * dt, dy = (dirY * f + dirX * s) * SPEED * dt;
  if (!botBlocked(bot.x + dx, bot.y, r)) bot.x += dx;
  if (!botBlocked(bot.x, bot.y + dy, r)) bot.y += dy;
  bot.x = Math.max(0.2, Math.min(map.W - 0.2, bot.x));
  bot.y = Math.max(0.2, Math.min(map.H - 0.2, bot.y));
  bot.moving = 1;
}

// --- bot lifecycle ----------------------------------------------------------
const humanCount = () => { let n = 0; for (const p of players.values()) if (!p.isBot && p.joined) n++; return n; };

function spawnBot() {
  const bot = makeBot();
  players.set(bot.id, bot);
  bots.set(bot.id, bot);
  broadcast({ t: S2C.SPAWN, id: bot.id, x: bot.x, y: bot.y, ang: bot.ang });   // humans get name/color on the next STATE
}
function despawnBot(bot) {
  bots.delete(bot.id);
  players.delete(bot.id);
  broadcast({ t: S2C.LEAVE, id: bot.id });
}

// Desired bot count: 0 when no humans are present (idle → zero AI), else top up so a lone
// human faces TARGET_BOTS and each extra human replaces one bot (headcount ≈ TARGET_BOTS+1).
function desiredBots() {
  const humans = humanCount();
  return humans <= 0 ? 0 : Math.max(0, TARGET_BOTS - (humans - 1));
}
function reconcileBots() {
  const want = TARGET_BOTS <= 0 ? 0 : desiredBots();
  const before = bots.size;
  while (bots.size < want) spawnBot();
  while (bots.size > want) despawnBot([...bots.values()][bots.size - 1]);
  if (bots.size !== before) console.log(`[starfrag] bots -> ${bots.size} (humans ${humanCount()})`);
}

// Per-tick bot AI. No-op (one Map size check) when no bots are live — the idle case.
function updateBots(now) {
  if (bots.size === 0) { botLast = now; return; }
  const dt = Math.min(0.05, (now - botLast) / 1000 || 0.05);   // clamp like the client's frame dt
  botLast = now;
  for (const bot of bots.values()) {
    const wp = WEAPONS[bot.weapon] || WEAPONS[DEFAULT_WEAPON];
    if (wp.charge && bot.chargeStart) {                        // release a full-charge railgun shot
      if (bot.dead) bot.chargeStart = 0;
      else if (now - bot.chargeStart >= wp.charge.fullMs) {
        const cf = Math.max(0, Math.min(1, (now - bot.chargeStart - wp.charge.minMs) / (wp.charge.fullMs - wp.charge.minMs)));
        resolveShot(bot, bot.ang, cf);
        bot.chargeStart = 0;
      }
    }
    bot._botF = 0; bot._botS = 0;
    bot.think(dt);                                             // AI: aim (writes bot.ang) + setMove/fire/reload
    if (!bot.dead) moveBot(bot, bot._botF, bot._botS, dt);
  }
}

const wss = new WebSocketServer({ host: HOST, port: PORT });
console.log(`[starfrag] authoritative arena "${map.name}" on ws://${HOST}:${PORT} (protocol v${PROTOCOL_VERSION})`);
console.log(`[starfrag] server-side bots: ${TARGET_BOTS > 0 ? `on-demand, target ${TARGET_BOTS} for a lone human` : 'disabled (STARFRAG_BOTS=0)'}`);

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
        reconcileBots(); // human present → spawn/top-up bots (they arrive on this human's next STATE)
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
      case C2S.RELOAD:
        beginReload(p);
        break;
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
    reconcileBots();   // human left → refill a bot, or (last human gone) despawn ALL bots
  });
  ws.on('error', () => {});
});

// --- authoritative tick: respawns + state broadcast at TICK_HZ -------------
setInterval(() => {
  // EMPTY-SERVER GUARD: with nobody connected (no humans AND — after despawn-on-empty —
  // no bots), skip the whole tick: no sim, no JSON.stringify, no broadcast. The interval
  // keeps firing, so this re-arms the instant a client connects (players.size ≥ 1). (smcgrl)
  if (players.size === 0) { simLast = 0; return; }
  const now = Date.now();
  const dt = simLast ? Math.min(0.25, (now - simLast) / 1000) : 1 / TICK_HZ;
  simLast = now;
  for (const p of players.values()) {
    if (p.dead && p.respawnAt && now >= p.respawnAt) respawn(p);
  }
  updateBots(now);       // drive in-process bot AI (no-op when no bots are live)
  updateObjective(now);
  updatePickups(now);
  decayOverheal(dt);     // mega-health overheal bleeds back to 100
  broadcast({ t: S2C.STATE, players: [...players.values()].filter((p) => p.joined).map(stateOf) });
  if (OBJ) broadcast({ t: S2C.OBJECTIVE, ...objectiveView(now) });
}, 1000 / TICK_HZ);
