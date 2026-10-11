import type { AuditLog, Metadata, Task, TaskStatus } from './types';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Request failed (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  metadata: () => request<Metadata>('/meta'),
  tasks: (deleted: boolean) => request<{ tasks: Task[] }>(`/tasks?deleted=${deleted}`),
  create: (title: string, description: string) => request<{ task: Task }>('/tasks', {
    method: 'POST', body: JSON.stringify({ title, description })
  }),
  updateStatus: (id: string, status: TaskStatus, actor: string) => request<{ task: Task; changed: boolean; auditLog: AuditLog | null }>(`/tasks/${id}/status`, {
    method: 'PUT', body: JSON.stringify({ status, actor })
  }),
  delete: (id: string) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),
  auditLogs: (id: string) => request<{ auditLogs: AuditLog[] }>(`/tasks/${id}/audit-logs`)
};
