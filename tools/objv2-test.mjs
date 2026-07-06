// Integration test for the DECK7V2 "OVERLOAD THE CORE" objective — the deck7v2
// companion to tools/obj-test.mjs (hangar-bay airlock). It proves the SAME reused
// server-authoritative state machine drives the 3-console overload end to end:
//   welcome carries objective -> arming (partial) -> all 3 consoles armed ->
//   opening (the telegraphed OVERLOAD countdown) -> venting (a winner + exactly
//   N-1 core-implosion kills, server-decided).
//
// Consoles A/B/C are spread across bridge/cargo/docking (shared/map.js DECK7V2_CELLS),
// so this also exercises "arming all three requires 3 separated holders." The 3rd
// client is staggered so 'arming' (armedCount 1..2) is observable.
//
// Run against a deck7v2 server on a NON-default test port:
//   NODE_PATH=/home/claudebot/node_modules STARFRAG_MAP=deck7v2 STARFRAG_PORT=8795 node server/server.mjs &
//   URL=ws://127.0.0.1:8795 NODE_PATH=/home/claudebot/node_modules node tools/objv2-test.mjs
import WebSocket from 'ws';
import { DECK7V2_CELLS } from '../shared/map.js';

const URL = process.env.URL || 'ws://127.0.0.1:8795';
const CONSOLES = DECK7V2_CELLS.consoles.map((c) => ({ x: c.x, y: c.y }));   // A, B, C
const STAGGER = [0, 0, 1100];        // ms before client i starts channeling (makes 'arming' visible)

let welcomeObjective;                 // undefined until the first welcome arrives
const phasesSeen = new Set();
let peakArmed = 0;
let firstVent = null;                 // snapshot of the first venting broadcast
const ventKills = [];
const clients = [];
let finalized = false;

function start(i) {
  const ws = new WebSocket(URL);
  clients[i] = { ws, iv: null };
  const spot = CONSOLES[i];
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: `cap${i}` })));
  ws.on('error', () => {});
  ws.on('message', (buf) => {
    if (i !== 0) return;               // single observer: all state arrives by broadcast, count once
    const m = JSON.parse(buf.toString());
    if (m.t === 'welcome' && welcomeObjective === undefined) welcomeObjective = m.objective;
    if (m.t === 'kill' && m.weapon === 'airlock') ventKills.push(m);   // machine still tags implosion kills 'airlock'
    if (m.t === 'objective') {
      phasesSeen.add(m.phase);
      peakArmed = Math.max(peakArmed, m.armedCount);
      if (m.phase === 'venting' && firstVent === null) {
        firstVent = { winner: m.winner, killsAtVent: ventKills.length, armed: m.armedCount, mode: m.mode, timer: m.timer };
        setTimeout(finalize, 300);     // let any straggler messages land
      }
    }
  });
  setTimeout(() => {
    clients[i].iv = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'move', x: spot.x, y: spot.y, ang: 0, moving: 0 }));
    }, 80);
  }, STAGGER[i]);
}

function finalize() {
  if (finalized) return; finalized = true;
  for (const c of clients) { if (c && c.iv) clearInterval(c.iv); if (c) c.ws.close(); }
  const N = CONSOLES.length;           // 3
  const pass =
    welcomeObjective !== undefined && welcomeObjective !== null &&
    phasesSeen.has('arming') && phasesSeen.has('opening') && phasesSeen.has('venting') &&
    peakArmed === N &&
    firstVent && firstVent.winner && firstVent.winner.id != null &&
    firstVent.killsAtVent === N - 1;
  console.log('--- deck7v2 OVERLOAD objective integration test ---');
  console.log('welcome carried objective:', welcomeObjective != null,
    welcomeObjective && `(mode=${welcomeObjective.mode}, phase=${welcomeObjective.phase}, consoles=${welcomeObjective.consoles.length}, region=${welcomeObjective.airlock && welcomeObjective.airlock.id})`);
  console.log('objective mode on wire:', firstVent && firstVent.mode, '(expect "overload")');
  console.log('phases seen:', [...phasesSeen].join(' -> '));
  console.log('peak armedCount:', peakArmed, '/', N);
  console.log('first vent winner:', firstVent && JSON.stringify(firstVent.winner));
  console.log('implosion kills at first vent:', firstVent && firstVent.killsAtVent, `(expect ${N - 1})`);
  console.log(pass ? '\nPASS ✅  overload loop is server-authoritative and correct' : '\nFAIL ❌');
  process.exit(pass ? 0 : 1);
}

CONSOLES.forEach((_, i) => start(i));
setTimeout(() => { console.log('TIMEOUT — loop never reached venting'); finalize(); }, 16000);
