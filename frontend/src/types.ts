export type TaskStatus = 'to_do' | 'pending' | 'in_progress' | 'done';
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
}
export interface AuditLog {
  sequence: number;
  id: string;
  taskId: string;
  taskTitle: string;
  actor: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  changedAt: string;
}
export interface Metadata {
  actors: string[];
  statuses: TaskStatus[];
}
export const STATUS_LABELS: Record<TaskStatus, string> = {
  to_do: 'To do', pending: 'Pending', in_progress: 'In progress', done: 'Done'
};
