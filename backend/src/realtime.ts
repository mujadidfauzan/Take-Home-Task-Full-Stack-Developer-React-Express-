import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import type { Task } from './domain';

export interface TaskEvent {
  id: string;
  type: 'task.created' | 'task.updated' | 'task.deleted';
  taskId: string;
  version: number;
}

export class RealtimeBus {
  private readonly publisher;
  private readonly subscriber;
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly statusListeners = new Set<(ready: boolean) => void>();

  constructor(url: string, private readonly channel: string) {
    this.publisher = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 5000 } });
    this.subscriber = this.publisher.duplicate();
    for (const client of [this.publisher, this.subscriber]) {
      client.on('error', () => { console.warn('Redis connection unavailable; realtime delivery is degraded.'); this.notifyStatus(); });
      client.on('ready', () => this.notifyStatus());
      client.on('reconnecting', () => this.notifyStatus());
      client.on('end', () => this.notifyStatus());
    }
  }

  get ready(): boolean { return this.publisher.isReady && this.subscriber.isReady; }

  private notifyStatus() { for (const listener of this.statusListeners) listener(this.ready); }

  async connect(): Promise<void> {
    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      await this.subscriber.subscribe(this.channel, (message) => {
        try {
          const event = JSON.parse(message) as TaskEvent;
          if (!['task.created', 'task.updated', 'task.deleted'].includes(event.type) || typeof event.taskId !== 'string' || typeof event.version !== 'number') return;
          for (const listener of this.listeners) listener(event);
        } catch { console.warn('Ignored invalid realtime event.'); }
      });
    } catch (error) { this.close(); throw error; }
  }

  async publish(type: TaskEvent['type'], task: Task): Promise<void> {
    if (!this.publisher.isReady) return;
    try {
      await this.publisher.withAbortSignal(AbortSignal.timeout(1500)).publish(this.channel, JSON.stringify({ id: randomUUID(), type, taskId: task.id, version: task.version } satisfies TaskEvent));
    } catch { console.warn('Task committed, but realtime notification could not be published.'); }
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeStatus(listener: (ready: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  close(): void {
    this.listeners.clear(); this.statusListeners.clear();
    if (this.publisher.isOpen) this.publisher.destroy();
    if (this.subscriber.isOpen) this.subscriber.destroy();
  }
}
