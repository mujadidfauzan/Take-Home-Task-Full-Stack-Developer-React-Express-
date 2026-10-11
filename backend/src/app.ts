import express, { type ErrorRequestHandler } from 'express';
import type Database from 'better-sqlite3';
import { ACTORS, ApiError, parseCreateTask, parseStatusUpdate, STATUSES } from './domain';
import { TaskService } from './task-service';

export function createApp(db: Database.Database) {
  const app = express();
  const service = new TaskService(db);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/meta', (_req, res) => res.json({ actors: ACTORS, statuses: STATUSES }));
  app.get('/api/tasks', (req, res) => {
    if (req.query.deleted !== undefined && req.query.deleted !== 'true' && req.query.deleted !== 'false') {
      throw new ApiError(400, 'INVALID_INPUT', 'deleted must be true or false.');
    }
    res.json({ tasks: service.list(req.query.deleted === 'true') });
  });
  app.post('/api/tasks', (req, res) => res.status(201).json({ task: service.create(parseCreateTask(req.body)) }));
  app.put('/api/tasks/:id/status', (req, res) => {
    const { status, actor } = parseStatusUpdate(req.body);
    res.json(service.updateStatus(req.params.id, status, actor));
  });
  app.delete('/api/tasks/:id', (req, res) => {
    service.delete(req.params.id);
    res.status(204).end();
  });
  app.get('/api/tasks/:id/audit-logs', (req, res) => res.json({ auditLogs: service.auditLogs(req.params.id) }));
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found.')));

  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error && typeof error === 'object' && 'type' in error) {
      if (error.type === 'entity.parse.failed') {
        res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body contains invalid JSON.' } });
        return;
      }
      if (error.type === 'entity.too.large') {
        res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body is too large.' } });
        return;
      }
    }
    console.error(error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unable to complete the request.' } });
  };
  app.use(handleError);
  return app;
}
