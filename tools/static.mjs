// STARFRAG — tiny static file server for LOCAL development only.
// Serves client/ (following the `shared` symlink) with correct MIME types so
// ES module imports work. Production is served by Caddy, not this.
//   PORT=8080 node tools/static.mjs   ->  http://localhost:8080/
import { createServer } from 'http';
import { createReadStream, existsSync, statSync } from 'fs';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'client');
const PORT = +(process.env.PORT || 8080);
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.webm': 'video/webm', '.svg': 'image/svg+xml',
};

createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const path = normalize(join(ROOT, p));
  if (!path.startsWith(ROOT)) { res.writeHead(403); return res.end('nope'); }
  if (!existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
  createReadStream(path).pipe(res);
}).listen(PORT, () => console.log(`[starfrag] static client on http://localhost:${PORT}/`));
