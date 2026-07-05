// Integration test for the AIRLOCK OBJECTIVE (Seb) — companion to tools/verify.mjs.
//
// Drives the server-authoritative capture loop end to end with 4 real WS clients,
// each parked on a console, and asserts the state machine the client renders:
//   welcome carries objective  ->  arming (partial)  ->  all 4 armed  ->
//   opening  ->  venting (a winner + exactly N-1 vent kills, server-decided).
//
// The 4th client is staggered so 'arming' (armedCount 1..3) is observable and a
// clean single cycle can be asserted. Run against a hangar-bay server:
//   STARFRAG_MAP=hangar-bay STARFRAG_PORT=8802 node server/server.mjs &
//   URL=ws://127.0.0.1:8802 node tools/obj-test.mjs
import WebSocket from 'ws';

const URL = process.env.URL || 'ws://127.0.0.1:8802';
const CONSOLES = [{ x: 5.5, y: 10.5 }, { x: 26.5, y: 10.5 }, { x: 5.5, y: 21.5 }, { x: 26.5, y: 21.5 }];
const STAGGER = [0, 0, 0, 900];        // ms before client i starts channeling (makes 'arming' visible)

let welcomeObjective;                   // undefined until the first welcome arrives
const phasesSeen = new Set();
let peakArmed = 0;
let firstVent = null;                   // snapshot of the first venting broadcast
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
    if (i !== 0) return;                 // single observer: all state arrives by broadcast, count once
    const m = JSON.parse(buf.toString());
    if (m.t === 'welcome' && welcomeObjective === undefined) welcomeObjective = m.objective;
    if (m.t === 'kill' && m.weapon === 'airlock') ventKills.push(m);
    if (m.t === 'objective') {
      phasesSeen.add(m.phase);
      peakArmed = Math.max(peakArmed, m.armedCount);
      if (m.phase === 'venting' && firstVent === null) {
        firstVent = { winner: m.winner, killsAtVent: ventKills.length, armed: m.armedCount };
        setTimeout(finalize, 300);      // let any straggler messages land
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
  const N = CONSOLES.length;
  const pass =
    welcomeObjective !== undefined &&
    phasesSeen.has('arming') && phasesSeen.has('opening') && phasesSeen.has('venting') &&
    peakArmed === N &&
    firstVent && firstVent.winner && firstVent.winner.id != null &&
    firstVent.killsAtVent === N - 1;
  console.log('--- airlock objective integration test ---');
  console.log('welcome carried objective:', welcomeObjective !== undefined,
    welcomeObjective && `(phase=${welcomeObjective.phase}, consoles=${welcomeObjective.consoles.length}, airlock=${welcomeObjective.airlock && welcomeObjective.airlock.id})`);
  console.log('phases seen:', [...phasesSeen].join(' -> '));
  console.log('peak armedCount:', peakArmed, '/', N);
  console.log('first vent winner:', firstVent && JSON.stringify(firstVent.winner));
  console.log('vent kills at first vent:', firstVent && firstVent.killsAtVent, `(expect ${N - 1})`);
  console.log(pass ? '\nPASS ✅  airlock loop is server-authoritative and correct' : '\nFAIL ❌');
  process.exit(pass ? 0 : 1);
}

CONSOLES.forEach((_, i) => start(i));
setTimeout(() => { console.log('TIMEOUT — loop never reached venting'); finalize(); }, 12000);
