import { useEffect, useState } from 'react';
import { ArrowRight, Check, ChevronDown, History, LoaderCircle, Trash2 } from 'lucide-react';
import { api } from './api';
import { STATUS_LABELS, type AuditLog, type Task, type TaskStatus } from './types';

const formatter = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'medium' });
export const formatDate = (value: string) => formatter.format(new Date(value));

interface Props {
  task: Task;
  actor: string;
  statuses: TaskStatus[];
  onChange: (task: Task) => void;
  onDelete: (id: string) => void;
}

export function TaskItem({ task, actor, statuses, onChange, onDelete }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logError, setLogError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reload, setReload] = useState(0);
  const nextStatus = statuses[statuses.indexOf(task.status) + 1];

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoadingLogs(true);
    setLogError('');
    api.auditLogs(task.id)
      .then(({ auditLogs }) => { if (!cancelled) setLogs(auditLogs); })
      .catch((err: Error) => { if (!cancelled) setLogError(err.message); })
      .finally(() => { if (!cancelled) setLoadingLogs(false); });
    return () => { cancelled = true; };
  }, [expanded, task.id, task.updatedAt, reload]);

  async function advance() {
    if (!nextStatus || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.updateStatus(task.id, nextStatus, actor);
      onChange(result.task);
      setReload((value) => value + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    setError('');
    try { await api.delete(task.id); onDelete(task.id); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <article className="task-item" aria-label={task.title}>
      <div className="task-main">
        <div className="task-content">
          <span className={`status status-${task.status}`}>{STATUS_LABELS[task.status]}</span>
          <h3>{task.title}</h3>
          {task.description && <p className="task-description">{task.description}</p>}
          <p className="task-date">{task.deletedAt ? 'Dihapus' : 'Dibuat'} <time dateTime={task.deletedAt ?? task.createdAt}>{formatDate(task.deletedAt ?? task.createdAt)}</time></p>
        </div>
        <div className="task-actions">
          {!task.deletedAt && (
            nextStatus ? <button className="button next-button" disabled={busy || !actor} onClick={advance}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}{STATUS_LABELS[nextStatus]}
            </button> : <span className="completed"><Check size={16} /> Selesai</span>
          )}
          <button className={`icon-button ${expanded ? 'selected' : ''}`} title="Riwayat perubahan" aria-label={`Riwayat ${task.title}`} aria-expanded={expanded} aria-controls={`history-${task.id}`} onClick={() => setExpanded(!expanded)}>
            <History size={18} />
          </button>
          {!task.deletedAt && <button className="icon-button danger" disabled={busy} title="Hapus task" aria-label={`Hapus ${task.title}`} onClick={() => setConfirmDelete(true)}><Trash2 size={18} /></button>}
        </div>
      </div>
      {error && <p role="alert" className="inline-error">{error}</p>}
      {confirmDelete && <div className="delete-confirmation">
        <p>Hapus task "{task.title}"?</p>
        <div className="confirmation-actions">
          <button className="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Batal</button>
          <button className="button delete-button" disabled={busy} onClick={remove}><Trash2 size={15} /> Hapus</button>
        </div>
      </div>}
      {expanded && <section className="audit-section" id={`history-${task.id}`} aria-label={`Audit log ${task.title}`}>
        <div className="audit-heading"><h4><History size={16} /> Riwayat perubahan</h4><span>Waktu lokal</span></div>
        {loadingLogs ? <p className="muted" role="status">Memuat riwayat...</p> : logError ? <div role="alert" className="inline-error">{logError} <button className="text-button" onClick={() => setReload((value) => value + 1)}>Coba lagi</button></div> : logs.length === 0 ? <p className="muted">Belum ada perubahan status.</p> : <ol className="audit-list">
          {logs.map((log) => <li key={log.id}>
            <div className="audit-detail"><strong>{log.actor}</strong> mengubah status <strong>{log.taskTitle}</strong></div>
            <div className="audit-transition"><span className={`status status-${log.fromStatus}`}>{STATUS_LABELS[log.fromStatus]}</span><ArrowRight size={14} aria-label="menjadi" /><span className={`status status-${log.toStatus}`}>{STATUS_LABELS[log.toStatus]}</span></div>
            <time dateTime={log.changedAt} title={log.changedAt}>{formatDate(log.changedAt)}</time>
          </li>)}
        </ol>}
      </section>}
      <button className="history-toggle" aria-expanded={expanded} aria-controls={`history-${task.id}`} onClick={() => setExpanded(!expanded)}><ChevronDown size={14} className={expanded ? 'rotated' : ''} /> {expanded ? 'Tutup riwayat' : 'Lihat riwayat'}</button>
    </article>
  );
}
