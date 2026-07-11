// STARFRAG — POWERUP SYSTEM server-authoritative verification.
// The powerups (quad / mega-health / armor / ammo) all change the SERVER's hp/armor/
// damage math — a trivial cheat surface if the client is trusted. This harness proves
// they are NOT: it drives raw protocol clients against a real deck7v2 server and asserts
// the SERVER owns every effect.
//
//   Asserts: ARMOR absorbs ~2/3 of a hit before HP (and depletes);           [armor]
//            a grabbed item PAD goes dark then RESPAWNS on its clock;         [respawn]
//            MEGA-HEALTH overheals past 100 and DECAYS back toward it;        [mega]
//            an AMMO pad tops off the current magazine;                       [ammo]
//            baseline carbine damage is the un-multiplied roll (kill-time);   [baseline]
//            the QUAD multiplies a hit ~3x SERVER-side (dmg > the base cap);  [quad]
//            the QUAD EXPIRES on the server clock (damage returns to base).   [expiry]
//
// The server exposes test-only env knobs (unset in prod) so this runs in ~15s instead of
// waiting out the live 25s/22s/30s clocks: STARFRAG_QUAD_ALWAYS (grabbable now),
// STARFRAG_QUAD_MS (short duration), STARFRAG_ITEM_RESPAWN_MS (short pad respawn).
//
//   Run: node tools/powerups-test.mjs      (spawns its own deck7v2 server on a test port)
import { WebSocket } from 'ws';
import { spawn } from 'child_process';
const { WEAPONS, C2S, POWERUP } = await import('../shared/protocol.js');

const PORT = 8798, HOST = '127.0.0.1', WS = `ws://${HOST}:${PORT}`;
const QUAD_MS = 2000, ITEM_RESPAWN_MS = 1500;
const CARB = WEAPONS.carbine;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  FAIL:', m)); if (c) console.log('  ok:', m); };

// deck7v2 pad cells (shared/map.js) + a clean firing lane in engineering (row y=11 is open)
const PADS = { quad: [2.5, 12.5], mega: [25.5, 13.5], armor: [17.5, 28.5], health: [2.5, 19.5], ammo: [12.5, 28.5] };
const FIRE_A = [2.5, 11.5], FIRE_B = [4.5, 11.5];   // A fires +x (ang 0) at B, 2 cells away, open lane

// --- spawn the arena server on a test port (deck7v2, no bots, powerup test knobs) ---
const srv = spawn('node', ['server/server.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env, STARFRAG_PORT: String(PORT), STARFRAG_HOST: HOST, STARFRAG_MAP: 'deck7v2',
    STARFRAG_BOTS: '0', STARFRAG_QUAD_ALWAYS: '1', STARFRAG_QUAD_MS: String(QUAD_MS), STARFRAG_ITEM_RESPAWN_MS: String(ITEM_RESPAWN_MS),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => process.env.PU_DEBUG && process.stderr.write('[srv] ' + d));

// --- a raw protocol client -------------------------------------------------
function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const c = {
      ws, id: null, weapon: null, clip: 0, hits: [], kills: [], pickups: [], powerups: [],
      states: new Map(),   // id -> latest public state (hp/armor/quad/dead) from STATE broadcasts
      send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)),
      move: (x, y, ang = 0) => c.send({ t: C2S.MOVE, x, y, ang, moving: 0 }),
      close: () => ws.close(),
    };
    ws.on('open', () => c.send({ t: C2S.JOIN, name }));
    ws.on('error', reject);
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.t === 'welcome') { c.id = m.id; resolve(c); }
      else if (m.t === 'weapon') { c.weapon = m.weapon; c.clip = m.clip; }
      else if (m.t === 'hit') c.hits.push(m);
      else if (m.t === 'kill') c.kills.push(m);
      else if (m.t === 'pickup') c.pickups.push({ ...m, at: Date.now() });
      else if (m.t === 'powerup') c.powerups.push({ ...m, at: Date.now() });
      else if (m.t === 'state') for (const p of m.players) c.states.set(p.id, p);
    });
  });
}
const st = (obs, id) => obs.states.get(id) || {};

// park a client on a pad long enough for the server tick to grab it
async function grab(client, pad, ms = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { client.move(pad[0], pad[1]); await sleep(60); }
}
// place A + B on the firing lane, let a couple of ticks land the positions
async function lineUp(A, B) { for (let i = 0; i < 4; i++) { A.move(...FIRE_A, 0); B.move(...FIRE_B, 0); await sleep(60); } }
async function waitRespawn(obs, id, ms = 3200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (st(obs, id).dead === false) return true; await sleep(80); }
  return false;
}

