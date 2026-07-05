// STARFRAG — 8-way directional-sprite verification.
// Two real headless clients against the live arena: A (observer) looks at B
// (the "enemy"). We sweep B's server yaw through 8 evenly-spaced facings and
// screenshot A each time, so the trooper billboard should cycle S->SE->E->NE->
// N->NW->W->SW as B turns. Proof shots land in docs/dir8-*.png.
//   node tools/verify-dir8.mjs [baseUrl] [wsUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const BASE = process.argv[2] || 'https://bmo.ryanboye.com/starfrag/';
const WS = process.argv[3] || process.env.STARFRAG_WS || '';
const DOCS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'docs');
mkdirSync(DOCS, { recursive: true });
const urlFor = (name) => { const u = new URL(BASE); u.searchParams.set('name', name); if (WS) u.searchParams.set('ws', WS); return u.toString(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, timeout = 15000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await page.evaluate(fn).catch(() => false)) return true; await sleep(200); }
  throw new Error('timeout waiting for ' + label);
}

// Fixed geometry: A observes from the south, B stands north in the clear x~11/12
// column open to the gallery. angToViewer (from B to A) is baked from these coords.
const A_POS = { x: 11, y: 14 };
const B_POS = { x: 11, y: 9 };  // dead north of A, distance 5, so B renders centered
const angToViewer = Math.atan2(A_POS.y - B_POS.y, A_POS.x - B_POS.x); // B -> A
const A_ANG = Math.atan2(B_POS.y - A_POS.y, B_POS.x - A_POS.x);       // A faces B (due north)
const VIEWS = ['S(front)', 'SE', 'E(right)', 'NE', 'N(back)', 'NW', 'W(left)', 'SW'];
const clip = { x: 330, y: 40, width: 240, height: 420 }; // tight center column = B only

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 520 } });
  const A = await ctx.newPage(), B = await ctx.newPage();
  A.on('pageerror', (e) => console.log('[A] ERR', e.message));
  await A.goto(urlFor('observer'), { waitUntil: 'domcontentloaded' });
  await B.goto(urlFor('enemy'), { waitUntil: 'domcontentloaded' });
  await waitFor(A, () => window.__game && __game.connected && __game.players >= 2, 15000, 'A sees 2');
  await waitFor(B, () => window.__game && __game.connected && __game.players >= 2, 15000, 'B sees 2');
  await A.evaluate(() => __game.start()); await B.evaluate(() => __game.start());
  const idB = await B.evaluate(() => __game.id);

  for (let bucket = 0; bucket < 8; bucket++) {
    const bAng = angToViewer + bucket * (Math.PI / 4);   // rel = bucket*45deg
    // Re-teleport both every iteration so a stray reaper frag can't drift them.
    await A.evaluate((p) => __game.teleport(p.x, p.y, p.ang), { ...A_POS, ang: A_ANG });
    await B.evaluate((p) => __game.teleport(p.x, p.y, p.ang), { ...B_POS, ang: bAng });
    await sleep(700); // let yaw propagate A<-server<-B
    const seen = await A.evaluate((id) => { const b = __game.snapshot().find((p) => p.id === id); return b ? { ang: +b.ang.toFixed(2), dead: b.dead } : null; }, idB);
    const label = VIEWS[bucket];
    await A.screenshot({ path: join(DOCS, `dir8-${bucket}-${label.replace(/[()]/g, '')}.png`), clip });
    console.log(`bucket ${bucket} ${label}: set B.ang=${bAng.toFixed(2)}, A sees B.ang=${seen ? seen.ang : 'MISSING'}${seen && seen.dead ? ' (DEAD)' : ''}`);
  }
  console.log(`\nangToViewer=${angToViewer.toFixed(2)} A_ANG=${A_ANG.toFixed(2)}`);
  await browser.close(); process.exit(0);
} catch (e) { console.error('DIR8 VERIFY ERROR:', e.message); await browser.close(); process.exit(2); }
