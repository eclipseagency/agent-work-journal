import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Command, Event, Status, Task } from '../server/journal';
import './style.css';

type Snapshot = { tasks: Task[]; events: Event[] };
const columns: { value: Status; label: string; help: string }[] = [
  { value: 'queued', label: 'Queued', help: 'Ready for the next agent' },
  { value: 'working', label: 'In progress', help: 'Ownership stays visible' },
  { value: 'done', label: 'Completed', help: 'A durable record of delivery' },
];
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ tasks: [], events: [] });
  const [title, setTitle] = useState(''); const [owner, setOwner] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false); const [pending, setPending] = useState<Command | null>(null);
  async function refresh() {
    const response = await fetch('/api/journal');
    if (!response.ok) throw new Error('Could not load the journal. Check the local server.');
    setSnapshot(await response.json()); setLoaded(true);
  }
  useEffect(() => { refresh().catch(e => setError(e.message)); }, []);
  async function save(command: Command) {
    setBusy(true); setError(''); setPending(command);
    try {
      const response = await fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      const result = await response.json();
      if (!response.ok) {
        setPending(null);
        if (response.status === 409) await refresh();
        throw new Error(result.error ?? 'Could not save.');
      }
      setPending(null);
      if (command.expectedVersion === 0) { setTitle(''); setOwner(''); }
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection failed.'); }
    finally { setBusy(false); }
  }
  function move(task: Task, status: Status) {
    void save({ requestId: crypto.randomUUID(), taskId: task.id, expectedVersion: task.version, title: task.title, owner: task.owner, status });
  }
  return <main>
    <header><a className="wordmark" href="/" aria-label="Agent Work Journal home"><span className="logo">aj</span> agent journal</a><span className="local"><i/> Local storage · no cloud account</span></header>
    <section className="intro"><div><p className="eyebrow">LOCAL-FIRST COORDINATION</p><h1>Keep the work.<br/><span>Keep the context.</span></h1><p className="lede">A shared task board for the humans and agents building together. Every change leaves a trace.</p></div><aside className="summary"><span>JOURNAL SNAPSHOT</span><strong>{snapshot.events.length.toString().padStart(2, '0')}</strong><p>recorded events</p><small>Append-only · version checked · retry safe</small></aside></section>
    <section className="workspace" aria-label="Task workspace"><div className="section-heading"><h2>Work queue <span>{snapshot.tasks.length} tasks</span></h2><button className="subtle" disabled={busy} onClick={() => refresh().catch(e => setError(e.message))}>Refresh journal ↻</button></div>
      <form onSubmit={e => { e.preventDefault(); void save({ requestId: crypto.randomUUID(), taskId: crypto.randomUUID(), expectedVersion: 0, title, owner, status: 'queued' }); }}>
        <label>Task<input required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs to happen next?"/></label>
        <label>Owner<input required maxLength={160} value={owner} onChange={e => setOwner(e.target.value)} placeholder="Human or agent name"/></label>
        <button type="submit" disabled={busy || !loaded || !!pending}>Add task +</button>
      </form>
      {error && <div className="error" role="alert">{error} {pending && <button disabled={busy} onClick={() => void save(pending)}>Retry same request</button>}</div>}
      <div className="board">{columns.map(column => <section className="column" key={column.value}><div className="column-head"><h3><i className={column.value}/>{column.label}</h3><span>{snapshot.tasks.filter(t => t.status === column.value).length}</span></div><p className="column-help">{column.help}</p>{snapshot.tasks.filter(t => t.status === column.value).map(task => <article className="task" key={task.id}><small>TASK · VERSION {task.version}</small><h4>{task.title}</h4><div className="owner"><b>{task.owner.slice(0, 1).toUpperCase()}</b>{task.owner}</div><label className="status-label">Status<select aria-label={`Status for ${task.title}`} value={task.status} disabled={busy || !!pending} onChange={e => move(task, e.target.value as Status)}>{columns.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label></article>)}{!snapshot.tasks.some(t => t.status === column.value) && <div className="empty">{loaded ? 'No tasks here yet.' : 'Loading journal…'}</div>}</section>)}</div>
    </section>
    <section className="history"><div className="section-heading"><h2>Activity trail</h2><span className="history-note">Latest 12 events</span></div>{snapshot.events.length === 0 ? <p className="empty-history">Your first task will start the journal.</p> : <ol>{snapshot.events.slice(-12).reverse().map(event => <li key={event.id}><span className="event-dot"/><div><strong>{event.task.title}</strong><p>{event.task.owner} · {event.task.status} · v{event.task.version}</p></div><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></li>)}</ol>}</section>
    <footer><span>Built with React, TypeScript & Node.js</span><span>Original portfolio demonstration · single-machine journal</span></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
