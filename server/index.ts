import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Journal } from './journal.js';
import { createApp } from './http.js';

const directory = resolve(process.env.JOURNAL_DIRECTORY ?? 'data');
await mkdir(directory, { recursive: true });
const lockPath = resolve(directory, 'journal.lock');
// Never run two processes against the same append log.
const lock = await open(lockPath, 'wx').catch(() => { throw new Error('Journal locked. Stop the other server; after a crash, verify no server is running before removing data/journal.lock.'); });
await lock.writeFile(String(process.pid));
try {
  const journal = await Journal.load(resolve(directory, 'events.jsonl'));
  const server = createApp(journal);
  const port = Number(process.env.PORT ?? 4310);
  server.listen(port, '127.0.0.1', () => console.log(`Agent Work Journal: http://127.0.0.1:${port}`));
  let stopping = false;
  async function stop() {
    if (stopping) return; stopping = true;
    server.close(async () => { await lock.close(); await unlink(lockPath); process.exit(0); });
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  server.on('error', async error => { console.error(error.message); await lock.close(); await unlink(lockPath); process.exit(1); });
} catch (error) { await lock.close(); await unlink(lockPath); throw error; }
