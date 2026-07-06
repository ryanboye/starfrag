// STARFRAG — RAILGUN client UX + render verification (tinyclaw).
// Server-authority is proven by tools/railgun-test.mjs (raw WS). THIS drives one real
// headless browser client to prove the CHARGE UX + rail VFX render, and drops proof
// shots to docs/. Self-contained: it spawns the static client server + the arena.
//   1. grab the railgun off its pad (server grants it — we only teleport)
//   2. HOLD (charge): __game.charging flips, chargeFrac climbs 0→1, HUD ring + muzzle
//      glow render (mid + full screenshots)
//   3. RELEASE at full: a rail spawns (__game.beams>0), a round leaves the clip (3→2)
//   4. anti-fizzle: a sub-min tap spends NO ammo and spawns NO beam (client mirrors the
//      server's charge-gate so the HUD never lies)
//   5. mobile-landscape idle shot proves the viewmodel stays in the low band (awfml QA)
//   node tools/railgun-verify.mjs
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { WebSocket } from 'ws';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
mkdirSync(DOCS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// high ports: the box is shared with BMO's own starfrag dev env on 8080/8791 — don't collide.
const STATIC_PORT = +(process.env.RG_STATIC_PORT || 8086), WS_PORT = +(process.env.RG_WS_PORT || 8795);
const WS_URL = `ws://localhost:${WS_PORT}`;
const PAD = { x: 16, y: 13, ang: Math.PI / 2 };   // railgun pickup on deck7 (shared/map.js)

const procs = [];
const spawnProc = (cmd, args, env) => {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; process.env.RG_DEBUG && process.stderr.write(`[${args[0]}] ${d}`); });
  // a leftover orphan on the port makes the arena die with EADDRINUSE — surface it, don't
  // silently let the browser connect to the orphan (that was a real debugging trap).
  p.on('exit', (code) => { if (code) { p._died = /EADDRINUSE/.test(err) ? `port ${err.match(/:(\d+)/)?.[1] || '?'} in use (orphan?)` : `exit ${code}`; } });
  procs.push(p); return p;
};
const cleanup = () => { for (const p of procs) try { p.kill('SIGKILL'); } catch {} };
// clean up children even when `timeout` (or Ctrl-C) SIGKILLs us mid-run — else orphans pile up
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { cleanup(); process.exit(130); });
// confirm the ARENA we spawned is the one answering (raw-WS WELCOME), not a stale orphan
async function arenaReady(arena) {
  for (let i = 0; i < 50; i++) {
    if (arena._died) throw new Error('arena failed to start: ' + arena._died);
    const got = await new Promise((res) => {
      const ws = new WebSocket(WS_URL);
      const done = (v) => { try { ws.close(); } catch {} res(v); };
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'probe' })));
      ws.on('message', (b) => { try { done(JSON.parse(b).t === 'welcome'); } catch { done(false); } });
      ws.on('error', () => done(false));
      setTimeout(() => done(false), 400);
    });
    if (got) return;
    await sleep(150);
  }
  throw new Error('arena never answered on ' + WS_URL);
}

