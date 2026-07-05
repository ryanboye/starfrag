// STARFRAG — MOBILE twin-stick verification harness (companion to verify.mjs / obj-test.mjs).
//
// Proves the pocket controls actually drive the game on a touchscreen viewport, and
// captures the 390px capture->vent proof for the airlock win-mode:
//   1. controls install on a coarse-pointer device + hide until in-play
//   2. LOOK drag turns the camera (me.ang moves the expected direction/magnitude)
//   3. MOVE stick walks the player (position advances while held, stops on release)
//   4. MULTI-TOUCH: move + look simultaneously (both change in one gesture)
//   5. FIRE button + tap-to-fire in the look-zone spawn shots
//   6. screenshots: portrait controls, landscape controls, and a real capture->vent
//      (4 ws clients drive the hangar consoles while a phone client renders the vent)
//
//   BASE=http://localhost:8080/ WS=ws://127.0.0.1:8802 node tools/mobile-verify.mjs
import { chromium, devices } from 'playwright';
import WebSocket from 'ws';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const BASE = process.env.BASE || 'http://localhost:8080/';
const WS = process.env.WS || 'ws://127.0.0.1:8802';
const DOCS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'docs');
mkdirSync(DOCS, { recursive: true });
const CONSOLES = [{ x: 5.5, y: 10.5 }, { x: 26.5, y: 10.5 }, { x: 5.5, y: 21.5 }, { x: 26.5, y: 21.5 }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const urlFor = (name) => `${BASE}?name=${name}&ws=${encodeURIComponent(WS)}&map=hangar-bay&touch=1`;

async function waitFor(page, fn, arg, timeout = 15000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(150);
  }
  throw new Error('timeout waiting for ' + label);
}

// CDP touch helpers — real OS-level touch so the client's touch listeners fire.
const mkTouch = (cdp) => ({
  start: (pts) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts }),
  move: (pts) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts }),
  end: (pts = []) => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: pts }),
});

// Park 4 ws clients on the consoles to drive the server capture->vent (like obj-test).
function parkBots() {
  const bots = [];
  CONSOLES.forEach((spot, i) => {
    const ws = new WebSocket(WS);
    ws.on('error', () => {});
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'join', name: `cap${i}` }));
      const iv = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'move', x: spot.x, y: spot.y, ang: 0, moving: 0 })); }, 80);
      bots.push({ ws, iv });
    });
  });
  return () => bots.forEach((b) => { clearInterval(b.iv); try { b.ws.close(); } catch {} });
}

