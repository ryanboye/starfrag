// STARFRAG — RAILGUN server-authoritative verification (tinyclaw).
// The railgun is a charge-up, wall-PIERCING hitscan — the one weapon that's a trivial
// wallhack + damage cheat if the client is trusted. This harness proves it is NOT:
// it drives raw protocol clients against a real server and asserts the SERVER decides
// the charge level (it times the CHARGE→SHOOT hold), the pierce set, and the damage.
//
// Geometry (deck7): shooter A on the railgun pad (16,13) fires +y through the 2x2
// REACTOR block (16,15-16) at targets B (16,17) and C (16,19). A normal (carbine)
// shot is occluded by the reactor; the railgun pierces the wall AND both bodies.
//
//   Asserts: (control) carbine shot is wall-occluded -> no hit;
//            SHOOT with no prior CHARGE -> fizzle (no shot);      [anti-cheat]
//            release below charge.minMs -> fizzle (no shot);      [charge-gate]
//            mid-charge -> BOTH B+C hit through the wall, ~mid dmg;[pierce + scaling]
//            full-charge -> BOTH B+C hit for ~dmgHi, both die.    [pierce + one-shot]
//   Run: node tools/railgun-test.mjs      (spawns its own server on a test port)
import { WebSocket } from 'ws';
import { spawn } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { WEAPONS, C2S } = await import('../shared/protocol.js');

const PORT = 8799, HOST = '127.0.0.1', WS = `ws://${HOST}:${PORT}`;
const RG = WEAPONS.railgun;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  FAIL:', m)); };

// --- spawn the arena server on a test port ---------------------------------
const srv = spawn('node', ['server/server.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, STARFRAG_PORT: String(PORT), STARFRAG_HOST: HOST, STARFRAG_MAP: 'deck7-derelict' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => process.env.RG_DEBUG && process.stderr.write('[srv] ' + d));

// --- a raw protocol client -------------------------------------------------
function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const c = { ws, id: null, weapon: null, clip: 0, hits: [], kills: [],
      send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)),
      move: (x, y, ang) => c.send({ t: C2S.MOVE, x, y, ang, moving: 0 }),
      close: () => ws.close() };
    ws.on('open', () => { c.send({ t: C2S.JOIN, name }); });
    ws.on('error', reject);
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.t === 'welcome') { c.id = m.id; resolve(c); }
      else if (m.t === 'weapon') { c.weapon = m.weapon; c.clip = m.clip; }
      else if (m.t === 'hit') c.hits.push(m);
      else if (m.t === 'kill') c.kills.push(m);
    });
  });
}
// hits recorded by ALL sockets are the same broadcast; use the shooter's buffer.
const hitsOn = (shooter, targetId, sinceLen) => shooter.hits.slice(sinceLen).filter((h) => h.id === targetId);

async function main() {
  // wait for the server to accept a connection
  for (let i = 0; i < 40; i++) { try { const t = await connect('probe'); t.close(); break; } catch { await sleep(150); } if (i === 39) throw new Error('server never came up'); }

  const A = await connect('shooter'), B = await connect('targetB'), C = await connect('targetC');
  await sleep(150);
  ok(A.id && B.id && C.id, 'three clients joined');

  // A grabs the railgun off its pad; server grants it on a tick
  A.move(16, 13, Math.PI / 2);
  for (let i = 0; i < 40 && A.weapon !== 'railgun'; i++) { A.move(16, 13, Math.PI / 2); await sleep(75); }
  ok(A.weapon === 'railgun', `A picked up the railgun (server-granted), clip ${A.clip}`);

  // line B and C up on the +y ray, behind the reactor wall (B) and behind B (C)
  const place = () => { A.move(16, 13, Math.PI / 2); B.move(16, 17, 0); C.move(16, 19, 0); };
  place(); await sleep(200);

  // --- CONTROL: a carbine shot must be OCCLUDED by the reactor wall -----------
  A.send({ t: C2S.SWITCH, weapon: 'carbine' }); await sleep(120); place(); await sleep(120);
  let n = A.hits.length;
  A.send({ t: C2S.SHOOT, ang: Math.PI / 2 }); await sleep(250);
  ok(hitsOn(A, B.id, n).length === 0 && hitsOn(A, C.id, n).length === 0, 'control: carbine shot is wall-occluded (no hit through the reactor)');
  A.send({ t: C2S.SWITCH, weapon: 'railgun' }); await sleep(120); place(); await sleep(120);

  // --- ANTI-CHEAT: SHOOT with NO prior CHARGE -> the server fizzles it --------
  n = A.hits.length;
  A.send({ t: C2S.SHOOT, ang: Math.PI / 2 }); await sleep(300);
  ok(hitsOn(A, B.id, n).length === 0, 'anti-cheat: SHOOT without a CHARGE = no shot (server times the charge, not the client)');

  // --- CHARGE-GATE: release below charge.minMs -> fizzle ----------------------
  n = A.hits.length; place();
  A.send({ t: C2S.CHARGE }); await sleep(Math.max(40, RG.charge.minMs - 140)); A.send({ t: C2S.SHOOT, ang: Math.PI / 2 }); await sleep(300);
  ok(hitsOn(A, B.id, n).length === 0, `charge-gate: release under ${RG.charge.minMs}ms = fizzle (no shot)`);

  // --- MID CHARGE: pierces the wall + BOTH bodies, ~mid damage ----------------
  n = A.hits.length; place(); await sleep(120);
  A.send({ t: C2S.CHARGE }); await sleep(RG.charge.minMs + (RG.charge.fullMs - RG.charge.minMs) * 0.5); A.send({ t: C2S.SHOOT, ang: Math.PI / 2 }); await sleep(350);
  const midB = hitsOn(A, B.id, n), midC = hitsOn(A, C.id, n);
  ok(midB.length === 1 && midC.length === 1, 'mid-charge: ONE shot pierces the reactor wall AND hits BOTH B and C');
  const midDmg = midB[0]?.dmg ?? 0;
  const expMid = Math.round(RG.dmgLo + (RG.dmgHi - RG.dmgLo) * 0.5);
  ok(Math.abs(midDmg - expMid) <= 12, `mid-charge damage scales (~${expMid}, got ${midDmg})`);

  // --- FULL CHARGE: ~dmgHi to both, both die ---------------------------------
  n = A.hits.length; place(); await sleep(RG.rateMs + 60);
  A.send({ t: C2S.CHARGE }); await sleep(RG.charge.fullMs + 150); A.send({ t: C2S.SHOOT, ang: Math.PI / 2 }); await sleep(350);
  const fullB = hitsOn(A, B.id, n), fullC = hitsOn(A, C.id, n);
  ok(fullB.length === 1 && fullC.length === 1, 'full-charge: ONE shot pierces to BOTH B and C');
  ok((fullB[0]?.dmg ?? 0) >= RG.dmgHi - 6, `full-charge damage ~dmgHi (${RG.dmgHi}, got ${fullB[0]?.dmg})`);
  ok(A.kills.some((k) => k.id === B.id) && A.kills.some((k) => k.id === C.id), 'full-charge one-shots both bodies (KILL x2 through the wall)');

  A.close(); B.close(); C.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0;
}

let code = 2;
try { code = (await main()) ? 0 : 1; }
catch (e) { console.error('RAILGUN TEST ERROR:', e.message); }
finally { srv.kill('SIGKILL'); }
process.exit(code);
