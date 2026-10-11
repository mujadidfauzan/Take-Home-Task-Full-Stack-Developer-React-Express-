import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ACTORS, ApiError, parseCreateTask, parseStatusUpdate, STATUSES } from './domain';
import { TaskService } from './task-service';
import { RealtimeBus } from './realtime';

export function createApp(service: TaskService, realtime: RealtimeBus, staticDir?: string) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', async (_req, res) => {
    try {
      await service.ping();
      res.status(realtime.ready ? 200 : 503).json({ status: realtime.ready ? 'ok' : 'degraded', mongodb: 'ok', redis: realtime.ready ? 'ok' : 'unavailable' });
    } catch { res.status(503).json({ status: 'degraded', mongodb: 'unavailable', redis: realtime.ready ? 'ok' : 'unavailable' }); }
  });
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    const status = (ready: boolean) => { res.write(`event: connection\ndata: ${JSON.stringify({ ready })}\n\n`); };
    status(realtime.ready);
    const unsubscribe = realtime.subscribe((event) => {
      if (!res.write(`event: task-change\ndata: ${JSON.stringify(event)}\n\n`)) res.end();
    });
    const unsubscribeStatus = realtime.subscribeStatus(status);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); unsubscribeStatus(); };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });
  app.get('/api/meta', (_req, res) => res.json({ actors: ACTORS, statuses: STATUSES }));
  app.get('/api/tasks', async (req, res) => {
    if (req.query.deleted !== undefined && req.query.deleted !== 'true' && req.query.deleted !== 'false') {
      throw new ApiError(400, 'INVALID_INPUT', 'deleted must be true or false.');
    }
    res.json({ tasks: await service.list(req.query.deleted === 'true') });
  });
  app.post('/api/tasks', async (req, res) => {
    const task = await service.create(parseCreateTask(req.body));
    await realtime.publish('task.created', task);
    res.status(201).json({ task });
  });
  app.put('/api/tasks/:id/status', async (req, res) => {
    const { status, actor } = parseStatusUpdate(req.body);
    const result = await service.updateStatus(req.params.id, status, actor);
    if (result.changed) await realtime.publish('task.updated', result.task);
    res.json(result);
  });
  app.delete('/api/tasks/:id', async (req, res) => {
    const result = await service.delete(req.params.id);
    if (result.changed) await realtime.publish('task.deleted', result.task);
    res.status(204).end();
  });
  app.get('/api/tasks/:id/audit-logs', async (req, res) => res.json({ auditLogs: await service.auditLogs(req.params.id) }));
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found.')));
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir));
    app.get('/{*path}', (_req, res) => res.sendFile(join(staticDir, 'index.html')));
  }
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
