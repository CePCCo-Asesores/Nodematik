import IORedis from 'ioredis';
import { config } from '../config';

export const CACHE_INVALIDATE_CHANNEL = 'bot:cache:invalidate';

function makeRedisClient(): IORedis {
  return new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
}

// Separate clients required: a subscribed ioredis connection can only
// receive messages, not send commands. Publisher and subscriber must be distinct.
let pubClient: IORedis | null = null;
let subClient: IORedis | null = null;

export function getPubClient(): IORedis {
  if (!pubClient) pubClient = makeRedisClient();
  return pubClient;
}

export function getSubClient(): IORedis {
  if (!subClient) subClient = makeRedisClient();
  return subClient;
}

export async function closePubSub(): Promise<void> {
  await Promise.all([pubClient?.quit(), subClient?.quit()]);
  pubClient = null;
  subClient = null;
}