const results = {};
let browser;
try {
  spawnProc('node', ['tools/static.mjs'], { PORT: String(STATIC_PORT) });
  const arena = spawnProc('node', ['server/server.mjs'], { STARFRAG_PORT: String(WS_PORT), STARFRAG_HOST: '127.0.0.1', STARFRAG_MAP: 'deck7-derelict' });
  // poll the static server until it answers (readiness beats a fixed sleep)
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${STATIC_PORT}/index.html`); if (r.ok) break; } catch {}
    if (i === 39) throw new Error('static server never came up on ' + STATIC_PORT);
    await sleep(150);
  }
  await arenaReady(arena);   // hard-fail if an orphan holds the arena port

  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 768, height: 480 } });
  const P = await ctx.newPage();
  P.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const waitFor = async (fn, timeout = 15000, label = '') => {
    const t = Date.now();
    while (Date.now() - t < timeout) { if (await P.evaluate(fn).catch(() => false)) return true; await sleep(120); }
    throw new Error('timeout waiting for ' + label);
  };

  await P.goto(`http://localhost:${STATIC_PORT}/?name=railer&ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => window.__game && __game.connected, 15000, 'connect');
  await P.evaluate(() => __game.start());
  results.startWeapon = await P.evaluate(() => __game.weapon);           // 'carbine'

  // 1. grab the railgun — server-authoritative (we only stream position)
  await P.evaluate((pad) => __game.teleport(pad.x, pad.y, pad.ang), PAD);
  await waitFor(() => __game.weapon === 'railgun', 6000, 'railgun pickup grant');
  results.pickedUp = await P.evaluate(() => __game.weapon);             // 'railgun'
  results.clipFull = await P.evaluate(() => __game.clip);               // 3
  await sleep(300);
  await P.screenshot({ path: join(DOCS, 'railgun-idle.png') });

  // 2. HOLD to charge — ring + muzzle glow build; chargeFrac climbs
  await P.evaluate(() => __game.teleport(16, 13, Math.PI / 2));
  await P.evaluate(() => __game.charge());
  await sleep(80);                                                      // let one frame start the charge (rAF)
  results.chargingOn = await P.evaluate(() => __game.charging);         // true
  await sleep(570);                                                     // ~mid charge (total ~650ms held)
  results.midFrac = await P.evaluate(() => +__game.chargeFrac.toFixed(2));
  await P.screenshot({ path: join(DOCS, 'railgun-charge-mid.png') });
  await sleep(700);                                                     // past fullMs (1100)
  results.fullFrac = await P.evaluate(() => +__game.chargeFrac.toFixed(2));  // ~1
  await P.screenshot({ path: join(DOCS, 'railgun-charge-full.png') });

  // 3. RELEASE at full — a rail fires, a round leaves the clip
  const clipBefore = await P.evaluate(() => __game.clip);
  await P.evaluate(() => __game.release());
  await sleep(70);                                                      // beam life ~0.26s
  results.beamsAfterFull = await P.evaluate(() => __game.beams);        // >=1
  await P.screenshot({ path: join(DOCS, 'railgun-fire.png') });
  results.clipAfterFull = await P.evaluate(() => __game.clip);          // clipBefore-1
  results.fullShotSpentAmmo = results.clipAfterFull === clipBefore - 1;
  results.chargingOffAfter = await P.evaluate(() => __game.charging);   // false

  // 4. anti-fizzle: a sub-min tap must cost no ammo + draw no beam
  await sleep(400);
  const clipBeforeTap = await P.evaluate(() => __game.clip);
  await P.evaluate(() => __game.charge());
  await sleep(90);                                                      // < charge.minMs (250)
  await P.evaluate(() => __game.release());
  await sleep(60);
  results.clipAfterTap = await P.evaluate(() => __game.clip);
  results.tapSpentNoAmmo = results.clipAfterTap === clipBeforeTap;
  results.tapNoBeam = (await P.evaluate(() => __game.beams)) === 0;

  // 5. BEAM proof: a dead-ahead rail foreshortens to a dot, so shoot down a long open
  //    lane — the west core edge (11.6,13) facing EAST has a clean ~9-cell lane north of
  //    the reactor, so the rail streaks across the view. (pierce itself is proven in
  //    railgun-test.mjs; this is the money shot.) Reuse P — it owns the railgun.
  await sleep(400);
  await P.evaluate(() => { __game.teleport(11.6, 13, 0); __game.charge(); });
  await sleep(1250);                                                    // full charge
  await P.evaluate(() => __game.release());
  await sleep(90);                                                      // catch the rail flash mid-life
  results.beamShot = await P.evaluate(() => __game.beams);
  await P.screenshot({ path: join(DOCS, 'railgun-beam.png') });

  // 6. mobile-landscape (awfml QA): the viewmodel must stay LOW on a wide-short aspect.
  //    Reuse P (owns the railgun) resized — avoids the pickup contention of a 2nd client.
  await sleep(300);
  await P.setViewportSize({ width: 812, height: 375 });
  await sleep(200);
  await P.evaluate(() => { __game.teleport(16, 13, Math.PI / 2); __game.charge(); });
  await sleep(950);
  await P.screenshot({ path: join(DOCS, 'railgun-mobile-charge.png') });
  await P.evaluate(() => __game.release());
  await sleep(60);
  await P.screenshot({ path: join(DOCS, 'railgun-mobile-fire.png') });

  results.pass = results.pickedUp === 'railgun' && results.chargingOn === true
    && results.fullFrac >= 0.95 && results.beamsAfterFull >= 1 && results.fullShotSpentAmmo
    && results.chargingOffAfter === false && results.tapSpentNoAmmo && results.tapNoBeam;

  console.log('\n=== STARFRAG RAILGUN CLIENT VERIFY ===');
  console.log(JSON.stringify(results, null, 2));
  console.log('proof shots -> docs/railgun-*.png');
  await browser.close();
  cleanup();
  process.exit(results.pass ? 0 : 1);
} catch (e) {
  console.error('RAILGUN VERIFY ERROR:', e.message);
  console.log(JSON.stringify(results, null, 2));
  if (browser) await browser.close().catch(() => {});
  cleanup();
  process.exit(2);
}
