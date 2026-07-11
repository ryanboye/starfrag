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

  // Camp the carrier on the quad pad through a telegraph window and grab it; retry across windows
  // (beat the bots) up to `deadlineMs`. Returns the ms of quad the carrier ended up holding (0 = never).
  async function grabQuad(deadlineMs = 75000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      await park();
      if (await C.evaluate(() => __game.quad && __game.quad.ready)) {
        for (let i = 0; i < 20; i++) {
          await park(); await sleep(150);
          if (await C.evaluate(() => (__game.quadMs || 0) > 0)) return C.evaluate(() => __game.quadMs || 0);
        }
      }
      await sleep(400);
    }
    return C.evaluate(() => __game.quadMs || 0);
  }
  results.carrierQuadMs = await grabQuad();
  results.grabbed = results.carrierQuadMs > 0;

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

  // ---- THE SYMMETRIC TRADE (live) — the quad-carrier walks onto an armor pad. Armor must apply
  // AND the quad must END the instant it lands (a body holds quad OR a defensive, never both):
  // the "◈ QUAD SPENT — ARMOR UP" toast fires, the holder clock clears, and every viewer's purple
  // tint drops (carrier.quad -> 0). The toast is the DEFINITIVE proof it's a trade, not expiry.
  //
  // The doc screenshots above are ~10s each under swiftshader and expired the first quad, so
  // RE-GRAB a fresh quad here (right before the trade) and keep the trade path screenshot-free
  // until the toast is captured — otherwise the 22s quad bleeds out before the armor grab.
  results.preTradeQuadMs = await grabQuad();
  await C.evaluate(() => __game.teleport(2.5, 12.5, -1.57));        // step off the quad pad before heading for the defensive
  // deck7v2 defensives: the armor pad (dock, S) is the target; the mega pad (cargo) is a fallback
  // if a bot is camping armor. Either spends the quad — both toasts match /QUAD SPENT/.
  const DEF_COORD = { 'pickup-dock-armor': [17.5, 28.5], 'pickup-cargo-mega': [25.5, 13.5] };
  const hasDef = () => C.evaluate(() => (__game.armor || 0) > 0 || (__game.hp || 0) > 100);
  let tradeToast = '', tGrab = 0, shot = false;
  const t0Trade = Date.now(), tEnd = t0Trade + 15000;
  while (Date.now() < tEnd && !(await hasDef())) {
    const pad = await C.evaluate((coord) => {                       // prefer an available ARMOR pad; fall back to mega
      const up = __game.items().filter((it) => !it.taken && coord[it.id]);
      const a = up.find((it) => it.kind === 'armor') || up.find((it) => it.kind === 'mega');
      return a ? { id: a.id, kind: a.kind, x: coord[a.id][0], y: coord[a.id][1] } : null;
    }, DEF_COORD);
    if (pad) { results.defPad = pad; await C.evaluate((p) => __game.teleport(p.x, p.y, 0), pad); }
    await sleep(120);
    const t = await C.evaluate(() => __game.toast || '');           // catch the toast the instant it fires
    if (/QUAD SPENT/.test(t)) {
      tradeToast = t; if (!tGrab) tGrab = Date.now();
      // grab the proof shot NOW while the toast is still on the HUD (it lasts ~2.2s; the screenshot
      // captures the current frame even though swiftshader takes ~10s to encode+return).
      if (!shot) { shot = true; await C.screenshot({ path: join(DOCS, 'powerup-trade-toast.png') }); }  // "◈ QUAD SPENT — …" + armor/HP HUD up
    }
  }
  // the grab may have landed on the loop's exit check — re-poll the toast through the rest of its ~2.2s life
  for (let i = 0; i < 14 && !tradeToast; i++) {
    const t = await C.evaluate(() => __game.toast || '');
    if (/QUAD SPENT/.test(t)) { tradeToast = t; if (!tGrab) tGrab = Date.now(); if (!shot) { shot = true; await C.screenshot({ path: join(DOCS, 'powerup-trade-toast.png') }); } }
    await sleep(120);
  }
  await sleep(400);                                                 // let a STATE frame land so quad->0 reaches the viewer
  results.postTradeArmor = await C.evaluate(() => __game.armor || 0);
  results.postTradeHp = await C.evaluate(() => __game.hp || 0);
  results.postTradeQuadMs = await C.evaluate(() => __game.quadMs || 0);
  results.tradeToast = tradeToast;                                   // transient DOM toast (best-effort; may be overwritten)
  results.lastTrade = await C.evaluate(() => __game.lastTrade);      // sticky trade record — the robust proof
  results.tradeLatencyMs = tGrab ? tGrab - t0Trade : null;          // quad-grab -> trade fire; well under the 22s quad life
  results.holderClockAfter = await C.evaluate(() => (document.getElementById('quadclock') || {}).textContent || '');
  results.viewerSeesQuadAfter = await V.evaluate((id) => {
    const c = __game.snapshot().find((p) => p.id === id); return c ? (c.quad || 0) : -1;
  }, myId);

  results.tradeFired = results.preTradeQuadMs > 0 && (results.postTradeArmor > 0 || results.postTradeHp > 100) && results.postTradeQuadMs === 0;
  // definitive: the client fired a SYMMETRIC-TRADE toast (traded a live quad for the defensive) — expiry/death produce none
  results.tradeToastOk = !!(results.lastTrade && results.lastTrade.traded === 'quad' && /QUAD SPENT/.test(results.lastTrade.text));
  results.tradeTintDropped = results.viewerSeesQuadAfter === 0;      // the purple tint dropped for other players

  results.pass = results.mapId === 'deck7v2' && results.hasQuadTelegraph
    && results.grabbed && results.carrierQuadMs > 0
    && results.viewerSeesCarrierQuad > 0
    && /QUAD DAMAGE/.test(results.holderClock)
    && results.tradeFired && results.tradeToastOk && results.tradeTintDropped;
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
