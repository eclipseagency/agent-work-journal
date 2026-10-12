import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const statuses = ['queued', 'working', 'done'] as const;
export type Status = typeof statuses[number];
export type Task = { id: string; title: string; owner: string; status: Status; version: number };
export type Command = { requestId: string; taskId: string; expectedVersion: number; title: string; owner: string; status: Status };
export type Event = { id: string; at: string; command: Command; task: Task };
export class JournalError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function validate(input: unknown): Command {
  if (!input || typeof input !== 'object') throw new JournalError(400, 'Expected a JSON object.');
  const c = input as Record<string, unknown>;
  for (const field of ['requestId', 'taskId', 'title', 'owner'] as const) {
    if (typeof c[field] !== 'string' || !c[field].trim() || c[field].length > 160) {
      throw new JournalError(400, `${field} must contain 1–160 characters.`);
    }
  }
  if (!Number.isSafeInteger(c.expectedVersion) || (c.expectedVersion as number) < 0) {
    throw new JournalError(400, 'expectedVersion must be a nonnegative integer.');
  }
  if (!statuses.includes(c.status as Status)) throw new JournalError(400, 'Unknown status.');
  return { requestId: c.requestId as string, taskId: c.taskId as string, expectedVersion: c.expectedVersion as number,
    title: (c.title as string).trim(), owner: (c.owner as string).trim(), status: c.status as Status };
}

/** One process owns a journal. Its promise queue serializes reads and writes. */
export class Journal {
  private tail: Promise<unknown> = Promise.resolve();
  private events: Event[] = [];
  private tasks = new Map<string, Task>();
  private requests = new Map<string, Event>();
  private constructor(private path: string) {}

  static async load(path: string): Promise<Journal> {
    const journal = new Journal(path);
    await mkdir(dirname(path), { recursive: true });
    let raw = '';
    try { raw = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Fail closed rather than silently skipping a torn or malformed event.
    if (raw && !raw.endsWith('\n')) throw new Error('Incomplete journal tail: restore the file before starting.');
    for (const line of raw.split('\n').filter(Boolean)) {
      const event = JSON.parse(line) as Event;
      const command = validate(event.command);
      const previous = journal.tasks.get(command.taskId);
      if (!event.id || !event.at || journal.requests.has(command.requestId) ||
          command.expectedVersion !== (previous?.version ?? 0) ||
          JSON.stringify(event.task) !== JSON.stringify(journal.nextTask(command))) {
        throw new Error('Invalid journal event: restore the file before starting.');
      }
      journal.apply(event);
    }
    return journal;
  }

  private nextTask(c: Command): Task {
    return { id: c.taskId, title: c.title, owner: c.owner, status: c.status, version: c.expectedVersion + 1 };
  }
  private apply(event: Event) {
    this.events.push(event); this.tasks.set(event.task.id, event.task); this.requests.set(event.command.requestId, event);
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
  snapshot() {
    return this.serialize(async () => structuredClone({ tasks: [...this.tasks.values()], events: this.events }));
  }
  append(input: unknown): Promise<Event> {
    return this.serialize(async () => {
      const command = validate(input);
      const replay = this.requests.get(command.requestId);
      if (replay) {
        if (JSON.stringify(replay.command) !== JSON.stringify(command)) throw new JournalError(409, 'Request ID already used with a different command.');
        return structuredClone(replay);
      }
      const current = this.tasks.get(command.taskId);
      if ((current?.version ?? 0) !== command.expectedVersion) throw new JournalError(409, 'Task changed. Refresh before retrying.');
      const event: Event = { id: randomUUID(), at: new Date().toISOString(), command, task: this.nextTask(command) };
      const bytes = Buffer.from(JSON.stringify(event) + '\n');
      const file = await open(this.path, 'a+');
      const originalSize = (await stat(this.path)).size;
      try {
        await file.writeFile(bytes); await file.sync();
      } catch (error) {
        // A normal write failure must not leave a partial line for the next attempt.
        await file.truncate(originalSize); await file.sync(); throw error;
      } finally { await file.close(); }
      this.apply(event);
      return structuredClone(event);
    });
  }
}
