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
  // RAILGUN — slow, huge-damage, WALL-PIERCING charge-hitscan power weapon (tinyclaw).
  // HOLD fire to charge, RELEASE to fire: below charge.minMs = no shot (fizzle); damage
  // scales dmgLo→dmgHi over [minMs, fullMs]. `pierce` = the ray passes through walls AND
  // bodies, hitting every target along `range`. Both the charge level and the pierce set
  // are resolved SERVER-side (server times the hold via C2S.CHARGE→C2S.SHOOT) — a client
  // that lies about its charge or trusts its own hitscan can't cheat. See resolveShot.
  railgun: {
    name: 'RAILGUN', slot: 4, color: '#c86bff',
    rateMs: 250,       // post-release floor; the real gate is the charge time
    clip: 3,
    reloadMs: 1900,
    pellets: 1,
    spread: 0,         // a perfectly straight rail
    dmgLo: 34, dmgHi: 110,   // min-charge tap → full-charge (one-shots a 100 HP body)
    range: 60,               // longest in the game — it's a line weapon
    fireSfx: 'railgun-fire', reloadSfx: 'railgun-reload',
    charge: { minMs: 250, fullMs: 1100 },   // hold time → damage scale; < minMs = fizzle
    pierce: true,                            // through walls + every body along range
  },
};
export const DEFAULT_WEAPON = 'carbine';
// What every player spawns owning. Picked-up weapons are LOST on death (drop-on-death
// arena rules), so the map pickups stay meaningful round to round.
export const STARTING_WEAPONS = ['carbine'];

// --- POWERUPS & SUSTAIN ITEMS (arena-shooter canon) -------------------------
// Server-authoritative, shared so the client's HUD/telegraph never disagrees with the
// server's hp/armor/damage math. Kinds: 'quad' (timed damage multiplier), 'health'
// (instant +HP; the `mega` variant overheals + decays), 'armor' (absorbs a fraction of
// incoming damage before HP), 'ammo' (tops off the current magazine). Placement comes
// from the map data (shared/map.js); these are the numbers that make a grab MEAN something.
export const POWERUP = {
  // THE QUAD — a timed damage multiplier. Canon is 3-4x in the quake lineage, but STARFRAG's
  // carbine TTK is already short: at 3x the quad compressed a kill to a ~0.11-0.22s 2-tap for a
  // WHOLE 22s window — a fight-deleter. 2.5x keeps the quad scary (still a decisive burst) without
  // erasing the exchange. This multiplier is THE swing lever (one number, tuned here). Charge
  // weapons additionally cap the post-multiply damage at their own dmgHi in server applyHit — see
  // there — so a cheap railgun min-tap can't become a quaded one-shot. Carrier is visible (a purple
  // tint on their billboard + a holder HUD countdown). It drops NOTHING on death — the effect ends.
  QUAD_MULT: 2.5,
  QUAD_MS: 22000,                 // how long a grabbed quad lasts (server-timed)
  // The QUAD is TELEGRAPHED: its pad glows on a fixed wall-clock cycle (up READY_MS every
  // CYCLE_MS, glow-ramps RAMP_MS before) so every client agrees WHEN it's contested with
  // no server message — and the SERVER gates the grab to the SAME window (authoritative).
  QUAD_CYCLE_MS: 30000, QUAD_READY_MS: 10000, QUAD_RAMP_MS: 6000,
  // MEGA-HEALTH: +100 up to a 200 overheal, then bleeds back to 100 at MEGA_DECAY/s.
  MEGA_ADD: 100, MEGA_MAX: 200, MEGA_DECAY: 1,
  // health: instant +25 up to the normal 100 cap.
  HEALTH_ADD: 25, HEALTH_MAX: 100,
  // armor: +50 up to 100; soaks ARMOR_ABSORB of each incoming hit until it runs out.
  ARMOR_ADD: 50, ARMOR_MAX: 100, ARMOR_ABSORB: 2 / 3,
  // instant item pads (health/armor/ammo) go dark this long before respawning.
  ITEM_RESPAWN_MS: 25000,
  PICKUP_RADIUS: 0.75,            // walk this close (cells) to grab an item — matches weapons
};

// --- DEFENSIVE-PAD ANTI-PHASING (armor + mega-health) -----------------------
// The QUAD telegraph is a wall-clock cycle: it's fresh/READY for QUAD_READY_MS at the top of
// every QUAD_CYCLE_MS (the server grab-gate + the client telegraph both read this same clock).
// The DEFENSIVE items (armor plates + mega-health overheal) are the survivability grabs, and
// quad + one of them on the same body (⅔ absorb behind a big damage mult) is near-unkillable.
// A plain free-run respawn drifts INTO phase with the quad cycle, so those two power spikes keep
// co-refreshing. Instead the server locks the defensive respawn to the quad clock, offset a HALF
// cycle — the quad's ANTI-PHASE point — so fresh plates are NEVER on the floor during the quad's
// READY window. These pure helpers are the single source of that math (server + tests import them).
export const QUAD_HALF_CYCLE_MS = POWERUP.QUAD_CYCLE_MS / 2;
// Is the quad telegraph fresh/READY at wall-clock time t?
export function quadReadyAt(t) { return (((t % POWERUP.QUAD_CYCLE_MS) + POWERUP.QUAD_CYCLE_MS) % POWERUP.QUAD_CYCLE_MS) < POWERUP.QUAD_READY_MS; }
// Next defensive-pad respawn instant at/after `earliest`: the soonest time ≡ half-cycle (mod
// cycle), i.e. the quad's anti-phase slot. Guaranteed outside the READY window by construction
// (QUAD_HALF_CYCLE_MS 15s ≥ QUAD_READY_MS 10s).
export function nextDefensiveRespawn(earliest) {
  const cyc = POWERUP.QUAD_CYCLE_MS;
  const k = Math.ceil((earliest - QUAD_HALF_CYCLE_MS) / cyc);
  return k * cyc + QUAD_HALF_CYCLE_MS;
}
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
  SHOOT:  'shoot',   // { ang }                 server hitscans with the player's AUTHORITATIVE weapon (charge weapons: server times the hold)
  CHARGE: 'charge',  // { }                     fire pressed on a charge weapon → start the server-side charge clock
  RELOAD: 'reload',  // { }                     reload the current weapon
  SWITCH: 'switch',  // { weapon }              request a switch to an owned weapon
  PING:   'ping',    // { ts }
};

// Server -> Client
export const S2C = {
  WELCOME: 'welcome', // { id, spawn:{x,y,ang}, mapName, players:[state...], pickups:[...] }
  STATE:   'state',   // { players:[ {id,name,color,x,y,ang,hp,armor,frags,dead,fireT,reloading,quad} ] }  quad = ms of QUAD left (0 = none)
  SHOT:    'shot',    // { id, ang, weapon, charge? }  -> muzzle flash on `id`; charge (0..1) present for the railgun -> beam intensity
  WEAPON:  'weapon',  // { weapon, clip, owned:[keys] }  -> YOUR authoritative weapon/ammo changed
  PICKUP:  'pickup',  // { id, taken }         -> a map pickup pad (weapon/item/quad) became (un)available
  POWERUP: 'powerup', // { kind, id, by }      -> `by` grabbed a sustain/quad item (cue + toast; hp/armor/quad land via STATE)
  HIT:     'hit',     // { id, by, dmg, hp, armor }  -> player `id` took damage from `by` (armor = their remaining plates)
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
