// STARFRAG — bot launcher. Runs the REAL browser client in headless chromium so
// a bot is a genuine networked player: it renders, joins the shared arena, and
// gets playtest-link video/state for free (same as a human). AI lives in the
// client (client/js/bot.js, ?bot=1). This file just opens a browser at it.
//
// Usage:
//   BOT_NAME=reaper node bot.mjs
//   node bot.mjs reaper
//   STARFRAG_URL=http://localhost:8080/ STARFRAG_WS=ws://localhost:8791 node bot.mjs test
//
// Playwright (chromium) is required; swiftshader flags let it render headless.
import { chromium } from 'playwright';

const NAME = (process.env.BOT_NAME || process.argv[2] || `bot-${Math.floor(Math.random() * 900 + 100)}`).slice(0, 16);
const BASE = process.env.STARFRAG_URL || 'https://bmo.ryanboye.com/starfrag/';

const url = new URL(BASE);
url.searchParams.set('bot', '1');
url.searchParams.set('name', NAME);
if (process.env.STARFRAG_WS) url.searchParams.set('ws', process.env.STARFRAG_WS);

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 384, height: 240 } });
page.on('console', (m) => console.log(`[${NAME}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[${NAME}] PAGEERROR ${e.message}`));

await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
console.log(`[${NAME}] joined ${url.toString()}`);

const shutdown = async () => { try { await browser.close(); } catch {} process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await new Promise(() => {}); // stay alive until killed
