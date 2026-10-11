export const STATUSES = ['to_do', 'pending', 'in_progress', 'done'] as const;
export type TaskStatus = (typeof STATUSES)[number];

export const ACTORS = ['john.doe', 'jane.smith', 'alex.chen'] as const;
export type Actor = (typeof ACTORS)[number];

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
  actor: Actor;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  changedAt: string;
}

export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_INPUT', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function parseCreateTask(body: unknown) {
  const input = objectBody(body);
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 120) {
    throw new ApiError(400, 'INVALID_INPUT', 'Title must contain 1 to 120 characters.');
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.trim().length > 2000)) {
    throw new ApiError(400, 'INVALID_INPUT', 'Description must be text with at most 2000 characters.');
  }
  return { title: input.title.trim(), description: (input.description as string | undefined)?.trim() ?? '' };
}

export function parseStatusUpdate(body: unknown): { status: TaskStatus; actor: Actor } {
  const input = objectBody(body);
  if (!STATUSES.includes(input.status as TaskStatus)) {
    throw new ApiError(400, 'INVALID_INPUT', `Status must be one of: ${STATUSES.join(', ')}.`);
  }
  if (!ACTORS.includes(input.actor as Actor)) {
    throw new ApiError(400, 'INVALID_INPUT', 'Select a valid actor.');
  }
  return { status: input.status as TaskStatus, actor: input.actor as Actor };
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (STATUSES.indexOf(to) !== STATUSES.indexOf(from) + 1) {
    throw new ApiError(409, 'INVALID_TRANSITION', `Cannot change status from ${from} to ${to}. Only the next status is allowed.`);
  }
}
