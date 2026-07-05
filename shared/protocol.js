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

// The one and only weapon in the scaffold: the "PULSE CARBINE".
// New weapons are added here + in the client viewmodel — see CONTRIBUTING.md.
export const WEAPONS = {
  carbine: {
    name: 'PULSE CARBINE',
    rateMs: 110,     // min ms between shots
    clip: 12,
    reloadMs: 1150,
    pellets: 1,
    spread: 0,       // radians of random cone per pellet
    dmgLo: 18,
    dmgHi: 30,
    range: 40,
  },
};
export const DEFAULT_WEAPON = 'carbine';

// Client -> Server
export const C2S = {
  JOIN:   'join',    // { name }
  MOVE:   'move',    // { x, y, ang, moving }   client-authoritative position (scaffold)
  SHOOT:  'shoot',   // { ang, weapon }         server does the authoritative hitscan
  RELOAD: 'reload',  // { weapon }
  PING:   'ping',    // { ts }
};

// Server -> Client
export const S2C = {
  WELCOME: 'welcome', // { id, spawn:{x,y,ang}, mapName, players:[state...] }
  STATE:   'state',   // { players:[ {id,name,color,x,y,ang,hp,frags,dead,fireT,reloading} ] }
  SHOT:    'shot',    // { id, ang, weapon }   -> render a muzzle flash on player `id`
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
