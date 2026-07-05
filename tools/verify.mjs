// STARFRAG — 2-client verification harness.
// Launches two REAL headless clients against a running arena and checks:
//   1. both connect + join and SEE each other (cross-client state propagation)
//   2. positions propagate (teleport one, the other sees it move)
//   3. an authoritative shot registers DAMAGE + a FRAG on the victim/shooter
// Saves proof screenshots. Exits non-zero if any check fails.
//
//   node tools/verify.mjs [baseUrl] [wsUrl]
//   node tools/verify.mjs http://localhost:8080/ ws://localhost:8791
//   node tools/verify.mjs https://bmo.ryanboye.com/starfrag/
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const BASE = process.argv[2] || 'https://bmo.ryanboye.com/starfrag/';
const WS = process.argv[3] || process.env.STARFRAG_WS || '';
const DOCS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'docs');
mkdirSync(DOCS, { recursive: true });

const urlFor = (name) => {
  const u = new URL(BASE);
  u.searchParams.set('name', name);
  if (WS) u.searchParams.set('ws', WS);
  return u.toString();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, timeout = 15000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + label);
}

const results = {};
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 768, height: 480 } });
  const A = await ctx.newPage();
  const B = await ctx.newPage();
  for (const [p, n] of [[A, 'ALPHA'], [B, 'BRAVO']]) {
    p.on('console', (m) => console.log(`[${n}] ${m.text()}`));
    p.on('pageerror', (e) => console.log(`[${n}] PAGEERROR ${e.message}`));
  }

  await A.goto(urlFor('alpha'), { waitUntil: 'domcontentloaded' });
  await B.goto(urlFor('bravo'), { waitUntil: 'domcontentloaded' });

  // 1. both connect + see 2 players
  await waitFor(A, () => window.__game && __game.connected && __game.players >= 2, 15000, 'A sees 2 players');
  await waitFor(B, () => window.__game && __game.connected && __game.players >= 2, 15000, 'B sees 2 players');
  results.bothConnected = true;
  const idA = await A.evaluate(() => __game.id);
  const idB = await B.evaluate(() => __game.id);
  // dismiss the click-to-start overlay so screenshots show the actual arena
  await A.evaluate(() => __game.start());
  await B.evaluate(() => __game.start());

  // 2a. HERO pose: A looks north through the gallery window; B stands just off to
  //     the right, close enough to read clearly (not hidden by the gun).
  await A.evaluate(() => __game.teleport(11, 13, -Math.PI / 2));
  await B.evaluate(() => __game.teleport(12, 6, Math.PI / 2));
  await sleep(700);
  await A.screenshot({ path: join(DOCS, 'verify-arena.png') });
  await A.screenshot({ path: join(DOCS, 'verify-enemy.png'), clip: { x: 400, y: 150, width: 220, height: 220 } });
  await B.screenshot({ path: join(DOCS, 'verify-clientB.png') });

  // 2b. teleport into a CLEAR straight sightline (column x=11 is open to the
  //     north gallery — no cover between) and confirm it propagates cross-client.
  await A.evaluate(() => __game.teleport(11, 10, -Math.PI / 2)); // at (11,10) facing north
  await B.evaluate(() => __game.teleport(11, 5, Math.PI / 2));   // 5m ahead of A
  await sleep(800); // a few server ticks
  const aSeesB = await A.evaluate((id) => __game.snapshot().find((p) => p.id === id), idB);
  const bSeesA = await B.evaluate((id) => __game.snapshot().find((p) => p.id === id), idA);
  results.crossVisible = !!(aSeesB && bSeesA);
  results.aSeesB = aSeesB && { x: +aSeesB.x.toFixed(1), y: +aSeesB.y.toFixed(1) };
  results.bSeesA = bSeesA && { x: +bSeesA.x.toFixed(1), y: +bSeesA.y.toFixed(1) };
  results.positionsPropagated = !!(aSeesB && Math.hypot(aSeesB.x - 11, aSeesB.y - 5) < 1.0
    && bSeesA && Math.hypot(bSeesA.x - 11, bSeesA.y - 10) < 1.0);

  // 3. authoritative shot: A fires at B, B must take damage; a kill = a frag for A
  const hpBefore = await B.evaluate(() => __game.hp);
  let minHp = hpBefore;
  for (let i = 0; i < 7; i++) {
    await A.evaluate(() => __game.fire());
    await sleep(160);
    minHp = Math.min(minHp, await B.evaluate(() => __game.hp));
  }
  await sleep(400);
  const fragsA = await A.evaluate(() => __game.frags);
  results.hpBefore = hpBefore;
  results.minHpAfter = minHp;
  results.damageRegistered = minHp < hpBefore;
  results.fragsA = fragsA;
  results.fragRegistered = fragsA >= 1;
  await A.screenshot({ path: join(DOCS, 'verify-postfrag.png') });

  results.pass = results.bothConnected && results.crossVisible && results.positionsPropagated
    && results.damageRegistered && results.fragRegistered;
  console.log('\n=== STARFRAG VERIFY ===');
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(results.pass ? 0 : 1);
} catch (e) {
  console.error('VERIFY ERROR:', e.message);
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(2);
}
