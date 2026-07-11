// STARFRAG — LIVE powerup verification (deck7v2). Drives two headless clients against the
// live server: a CARRIER camps the quad pad and grabs it in its telegraph window, a VIEWER
// looks at the carrier and confirms the purple quad tint. Proves, on the real deployment:
//   - the QUAD grab is server-granted (carrier __game.quadMs > 0, from STATE),
//   - the holder HUD shows the QUAD DAMAGE countdown + the armor readout is wired,
//   - every other client sees the carrier flagged (viewer snapshot: carrier.quad > 0).
// Saves proof screenshots to docs/. One browser, two pages (single chromium process).
//   node tools/powerups-verify.mjs [baseUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const BASE = process.argv[2] || 'https://bmo.ryanboye.com/starfrag/';
const DOCS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'docs');
mkdirSync(DOCS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUAD_PAD = { x: 2.5, y: 12.5 };
const CARRIER_SPOT = { x: 2.5, y: 12.5, ang: -1.57 };   // on the pad, facing north
const VIEWER_SPOT = { x: 2.5, y: 14.5, ang: -1.57 };    // 2 cells south, looking north at the pad
const results = {};

const urlFor = (name) => { const u = new URL(BASE); u.searchParams.set('map', 'deck7v2'); u.searchParams.set('name', name); return u.toString(); };
async function waitFor(page, fn, timeout = 20000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await page.evaluate(fn).catch(() => false)) return true; await sleep(150); }
  throw new Error('timeout waiting for ' + label);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 768, height: 480 } });
  const C = await ctx.newPage(), V = await ctx.newPage();
  C.on('pageerror', (e) => console.log('CARRIER PAGEERROR', e.message));
  V.on('pageerror', (e) => console.log('VIEWER PAGEERROR', e.message));

  await C.goto(urlFor('QUADCARRIER'), { waitUntil: 'domcontentloaded' });
  await V.goto(urlFor('QUADWATCH'), { waitUntil: 'domcontentloaded' });
  await waitFor(C, () => window.__game && __game.connected, 20000, 'carrier connect');
  await waitFor(V, () => window.__game && __game.connected, 20000, 'viewer connect');
  await C.evaluate(() => __game.start());
  await V.evaluate(() => __game.start());
  results.mapId = await C.evaluate(() => __game.mapId);
  results.hasQuadTelegraph = await C.evaluate(() => !!__game.quad);

  // park both: carrier ON the pad, viewer 2 cells south looking north at it
  const park = async () => {
    await C.evaluate((s) => __game.teleport(s.x, s.y, s.ang), CARRIER_SPOT);
    await V.evaluate((s) => __game.teleport(s.x, s.y, s.ang), VIEWER_SPOT);
  };
  await park();

  // wait for a telegraph window + the server grant (camp on the pad so we beat the bots);
  // retry across windows for up to ~75s in case a bot grabs it first.
  const deadline = Date.now() + 75000;
  let got = false;
  while (Date.now() < deadline && !got) {
    await park();
    const ready = await C.evaluate(() => __game.quad && __game.quad.ready);
    if (ready) {
      for (let i = 0; i < 20 && !got; i++) {           // hold on the pad through a few ticks
        await park(); await sleep(150);
        got = await C.evaluate(() => (__game.quadMs || 0) > 0);
      }
    }
    if (!got) await sleep(400);
  }
  results.carrierQuadMs = await C.evaluate(() => __game.quadMs || 0);
  results.grabbed = got;

  // let a couple of STATE frames land so the viewer sees the carrier's quad flag + tint
  await sleep(500);
  const myId = await C.evaluate(() => __game.id);
  results.viewerSeesCarrierQuad = await V.evaluate((id) => {
    const c = __game.snapshot().find((p) => p.id === id); return c ? (c.quad || 0) : 0;
  }, myId);
  results.carrierArmorHudPresent = await C.evaluate(() => !!document.getElementById('armorwrap'));
  results.holderClock = await C.evaluate(() => (document.getElementById('quadclock') || {}).textContent || '');

  await C.screenshot({ path: join(DOCS, 'powerup-quad-holder-hud.png') });   // carrier POV: QUAD DAMAGE countdown HUD
  await V.screenshot({ path: join(DOCS, 'powerup-quad-carrier-tint.png') });  // viewer sees the carrier tinted purple

  results.pass = results.mapId === 'deck7v2' && results.hasQuadTelegraph
    && results.grabbed && results.carrierQuadMs > 0
    && results.viewerSeesCarrierQuad > 0
    && /QUAD DAMAGE/.test(results.holderClock);
  console.log('\n=== STARFRAG POWERUP LIVE VERIFY ===');
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(results.pass ? 0 : 1);
} catch (e) {
  console.error('POWERUP LIVE VERIFY ERROR:', e.message);
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(2);
}
