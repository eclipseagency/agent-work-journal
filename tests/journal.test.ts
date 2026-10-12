import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Journal, JournalError, type Command } from '../server/journal.js';
import { createApp } from '../server/http.js';

const command = (overrides: Partial<Command> = {}): Command => ({ requestId: 'request-1', taskId: 'task-1', expectedVersion: 0, title: 'Review agent handoff', owner: 'Planner', status: 'queued', ...overrides });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-journal-'));
  return { dir, path: join(dir, 'events.jsonl'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}
test('parallel retries record one event; restart preserves the original response', async () => {
  const f = await fixture();
  try {
    const journal = await Journal.load(f.path);
    const responses = await Promise.all(Array.from({ length: 30 }, () => journal.append(command())));
    assert.ok(responses.every(e => e.id === responses[0].id));
    const reloaded = await Journal.load(f.path);
    assert.deepEqual(await reloaded.append(command()), responses[0]);
    assert.equal((await reloaded.snapshot()).events.length, 1);
    assert.equal((await readFile(f.path, 'utf8')).trim().split('\n').length, 1);
  } finally { await f.cleanup(); }
});
test('two writers using one task version cannot silently overwrite each other', async () => {
  const f = await fixture();
  try {
    const journal = await Journal.load(f.path); await journal.append(command());
    const results = await Promise.allSettled([
      journal.append(command({ requestId: 'a', expectedVersion: 1, owner: 'Agent A', status: 'working' })),
      journal.append(command({ requestId: 'b', expectedVersion: 1, owner: 'Agent B', status: 'done' })),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = results.find(r => r.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected' && rejected.reason instanceof JournalError);
    assert.equal(rejected.reason.status, 409);
    const snapshot = await journal.snapshot(); assert.equal(snapshot.tasks[0].version, 2); assert.equal(snapshot.events.length, 2);
  } finally { await f.cleanup(); }
});
test('reused id with changed payload is rejected, and rejected commands do not poison the queue', async () => {
  const f = await fixture();
  try {
    const journal = await Journal.load(f.path); await journal.append(command());
    await assert.rejects(journal.append(command({ title: 'Different command' })), { status: 409 });
    await assert.rejects(journal.append(command({ requestId: 'bad', status: 'invalid' as never })), { status: 400 });
    await journal.append(command({ requestId: 'next', expectedVersion: 1, status: 'done' }));
    assert.equal((await journal.snapshot()).tasks[0].status, 'done');
  } finally { await f.cleanup(); }
});
test('an incomplete disk tail fails closed instead of dropping history', async () => {
  const f = await fixture();
  try { await writeFile(f.path, '{"partial":'); await assert.rejects(Journal.load(f.path), /Incomplete journal tail/); }
  finally { await f.cleanup(); }
});
test('HTTP flow validates content, rejects browser cross-origin writes, and returns conflict', async () => {
  const f = await fixture();
  const app = createApp(await Journal.load(f.path));
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(url + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const forgedHost = (method: string, path: string) => new Promise<number | undefined>((resolve, reject) => {
    const req = request(url + path, { method, headers: { Host: 'rebinding.example', Origin: 'http://rebinding.example', 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(method === 'POST' ? JSON.stringify(command()) : undefined);
  });
  try {
    assert.equal(await forgedHost('POST', '/api/events'), 403);
    assert.equal(await forgedHost('GET', '/api/journal'), 403);
    assert.equal((await post(command(), { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await post(command(), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post({ oversized: 'x'.repeat(17000) })).status, 413);
    assert.equal((await post(command({ title: '' }))).status, 400);
    assert.equal((await post(command())).status, 200);
    assert.equal((await post(command({ requestId: 'stale' }))).status, 409);
    const response = await fetch(url + '/api/journal');
    assert.equal(response.status, 200); assert.equal((await response.json()).tasks.length, 1);
  } finally { await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())); await f.cleanup(); }
});
