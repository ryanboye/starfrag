// STARFRAG — simple bot AI (client ?bot=1 mode).
//
// A bot is a REAL networked client: it runs the exact same renderer, physics and
// net code a human does (so it shows up to everyone, and gets playtest-link
// video/state for free). This module only synthesizes intent — "which way do I
// want to move, where am I aiming, do I want to shoot" — via the `api` the game
// hands it. Contributors: make me smarter (see CONTRIBUTING.md, "improve the bot").
import { raycast, isSolidCell } from '../shared/map.js';

const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

export function createBot(api) {
  const s = { waypoint: null, repath: 0, strafe: 1, strafeT: 0, fireCd: 0,
    aimErr: 0, reactT: 0, lastTarget: null };  // human-fair aim state (no aimbot)

  // clear line of sight from (x0,y0) to (x1,y1)? (wall between them blocks it)
  function los(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy) || 0.0001;
    const hit = raycast(api.world.grid, api.world.W, api.world.H, x0, y0, dx / dist, dy / dist, dist + 0.5);
    return hit.dist >= dist - 0.15;
  }

  function nearestEnemy(me) {
    let best = null, bd = 1e9;
    for (const p of api.players()) {
      if (p.id === me.id || p.dead) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d < bd && los(me.x, me.y, p.x, p.y)) { bd = d; best = p; best._d = d; }
    }
    return best;
  }

  function pickWaypoint(me) {
    // roam toward a random spawn pad we can path roughly toward
    const cands = api.spawns.filter((sp) => Math.hypot(sp.x - me.x, sp.y - me.y) > 4);
    s.waypoint = cands.length ? cands[(Math.random() * cands.length) | 0] : api.spawns[0];
    s.repath = 4 + Math.random() * 3;
  }

  return function think(dt) {
    const me = api.me;
    s.fireCd -= dt;
    if (me.dead) { api.setMove(0, 0); return; }
    if (me.clip <= 0) api.reload();

    const target = nearestEnemy(me);

    if (target) {
      // HUMAN-FAIR AIM — deliberately NOT an aimbot (awfml's rule). Three handicaps:
      //  (1) reaction delay when a new target appears, (2) a wandering aim error that
      //  grows with range, (3) a capped turn speed so it can't snap-track.
      if (target !== s.lastTarget) { s.reactT = 0.28 + Math.random() * 0.24; s.lastTarget = target; }
      s.reactT -= dt;
      s.aimErr = Math.max(-0.3, Math.min(0.3, s.aimErr * 0.96 + (Math.random() - 0.5) * dt * 2.2));
      const rangeErr = Math.min(0.18, target._d * 0.013);            // farther = sloppier
      const want = Math.atan2(target.y - me.y, target.x - me.x)
        + s.aimErr * (0.6 + rangeErr * 3) + (Math.random() - 0.5) * rangeErr;
      const d = angDiff(want, me.ang);
      me.ang += Math.max(-3.4 * dt, Math.min(3.4 * dt, d));           // was 6 (snap-track)
      const aligned = Math.abs(angDiff(want, me.ang)) < 0.10;
      if (aligned && s.reactT <= 0 && me.clip > 0 && s.fireCd <= 0) { api.fire(); s.fireCd = 0.13; }

      // keep a mid fighting distance while strafing to dodge
      s.strafeT -= dt;
      if (s.strafeT <= 0) { s.strafe = -s.strafe; s.strafeT = 0.7 + Math.random(); }
      let f = 0;
      if (target._d > 8) f = 0.8; else if (target._d < 3.5) f = -0.6;
      api.setMove(f, s.strafe * 0.7);
      s.waypoint = null;
      return;
    }

    // no target -> roam
    s.repath -= dt;
    if (!s.waypoint || s.repath <= 0 ||
        Math.hypot(s.waypoint.x - me.x, s.waypoint.y - me.y) < 1.2) pickWaypoint(me);

    const want = Math.atan2(s.waypoint.y - me.y, s.waypoint.x - me.x);
    me.ang += Math.max(-3 * dt, Math.min(3 * dt, angDiff(want, me.ang)));

    // don't walk face-first into a wall — veer if something's right ahead
    const ahead = 0.7;
    const nx = me.x + Math.cos(me.ang) * ahead, ny = me.y + Math.sin(me.ang) * ahead;
    if (isSolidCell(api.world.grid, api.world.W, api.world.H, nx | 0, ny | 0)) {
      me.ang += 1.4 * dt * (s.strafe || 1);
      api.setMove(0.3, s.strafe * 0.5);
    } else {
      api.setMove(0.85, 0);
    }
  };
}