async function main() {
  for (let i = 0; i < 40; i++) { try { const t = await connect('probe'); t.close(); break; } catch { await sleep(150); } if (i === 39) throw new Error('server never came up'); }

  const A = await connect('shooter'), B = await connect('target');
  await sleep(250);
  ok(A.id && B.id, 'two clients joined a deck7v2 server');

  // ===================================================================== ARMOR
  await lineUp(A, B);
  await grab(B, PADS.armor);                                  // B walks onto the armor pad
  await lineUp(A, B);
  ok((st(A, B.id).armor || 0) === POWERUP.ARMOR_ADD, `ARMOR grabbed: B has ${POWERUP.ARMOR_ADD} plates (got ${st(A, B.id).armor})`);
  {
    const before = st(A, B.id), armor0 = before.armor, hp0 = before.hp;
    const n = A.hits.length;
    A.send({ t: C2S.SHOOT, ang: 0 }); await sleep(300);
    const h = A.hits.slice(n).find((x) => x.id === B.id);
    ok(!!h, 'ARMOR: A landed a carbine hit on B');
    if (h) {
      const armorLost = armor0 - h.armor, hpLost = hp0 - h.hp;
      const expectAbsorb = Math.round(h.dmg * POWERUP.ARMOR_ABSORB);
      ok(armorLost > 0, `ARMOR absorbed part of the hit (plates ${armor0} -> ${h.armor}, absorbed ${armorLost})`);
      ok(hpLost < h.dmg, `ARMOR cushioned HP: hp lost ${hpLost} < damage dealt ${h.dmg}`);
      ok(armorLost + hpLost === h.dmg, `damage conserved: armor(${armorLost}) + hp(${hpLost}) == dmg(${h.dmg})`);
      ok(Math.abs(armorLost - Math.min(armor0, expectAbsorb)) <= 1, `armor soaked ~2/3 of the blow (~${expectAbsorb}, got ${armorLost})`);
    }
  }

  // ================================================================== PAD RESPAWN
  {
    const grabbed = B.pickups.filter((p) => p.id === 'pickup-dock-armor' && p.taken);
    ok(grabbed.length > 0, 'RESPAWN: the armor pad broadcast taken=true on grab');
    const t0 = grabbed.length ? grabbed[0].at : Date.now();
    // wait out the (shortened) respawn window, then confirm the pad came back
    const deadline = t0 + ITEM_RESPAWN_MS + 1200;
    while (Date.now() < deadline && !B.pickups.some((p) => p.id === 'pickup-dock-armor' && !p.taken)) await sleep(120);
    const back = B.pickups.find((p) => p.id === 'pickup-dock-armor' && !p.taken);
    ok(!!back, `RESPAWN: the armor pad reappeared on its clock (~${ITEM_RESPAWN_MS}ms)`);
    if (back && grabbed.length) ok(back.at - t0 >= ITEM_RESPAWN_MS - 300, `RESPAWN honored the timer (${back.at - t0}ms >= ${ITEM_RESPAWN_MS}ms)`);
  }

  // ================================================================ MEGA-HEALTH
  await grab(B, PADS.mega);                                   // B grabs the mega-health
  const megaPeak = st(A, B.id).hp;
  ok(megaPeak > POWERUP.HEALTH_MAX, `MEGA overhealed past ${POWERUP.HEALTH_MAX}: B hp = ${megaPeak}`);
  // hold B still (no damage) and watch the overheal bleed down
  const stillEnd = Date.now() + 2600;
  while (Date.now() < stillEnd) { B.move(PADS.mega[0] + 3, PADS.mega[1]); await sleep(80); }   // step off the pad, sit idle
  const megaLater = st(A, B.id).hp;
  ok(megaLater < megaPeak, `MEGA decays: B hp fell ${megaPeak} -> ${megaLater} while idle`);
  ok(megaLater >= POWERUP.HEALTH_MAX, `MEGA decay floors at ${POWERUP.HEALTH_MAX} (got ${megaLater}, not below)`);

  // ======================================================================= AMMO
  // (A carbine fire sends no WEAPON msg, so a raw client can't watch its own mag DROP — but
  // the server DOES decrement it. Proof the pad works: it only broadcasts a grab when the
  // server sees the mag below full, and the grant WEAPON carries a topped-off clip.)
  for (let i = 0; i < 3; i++) { B.send({ t: C2S.SHOOT, ang: 0 }); await sleep(CARB.rateMs + 60); }   // drain B's mag server-side
  const nPow = B.powerups.length;
  await grab(B, PADS.ammo);
  ok(B.powerups.slice(nPow).some((p) => p.kind === 'ammo' && p.by === B.id), 'AMMO: pad grabbed (server saw the mag below full and refilled)');
  ok(B.clip === CARB.clip, `AMMO grant topped the magazine to full (clip ${B.clip}/${CARB.clip})`);

  // ================================================== BASELINE DAMAGE (kill-time)
  await waitRespawn(A, B.id); await lineUp(A, B);
  let baseShots = 0; const baseDmgs = [];
  { // fire carbine until B dies; count shots (the un-quaded kill-time)
    let nk = A.kills.length;
    for (let i = 0; i < 12; i++) {
      const nh = A.hits.length;
      A.send({ t: C2S.SHOOT, ang: 0 }); baseShots++;
      await sleep(CARB.rateMs + 120);
      const h = A.hits.slice(nh).find((x) => x.id === B.id);
      if (h) baseDmgs.push(h.dmg);
      if (A.kills.slice(nk).some((k) => k.id === B.id)) break;
    }
  }
  const baseMax = Math.max(0, ...baseDmgs), baseAvg = baseDmgs.reduce((a, b) => a + b, 0) / (baseDmgs.length || 1);
  ok(baseDmgs.length > 0 && baseMax <= CARB.dmgHi, `BASELINE: carbine hits roll ${CARB.dmgLo}-${CARB.dmgHi} un-multiplied (max ${baseMax}), killed B in ${baseShots} shots`);
  A.send({ t: C2S.RELOAD }); await sleep(CARB.reloadMs + 200);   // refill A's mag for the quad phase

  // ======================================================= QUAD (damage multiplier)
  await waitRespawn(A, B.id);
  await grab(A, PADS.quad);                                    // A grabs the quad
  ok((st(A, A.id).quad || 0) > 0, `QUAD grabbed: A carries the quad (${st(A, A.id).quad}ms left)`);
  ok(A.powerups.some((p) => p.kind === 'quad' && p.by === A.id), 'QUAD grab broadcast a powerup event (client cue + carrier tint)');
  ok(A.pickups.some((p) => p.id === 'power-quad' && p.taken), 'QUAD pad went dark on grab (S2C.PICKUP taken)');
  await lineUp(A, B);
  let quadDmg = 0;
  { const nh = A.hits.length; A.send({ t: C2S.SHOOT, ang: 0 }); await sleep(300);
    const h = A.hits.slice(nh).find((x) => x.id === B.id); quadDmg = h ? h.dmg : 0; }
  ok(quadDmg > CARB.dmgHi, `QUAD multiplies SERVER-side: a carbine hit dealt ${quadDmg} (> the ${CARB.dmgHi} un-quaded cap)`);
  const impliedRatio = quadDmg / (baseAvg || 1);
  ok(impliedRatio >= POWERUP.QUAD_MULT - 1, `QUAD ~${POWERUP.QUAD_MULT}x: ${quadDmg} vs baseline avg ${baseAvg.toFixed(1)} (~${impliedRatio.toFixed(1)}x -> kills far faster)`);

  // ============================================================= QUAD EXPIRY
  const holdEnd = Date.now() + QUAD_MS + 900;                  // wait out the quad's server-timed life
  while (Date.now() < holdEnd && (st(A, A.id).quad || 0) > 0) await sleep(100);
  ok((st(A, A.id).quad || 0) === 0, 'QUAD EXPIRED on the server clock (STATE quad -> 0)');
  A.send({ t: C2S.RELOAD }); await sleep(CARB.reloadMs + 200);   // A used its mag on the quad shot
  await waitRespawn(A, B.id); await lineUp(A, B);
  let postDmg = 0;
  { const nh = A.hits.length;
    for (let i = 0; i < 4 && !postDmg; i++) { A.send({ t: C2S.SHOOT, ang: 0 }); await sleep(CARB.rateMs + 120);
      const h = A.hits.slice(nh).find((x) => x.id === B.id); if (h) postDmg = h.dmg; } }
  ok(postDmg > 0 && postDmg <= CARB.dmgHi, `after expiry damage returned to base: hit dealt ${postDmg} (<= ${CARB.dmgHi})`);

  A.close(); B.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0;
}

let code = 2;
try { code = (await main()) ? 0 : 1; }
catch (e) { console.error('POWERUPS TEST ERROR:', e.message, e.stack); }
finally { srv.kill('SIGKILL'); }
process.exit(code);
