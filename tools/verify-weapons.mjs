// STARFRAG — weapon pickup + switch + animation verification.
// Drives ONE real headless client against a running arena and checks:
//   1. connect + join
//   2. walk onto a weapon pickup pad -> the server GRANTS + switches the weapon
//      (server-authoritative: we only move; the server decides the grab)
//   3. the picked-up viewmodel renders + FIRES (fireT advances, ammo drops)
//   4. RELOAD plays: __game.reloading is true and several frames across the cycle
//      are captured so the video-derived animation is eyeballable.
// Saves proof screenshots to docs/. Exits non-zero on any hard failure.
//
//   node tools/verify-weapons.mjs [baseUrl] [wsUrl]
//   node tools/verify-weapons.mjs https://bmo.ryanboye.com/starfrag/
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const BASE = process.argv[2] || 'https://bmo.ryanboye.com/starfrag/';
const WS = process.argv[3] || process.env.STARFRAG_WS || '';
const DOCS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'docs');
mkdirSync(DOCS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const urlFor = (name) => {
  const u = new URL(BASE);
  u.searchParams.set('name', name);
  if (WS) u.searchParams.set('ws', WS);
  return u.toString();
};
async function waitFor(page, fn, arg, timeout = 15000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(150);
  }
  throw new Error('timeout waiting for ' + label);
}

// Scatter pickup pad on deck7 (shared/map.js -> weapon-scatter). Stand on it.
const PAD = { x: 15.5, y: 3, ang: 1.55 };   // face south into the gallery
const results = {};
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 768, height: 480 } });
  const P = await ctx.newPage();
  P.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  await P.goto(urlFor('gunner'), { waitUntil: 'domcontentloaded' });
  await waitFor(P, () => window.__game && __game.connected, null, 15000, 'connect');
  await P.evaluate(() => __game.start());
  results.startWeapon = await P.evaluate(() => __game.weapon);   // expect 'carbine'

  // 2. walk onto the pad; the client streams position, the server grants the weapon
  await P.evaluate((pad) => __game.teleport(pad.x, pad.y, pad.ang), PAD);
  await waitFor(P, () => __game.weapon === 'scatter', null, 6000, 'scatter pickup grant');
  results.pickedUp = await P.evaluate(() => __game.weapon);            // 'scatter'
  results.owned = await P.evaluate(() => __game.owned);                // ['carbine','scatter']
  await sleep(500);
  await P.screenshot({ path: join(DOCS, 'weapon-scatter-idle.png') });

  // 3. fire it — fireT must advance and the clip must drop
  const fireT0 = await P.evaluate(() => __game.fireT);
  const clip0 = await P.evaluate(() => __game.clip);
  await P.evaluate(() => __game.fire());
  await sleep(150);   // ~mid fire strip: catch the muzzle flash + ejecting shell casings
  await P.screenshot({ path: join(DOCS, 'weapon-scatter-fire.png') });
  await sleep(120);
  const fireT1 = await P.evaluate(() => __game.fireT);
  const clip1 = await P.evaluate(() => __game.clip);
  results.fireTAdvanced = fireT1 > fireT0;
  results.clipDropped = clip1 < clip0;
  results.clipAfterFire = clip1;

  // 4. reload — capture several frames across the ~1.5s cycle (video-derived anim)
  await P.evaluate(() => __game.reload());
  results.reloadingSet = await P.evaluate(() => __game.reloading);
  const beats = [220, 520, 820, 1180];
  let prev = 0;
  for (let i = 0; i < beats.length; i++) {
    await sleep(beats[i] - prev); prev = beats[i];
    await P.screenshot({ path: join(DOCS, `weapon-scatter-reload-${i}.png`) });
  }
  await sleep(400);
  results.clipAfterReload = await P.evaluate(() => __game.clip);        // full again (6)

  // 5. PLASMA: walk onto the second pad -> server grants + switches; fire + reload
  const PPAD = { x: 2.5, y: 15.5, ang: 0 };   // deck7 weapon-plasma (west conduit)
  await P.evaluate((p) => __game.teleport(p.x, p.y, p.ang), PPAD);
  await waitFor(P, () => __game.weapon === 'plasma', null, 6000, 'plasma pickup grant');
  results.plasmaPickedUp = await P.evaluate(() => __game.weapon);       // 'plasma'
  results.ownedAll = await P.evaluate(() => __game.owned);              // carbine+scatter+plasma
  await sleep(400);
  await P.screenshot({ path: join(DOCS, 'weapon-plasma-idle.png') });
  await P.evaluate(() => __game.fire());
  await sleep(70);
  await P.screenshot({ path: join(DOCS, 'weapon-plasma-fire.png') });
  await P.evaluate(() => __game.reload());
  {
    const beats = [320, 680, 1180];   // cell-swap -> seat -> recharge-arc frames
    let prev = 0;
    for (let i = 0; i < beats.length; i++) { await sleep(beats[i] - prev); prev = beats[i]; await P.screenshot({ path: join(DOCS, `weapon-plasma-reload-${i}.png`) }); }
  }
  await sleep(500);
  results.plasmaClipAfterReload = await P.evaluate(() => __game.clip);

  // 6. switch back to the carbine (number-key path exercises the same switchWeapon)
  await P.evaluate(() => __game.switchWeapon('carbine'));
  await sleep(300);
  results.switchedBack = await P.evaluate(() => __game.weapon);         // 'carbine'
  await P.screenshot({ path: join(DOCS, 'weapon-carbine-back.png') });

  results.pass = results.pickedUp === 'scatter' && results.fireTAdvanced
    && results.clipDropped && results.reloadingSet
    && results.clipAfterReload >= results.clipAfterFire
    && results.plasmaPickedUp === 'plasma' && results.switchedBack === 'carbine';
  console.log('\n=== STARFRAG WEAPON VERIFY ===');
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(results.pass ? 0 : 1);
} catch (e) {
  console.error('WEAPON VERIFY ERROR:', e.message);
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(2);
}
