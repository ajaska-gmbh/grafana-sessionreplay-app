// Static server for the bench: the pages origin and a second origin for the
// card field frame (cross-origin, like Stripe's, so rrweb cannot record it).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
export const PAGES_PORT = Number(process.env.BENCH_PORT ?? 5181);
export const FRAME_PORT = PAGES_PORT + 1;

function serve(port) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://localhost:${port}`);
    const file = path.join(root, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  }).listen(port, '127.0.0.1');
}

serve(PAGES_PORT);
serve(FRAME_PORT);
console.log(`bench on http://127.0.0.1:${PAGES_PORT} (frames on ${FRAME_PORT})`);
