import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Journal, JournalError } from './journal.js';

const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
export function createApp(journal: Journal, publicDirectory = resolve('dist')) {
  return createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    try {
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(req.headers.host ?? '')) {
        throw new JournalError(403, 'Only loopback hosts are allowed.');
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/journal') return json(200, await journal.snapshot());
      if (req.method === 'POST' && url.pathname === '/api/events') {
        // Reject browser cross-origin writes. This remains a loopback-only demo, not an authenticated service.
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}` && origin !== 'http://127.0.0.1:5173' && origin !== 'http://localhost:5173') {
          throw new JournalError(403, 'Cross-origin writes are disabled.');
        }
        if (!req.headers['content-type']?.startsWith('application/json')) throw new JournalError(415, 'Use application/json.');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > 16_384) { req.resume(); throw new JournalError(413, 'Request too large.'); }
          chunks.push(chunk);
        }
        let input: unknown;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new JournalError(400, 'Invalid JSON.'); }
        return json(200, await journal.append(input));
      }
      if (url.pathname.startsWith('/api/')) return json(404, { error: 'Route not found.' });
      if (req.method !== 'GET') return json(405, { error: 'Method not allowed.' });
      const path = resolve(publicDirectory, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(publicDirectory + sep)) return json(404, { error: 'Not found.' });
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    } catch (error) {
      if (error instanceof JournalError) return json(error.status, { error: error.message });
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json(404, { error: 'Build the frontend with npm run build first.' });
      console.error('Request failed:', error instanceof Error ? error.message : 'Unknown error');
      json(500, { error: 'Request could not be saved.' });
    }
  });
}
