import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ClipboardList, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import { api } from './api';
import { TaskItem } from './TaskItem';
import { useRealtime } from './useRealtime';
import { STATUS_LABELS, type Metadata, type Task } from './types';

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [metadata, setMetadata] = useState<Metadata>({ actors: [], statuses: [] });
  const [actor, setActor] = useState('');
  const [deleted, setDeleted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  const titleInput = useRef<HTMLInputElement>(null);
  const realtime = useRealtime();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([api.tasks(deleted), api.metadata()])
      .then(([taskData, meta]) => {
        if (cancelled) return;
        setTasks(taskData.tasks);
        setMetadata(meta);
        setActor((current) => current || meta.actors[0]);
      })
      .catch((err: Error) => { if (!cancelled) { setTasks([]); setError(err.message); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [deleted, reload]);

  useEffect(() => {
    if (loading || !metadata.statuses.length) return;
    let cancelled = false;
    api.tasks(deleted)
      .then(({ tasks: latest }) => { if (!cancelled) setTasks(latest); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [realtime.revision, deleted, loading, metadata.statuses.length]);

  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      const { task } = await api.create(title, description);
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      setTitle('');
      setDescription('');
      setNotice('Task berhasil dibuat.');
      titleInput.current?.focus();
    } catch (err) { setError((err as Error).message); }
    finally { setCreating(false); }
  }

  function switchView(value: boolean) {
    setDeleted(value);
    setNotice('');
  }

  return (
    <>
      <header className="app-header"><div className="header-inner">
        <div className="brand"><ClipboardList size={24} /><span>Mini Task Manager</span></div>
        <span className="connection-state" role="status"><i className={realtime.connected ? 'online' : ''} />{realtime.connected ? 'Terhubung' : 'Menghubungkan...'}</span>
      </div></header>
      <main>
        <div className="page-heading"><div><p className="eyebrow">TEAM WORKSPACE</p><h1>Tasks</h1></div>
          <label className="actor-field">Actor<select aria-label="Actor" value={actor} onChange={(event) => setActor(event.target.value)} disabled={!metadata.actors.length}>
            {metadata.actors.map((value) => <option key={value}>{value}</option>)}
          </select></label>
        </div>
        {error && <div role="alert" className="error-banner">{error}<button className="icon-button" title="Tutup pesan" aria-label="Tutup pesan error" onClick={() => setError('')}><X size={16} /></button></div>}
        <div role="status" aria-live="polite" className="notice">{notice}</div>
        {!deleted && <section className="create-section" aria-labelledby="create-heading">
          <h2 id="create-heading">Task baru</h2>
          <form onSubmit={createTask}>
            <div className="form-fields">
              <label>Judul<input ref={titleInput} placeholder="Contoh: Prepare invoice" maxLength={120} required value={title} disabled={creating} onChange={(event) => setTitle(event.target.value)} /></label>
              <label>Deskripsi <span className="optional">(opsional)</span><textarea placeholder="Detail task" maxLength={2000} rows={2} value={description} disabled={creating} onChange={(event) => setDescription(event.target.value)} /></label>
            </div>
            <button className="button primary" type="submit" disabled={creating || loading || !metadata.statuses.length || !title.trim()}>{creating ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />} Tambah task</button>
          </form>
        </section>}
        <section className="tasks-section" aria-label="Daftar task">
          <div className="list-toolbar">
            <div className="tabs" role="tablist" aria-label="Jenis task">
              <button role="tab" aria-selected={!deleted} disabled={creating} onClick={() => switchView(false)}>Aktif{!deleted && !loading && <span className="count">{tasks.length}</span>}</button>
              <button role="tab" aria-selected={deleted} disabled={creating} onClick={() => switchView(true)}>Terhapus{deleted && !loading && <span className="count">{tasks.length}</span>}</button>
            </div>
            <button className="icon-button" aria-label="Muat ulang task" title="Muat ulang task" disabled={loading || creating} onClick={() => { setNotice(''); setReload((value) => value + 1); }}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button>
          </div>
          {!deleted && !loading && <div className="status-summary">{metadata.statuses.map((status) => <span key={status}><i className={`dot dot-${status}`} />{STATUS_LABELS[status]}<strong>{tasks.filter((task) => task.status === status).length}</strong></span>)}</div>}
          {loading ? <div className="empty-state" role="status"><LoaderCircle size={26} className="spin" /><p>Memuat task...</p></div> : tasks.length === 0 ? <div className="empty-state"><ClipboardList size={32} /><h2>{error ? 'Task belum dapat dimuat' : deleted ? 'Tidak ada task terhapus' : 'Belum ada task'}</h2></div> : <div className="task-list">
            {tasks.map((task) => <TaskItem key={task.id} task={task} actor={actor} statuses={metadata.statuses}
              onChange={(updated) => { setTasks((current) => current.map((item) => item.id === updated.id && item.version <= updated.version ? updated : item)); setNotice(`Status "${updated.title}" menjadi ${STATUS_LABELS[updated.status]}.`); }}
              onDelete={(id) => { setTasks((current) => current.filter((item) => item.id !== id)); setNotice('Task berhasil dihapus.'); }} />)}
          </div>}
        </section>
        <footer>Mini Task Manager <span>Internal workspace</span></footer>
      </main>
    </>
  );
}
