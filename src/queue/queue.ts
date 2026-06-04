import { Queue } from 'bullmq';
import { config } from '../config';

// Parse the Redis URL into host/port/password options so BullMQ uses its own
// bundled ioredis — avoids type incompatibility with a separately-installed ioredis.
export function parseRedisConnection(url: string): {
  host: string;
  port: number;
  password?: string;
  username?: string;
  tls?: Record<string, unknown>;
  maxRetriesPerRequest: null;
  enableReadyCheck: false;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false as const,
  };
}

export const redisConnection = parseRedisConnection(config.REDIS_URL);

export const MESSAGE_QUEUE = 'inbound-messages';

export const messageQueue = new Queue(MESSAGE_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 2000 },
    removeOnFail: { count: 5000 },
  },
});
