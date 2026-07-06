// STARFRAG — wire protocol shared by client and server.
//
// Everything on the wire is JSON of the shape { t: <type>, ...fields }.
// This file is the single source of truth for message types and the core
// combat constants, so the authoritative server and the predicting client
// never disagree about (say) fire rate or clip size. Import it from Node
// (`server/`) and from the browser (`client/`, via the `shared` symlink).
//
// SCAFFOLD HONESTY: movement is currently client-authoritative (the client
// sends its own position). Shooting/damage/death ARE server-authoritative.
// Full authoritative movement + anti-cheat is deliberately future work — see
// CONTRIBUTING.md. Don't over-build the scaffold.

export const PROTOCOL_VERSION = 1;

export const TICK_HZ = 20;        // server state-broadcast rate
export const RESPAWN_MS = 2500;   // delay from death to respawn
export const PLAYER_HP = 100;
export const HIT_RADIUS = 0.55;   // how close a hitscan ray must pass to a body

// --- Airlock objective mode -------------------------------------------------
// A server-authoritative capture-point win mode, active ONLY on decks that
// define `console` + `airlock` entities in their map data (e.g. hangar-bay).
// Deathmatch decks (deck7) simply omit them and this stays dormant.
//   loop: channel all consoles -> bay-door opens -> the deck vents ->
//         every player but the majority console-holder is sucked out -> they win.
// Movement is client-authoritative, so the server does NOT move anyone: the vent
// KILL is server-decided (truth), while the suck-toward-the-door PULL is the
// client's visual (spectacle). The two never disagree about who won or died.
export const OBJECTIVE = {
  MODE: 'airlock',
  ARM_MS: 2000,        // cumulative proximity (ms) to fully capture one console
  ARM_RADIUS: 1.35,    // how close (cells) a live player must be to channel it
  DOOR_OPEN_MS: 1500,  // telegraph window: door cranks open before the vent fires
  VENT_MS: 2500,       // the vent spectacle window (the kill lands at its start)
};

// The weapon roster. Stats are AUTHORITATIVE and shared: the server's resolveShot
// reads pellets/spread/rateMs/clip/dmg/range straight from here, so a new key is
// authoritative for free (see CONTRIBUTING.md → "How to add a weapon"). The client
// reads the same table for its viewmodel, ammo HUD, bolt tint and SFX names.
//
// `slot`   — number-key / cycle order (1..N).
// `color`  — HUD + pickup billboard + traveling-bolt tint.
// `fireSfx`/`reloadSfx` — asset basenames in client/assets/sfx (playSfx by name).
export const WEAPONS = {
  carbine: {
    name: 'PULSE CARBINE', slot: 1, color: '#3cd6ff',
    rateMs: 110,     // min ms between shots
    clip: 12,
    reloadMs: 1150,
    pellets: 1,
    spread: 0,       // radians of random cone per pellet
    dmgLo: 18, dmgHi: 30,
    range: 40,
    fireSfx: 'shoot', reloadSfx: 'reload',
  },
  // RIOT SCATTERGUN — chunky close-range pump-action: a fat cone of pellets, slow
  // to cycle, brutal up close and near-useless past mid-range. Video-pipeline
  // fire + reload animation (sprite-forge kling img2vid → repaired frames).
  scatter: {
    name: 'RIOT SCATTERGUN', slot: 2, color: '#ff9a3c',
    rateMs: 620,
    clip: 6,
    reloadMs: 1500,
    pellets: 8,
    spread: 0.135,
    dmgLo: 6, dmgHi: 11,
    range: 22,
    fireSfx: 'scatter-fire', reloadSfx: 'scatter-reload',
  },
  // PLASMA REPEATER — fast projectile stream, ties into the traveling-bolt system.
  // Tighter than the carbine but a hair of spread; bigger mag, mid reload.
  plasma: {
    name: 'PLASMA REPEATER', slot: 3, color: '#8cff5a',
    rateMs: 165,
    clip: 20,
    reloadMs: 1300,
    pellets: 1,
    spread: 0.02,
    dmgLo: 13, dmgHi: 21,
    range: 38,
    fireSfx: 'plasma-fire', reloadSfx: 'plasma-reload',
  },
  // slot 4 — RAILGUN reserved for tinyclaw. When its stats land here and a
  // `{ kind:'weapon', weapon:'railgun' }` pickup is placed in a deck, the pickup +
  // switch SYSTEM below grants/switches to it with ZERO extra wiring.
};
export const DEFAULT_WEAPON = 'carbine';
// What every player spawns owning. Picked-up weapons are LOST on death (drop-on-death
// arena rules), so the map pickups stay meaningful round to round.
export const STARTING_WEAPONS = ['carbine'];
// slot number -> weapon key (for number-key selection + cycle order)
export const WEAPON_SLOTS = Object.fromEntries(
  Object.entries(WEAPONS).map(([k, w]) => [w.slot, k]));
// How long a grabbed weapon pickup stays gone before it respawns (ms).
export const WEAPON_PICKUP_RESPAWN_MS = 12000;
export const WEAPON_PICKUP_RADIUS = 0.75;   // cells — walk this close to grab it

// Client -> Server
export const C2S = {
  JOIN:   'join',    // { name }
  MOVE:   'move',    // { x, y, ang, moving }   client-authoritative position (scaffold)
  SHOOT:  'shoot',   // { ang }                 server hitscans with the player's AUTHORITATIVE weapon
  RELOAD: 'reload',  // { }                     reload the current weapon
  SWITCH: 'switch',  // { weapon }              request a switch to an owned weapon
  PING:   'ping',    // { ts }
};

// Server -> Client
export const S2C = {
  WELCOME: 'welcome', // { id, spawn:{x,y,ang}, mapName, players:[state...] }
  STATE:   'state',   // { players:[ {id,name,color,x,y,ang,hp,frags,dead,fireT,reloading} ] }
  SHOT:    'shot',    // { id, ang, weapon }   -> render a muzzle flash on player `id`
  WEAPON:  'weapon',  // { weapon, clip, owned:[keys] }  -> YOUR authoritative weapon/ammo changed
  PICKUP:  'pickup',  // { id, taken }         -> a map weapon-pickup became (un)available
  HIT:     'hit',     // { id, by, dmg, hp }   -> player `id` took damage from `by`
  KILL:    'kill',    // { id, by, weapon, names:{id,by} }  -> killfeed entry
  SPAWN:   'spawn',   // { id, x, y, ang }     -> player (re)spawned
  LEAVE:   'leave',   // { id }
  PONG:    'pong',    // { ts }
  // Airlock objective state, broadcast every tick on decks that have it:
  //   { mode, phase:'idle'|'arming'|'opening'|'venting', total,
  //     armedCount, consoles:[{id,x,y,owner,color,progress,armed}],
  //     airlock:{x,y,w,h,dir}, timer:<ms left in phase|null>, winner:{id,name,color}|null }
  // Vent kills also arrive as normal S2C.KILL with weapon:'airlock' (killfeed = "vented").
  OBJECTIVE: 'objective',
};

// Distinct player colors, handed out round-robin by the server.
export const PLAYER_COLORS = [
  '#ff5a3c', '#3cd6ff', '#8cff3c', '#ffd23c',
  '#c86bff', '#ff3c9a', '#3cffd1', '#ff8a3c',
];
