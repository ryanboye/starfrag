// STARFRAG — server-side on-demand bot lifecycle proof.
//
// Boots its OWN authoritative server (a throwaway port, STARFRAG_BOTS=3) and drives
// it with a single scripted "human" WS client to prove the whole lifecycle end to end:
//
//   1. IDLE (no humans)        -> server runs the empty-tick guard: ~0% CPU, 0 bots.
//   2. HUMAN JOINS             -> exactly TARGET_BOTS internal bots appear in the state
//                                 broadcast within a second (spawn-on-join).
//   3. THEY MOVE + FIGHT       -> bot positions change and SHOT/HIT/KILL events flow
//                                 (real server-authoritative combat, no browser).
//   4. ACTIVE CPU              -> measured with 1 human + 3 bots fighting.
//   5. HUMAN LEAVES            -> ALL bots despawn (bots -> 0), server goes idle again.
//   6. IDLE CPU (after)        -> back to ~0% (empty-tick guard + zero bot AI).
//
// CPU is read straight from /proc/<pid>/stat (utime+stime) so the idle-vs-active
// number is objective. Self-contained: no external server needed.
//
//   node tools/bots-test.mjs            # default port 8796, 3 bots
//   PORT=8797 node tools/bots-test.mjs
import WebSocket from 'ws';
import { spawn, execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PORT || 8796);
const WS_URL = `ws://127.0.0.1:${PORT}`;
const TARGET = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLK = +execSync('getconf CLK_TCK').toString().trim() || 100;

// --- boot the server under test ---------------------------------------------
const srv = spawn('node', ['server/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, STARFRAG_PORT: String(PORT), STARFRAG_HOST: '127.0.0.1', STARFRAG_BOTS: String(TARGET), NODE_PATH: '/home/claudebot/node_modules' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
srv.stdout.on('data', (d) => { out += d.toString(); });
srv.stderr.on('data', (d) => { out += d.toString(); });
const cleanup = () => { try { srv.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

// %CPU of one core for the server process over `ms`, from /proc/<pid>/stat jiffies.
function cpuJiffies() {
  const stat = readFileSync(`/proc/${srv.pid}/stat`, 'utf8');
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // fields after "pid (comm)"
  return (+f[11]) + (+f[12]);   // utime (field 14) + stime (field 15)
}
async function cpuPct(ms) {
  const a = cpuJiffies(); await sleep(ms); const b = cpuJiffies();
  return +(((b - a) / CLK) / (ms / 1000) * 100).toFixed(2);
}

// A scripted human: joins, mirrors the STATE broadcast, and counts combat events.
class Human {
  constructor(name) {
    this.name = name; this.myId = null; this.x = 2; this.y = 2;
    this.players = new Map(); this.shots = 0; this.hits = 0; this.kills = [];
    this.ws = new WebSocket(WS_URL);
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'join', name })));
    this.ws.on('message', (b) => this._recv(JSON.parse(b.toString())));
    this.ws.on('error', () => {});
    // stay warm like a real 20Hz client (parked in a corner; we're only an observer)
    this.iv = setInterval(() => { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'move', x: this.x, y: this.y, ang: 0, moving: 0 })); }, 100);
  }
  _recv(m) {
    if (m.t === 'welcome') { this.myId = m.id; this.x = m.spawn.x; this.y = m.spawn.y; for (const p of m.players) this.players.set(p.id, p); }
    else if (m.t === 'state') {
      const seen = new Set();
      for (const p of m.players) { this.players.set(p.id, p); seen.add(p.id); }
      for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);
    } else if (m.t === 'shot') this.shots++;
    else if (m.t === 'hit') this.hits++;
    else if (m.t === 'kill') this.kills.push(m);
  }
  others() { return [...this.players.values()].filter((p) => p.id !== this.myId); }
  close() { clearInterval(this.iv); try { this.ws.close(); } catch {} }
}

async function waitForLog(re, timeout = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (re.test(out)) return true; await sleep(80); }
  throw new Error('timeout waiting for ' + (label || re));
}
async function waitCond(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(200); }
  throw new Error('timeout waiting for ' + label);
}

const R = {};
try {
  await waitForLog(/on ws:\/\//, 8000, 'server listen');
  R.startupBotsLine = /server-side bots: on-demand/.test(out);

  // 1. IDLE before any human — empty-tick guard should keep CPU ~0
  R.idleCpuBefore = await cpuPct(1500);

  // 2. HUMAN JOINS -> spawn-on-join
  const h1 = new Human('TESTER');
  await waitForLog(/bots -> 3 \(humans 1\)/, 4000, 'spawn-on-join log');
  R.spawnLoggedOnJoin = true;
  await sleep(900);
  const others = h1.others();
  R.botsVisibleOnJoin = others.length;                        // expect 3 in the STATE broadcast
  const pos0 = new Map(others.map((p) => [p.id, { x: p.x, y: p.y }]));

  // 3. THEY MOVE (fast + deterministic)
  await sleep(4500);
  let moved = 0;
  for (const p of h1.others()) { const a = pos0.get(p.id); if (a && Math.hypot(p.x - a.x, p.y - a.y) > 0.5) moved++; }
  R.botsMoved = moved;                                        // expect >= 2 of 3

  // 4. ACTIVE CPU (1 human + 3 bots fighting)
  R.activeCpu = await cpuPct(2000);

  // 5. THEY FIGHT — shots + hits land within seconds; a KILL takes ~15-30s because the
  //    aim is deliberately human-fair (no aimbot: reaction delay + wander + capped turn).
  //    Poll up to 40s for the first frag — passes the instant one lands.
  await waitCond(() => h1.kills.length >= 1, 40000, 'first bot frag');
  R.shotsObserved = h1.shots;                                 // > 0: bots engage
  R.hitsObserved = h1.hits;                                   // > 0: shots connect
  R.killsObserved = h1.kills.length;                          // >= 1: bots frag each other
  R.topFrags = Math.max(0, ...h1.others().map((p) => p.frags || 0));

  // 5. HUMAN LEAVES -> despawn ALL bots
  h1.close();
  await waitForLog(/bots -> 0 \(humans 0\)/, 4000, 'despawn-on-empty log');
  R.despawnLoggedOnEmpty = true;

  // 6. IDLE after — empty guard + zero bots
  R.idleCpuAfter = await cpuPct(2000);

  R.pass =
    R.startupBotsLine &&
    R.idleCpuBefore < 3 &&
    R.botsVisibleOnJoin === TARGET &&
    R.spawnLoggedOnJoin &&
    R.botsMoved >= 2 &&
    R.shotsObserved > 0 && R.hitsObserved > 0 && R.killsObserved >= 1 &&
    R.despawnLoggedOnEmpty &&
    R.idleCpuAfter < 3;

  console.log('\n=== STARFRAG SERVER-SIDE BOT LIFECYCLE ===');
  console.log(JSON.stringify(R, null, 2));
  console.log(`\nCPU  idle(before)=${R.idleCpuBefore}%  active(1 human+${TARGET} bots)=${R.activeCpu}%  idle(after)=${R.idleCpuAfter}%  [one core]`);
  console.log(R.pass ? '\nPASS ✅  spawn-on-join + move + fight + despawn-on-empty, idle stays cheap' : '\nFAIL ❌');
  cleanup();
  process.exit(R.pass ? 0 : 1);
} catch (e) {
  console.error('BOT LIFECYCLE ERROR:', e.message);
  console.log(JSON.stringify(R, null, 2));
  console.log('--- server output tail ---\n' + out.split('\n').slice(-20).join('\n'));
  cleanup();
  process.exit(2);
}