const results = {};
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  // -------------------------------------------------- PORTRAIT: controls + input
  const ctxP = await browser.newContext({ ...devices['iPhone 13'] });   // 390x844, hasTouch, isMobile
  const P = await ctxP.newPage();
  P.on('pageerror', (e) => console.log('[PHONE] PAGEERROR', e.message));
  const cdpP = await ctxP.newCDPSession(P);
  const touchP = mkTouch(cdpP);

  await P.goto(urlFor('phone'), { waitUntil: 'domcontentloaded' });
  await waitFor(P, () => window.__game && __game.connected, null, 15000, 'phone connected');
  results.mediaCoarse = await P.evaluate(() => !!(window.matchMedia && matchMedia('(pointer: coarse)').matches));
  results.maxTouchPoints = await P.evaluate(() => navigator.maxTouchPoints);

  // controls hidden before start, visible after
  results.hiddenBeforeStart = await P.evaluate(() => { const tc = document.getElementById('tc'); return !tc || tc.style.display === 'none'; });
  await touchP.start([{ x: 195, y: 422, id: 9 }]); await touchP.end();      // tap to enter
  await sleep(300);
  await waitFor(P, () => __game && __game.id != null, null, 8000, 'spawned');
  results.controlsVisible = await P.evaluate(() => {
    const tc = document.getElementById('tc');
    return !!(tc && tc.style.display === 'block' && tc.querySelector('.fire') && tc.querySelector('.reload') && tc.querySelector('.mark'));
  });

  // LOOK: drag right-half left by 100px -> yaw decreases ~ 100*0.006 = 0.6 rad
  const yaw0 = await P.evaluate(() => __game.yaw);
  await touchP.start([{ x: 300, y: 420, id: 1 }]);
  for (let x = 300; x >= 200; x -= 20) { await touchP.move([{ x, y: 420, id: 1 }]); await sleep(16); }
  await touchP.end();
  const yaw1 = await P.evaluate(() => __game.yaw);
  results.lookDelta = +(yaw1 - yaw0).toFixed(3);
  results.lookWorks = Math.abs(results.lookDelta + 0.6) < 0.35;   // sign + rough magnitude

  // MOVE: from a known-open cell (a console) facing the open arena centre, hold the
  // left-stick up -> player advances. Sample all four consoles so a wall in one
  // heading can't mask a working stick; the stick must also hide on release.
  let bestMove = 0, stickHid = false;
  for (const c of CONSOLES) {
    const ang = Math.atan2(16 - c.y, 16 - c.x);   // face arena centre (open floor)
    await P.evaluate((v) => __game.teleport(v.x, v.y, v.a), { x: c.x, y: c.y, a: ang });
    await sleep(60);
    const p0 = await P.evaluate(() => ({ x: __game.x, y: __game.y }));
    await touchP.start([{ x: 90, y: 650, id: 2 }]);
    await touchP.move([{ x: 90, y: 555, id: 2 }]);                // push full-forward
    await sleep(450);
    const p1 = await P.evaluate(() => ({ x: __game.x, y: __game.y }));
    await touchP.end([]);
    await sleep(120);
    stickHid = await P.evaluate(() => { const s = document.querySelector('#tc .stick'); return !s || s.style.display === 'none'; });
    bestMove = Math.max(bestMove, Math.hypot(p1.x - p0.x, p1.y - p0.y));
  }
  results.moveDist = +bestMove.toFixed(3);
  results.moveWorks = bestMove > 0.4;
  results.stickHidesOnRelease = stickHid;

  // MULTI-TOUCH: move (id2) + look (id3) at the same time — both must change
  const yawM0 = await P.evaluate(() => __game.yaw);
  const posM0 = await P.evaluate(() => ({ x: __game.x, y: __game.y }));
  await touchP.start([{ x: 90, y: 650, id: 2 }]);
  await touchP.start([{ x: 300, y: 300, id: 3 }]);
  for (let k = 0; k < 6; k++) {
    await touchP.move([{ x: 90, y: 560, id: 2 }, { x: 300 + k * 14, y: 300, id: 3 }]);
    await sleep(16);
  }
  const yawM1 = await P.evaluate(() => __game.yaw);
  const posM1 = await P.evaluate(() => ({ x: __game.x, y: __game.y }));
  results.multiTouch = Math.abs(yawM1 - yawM0) > 0.1 && Math.hypot(posM1.x - posM0.x, posM1.y - posM0.y) > 0.1;
  // capture the stick + look live for the portrait proof shot
  await P.screenshot({ path: join(DOCS, 'mobile-portrait.png') });
  await touchP.end([{ x: 300 + 5 * 14, y: 300, id: 3 }]);
  await touchP.end();

  // FIRE — assert via me.fireT (monotonic; advances only on a shot fire() let through),
  // robust to transient plasma bolts despawning on a wall-hit before we can sample.
  await P.evaluate(() => __game.teleport(16, 16, 0));   // open centre, alive
  await sleep(80);
  const fireT0 = await P.evaluate(() => __game.fireT);
  const fb = await P.evaluate(() => { const r = document.querySelector('#tc .fire').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await touchP.start([{ x: fb.x, y: fb.y, id: 4 }]);    // hold FIRE across several frames
  await sleep(420);
  await touchP.end([]);
  const fireT1 = await P.evaluate(() => __game.fireT);
  results.fireBtnWorks = fireT1 > fireT0;
  await sleep(450);   // clear the fire-rate window
  // TAP-TO-FIRE in the look zone (quick tap, no drag) — retry to dodge the cooldown
  let fireT2 = fireT1;
  for (let i = 0; i < 5 && fireT2 <= fireT1; i++) {
    await touchP.start([{ x: 320, y: 400, id: 5 }]); await sleep(50); await touchP.end([]);
    await sleep(300);
    fireT2 = await P.evaluate(() => __game.fireT);
  }
  results.tapFireWorks = fireT2 > fireT1;

  await ctxP.close();

  // -------------------------------------------------- LANDSCAPE: controls + capture->vent
  const land = { ...devices['iPhone 13 landscape'] };
  const ctxL = await browser.newContext(land);
  const L = await ctxL.newPage();
  L.on('pageerror', (e) => console.log('[LAND] PAGEERROR', e.message));
  const cdpL = await ctxL.newCDPSession(L);
  const touchL = mkTouch(cdpL);
  await L.goto(urlFor('phoneL'), { waitUntil: 'domcontentloaded' });
  await waitFor(L, () => window.__game && __game.connected, null, 15000, 'landscape connected');
  await touchL.start([{ x: 422, y: 195, id: 9 }]); await touchL.end();
  await sleep(400);
  await L.screenshot({ path: join(DOCS, 'mobile-landscape.png') });

  // drive the server through capture -> vent; screenshot the phone at 'venting'
  const phases = new Set();
  const stopBots = parkBots();
  let sawVent = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 13000) {
    const banner = await L.evaluate(() => (document.getElementById('objective')?.textContent || '')).catch(() => '');
    if (/ARM|CONSOLE/i.test(banner)) phases.add('arming');
    if (/VENT|WINS/i.test(banner)) { phases.add('venting'); sawVent = true; await L.screenshot({ path: join(DOCS, 'mobile-vent.png') }); break; }
    await sleep(150);
  }
  stopBots();
  results.sawArming = phases.has('arming');
  results.sawVenting = sawVent;
  await ctxL.close();

  results.pass = results.controlsVisible && results.hiddenBeforeStart && results.lookWorks && results.moveWorks
    && results.stickHidesOnRelease && results.multiTouch && results.fireBtnWorks && results.tapFireWorks && results.sawVenting;
  console.log('\n=== STARFRAG MOBILE VERIFY ===');
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(results.pass ? 0 : 1);
} catch (e) {
  console.error('MOBILE VERIFY ERROR:', e.message);
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(2);
}
