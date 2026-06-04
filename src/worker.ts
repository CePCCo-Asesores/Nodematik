import './config'; // Validate env vars on startup
import { startWorker } from './queue/consumer';
import { db } from './db';
import { logger } from './logger';
import { getSubClient, closePubSub, CACHE_INVALIDATE_CHANNEL } from './lib/pubsub';
import { clearLocalBotCache } from './services/bot.service';

const worker = startWorker();

// Subscribe to cache invalidation events broadcast by the web service
const sub = getSubClient();
sub.subscribe(CACHE_INVALIDATE_CHANNEL).catch((err) => {
  logger.error({ err: (err as Error).message }, 'failed to subscribe to cache invalidation channel');
});
sub.on('message', (channel, botId) => {
  if (channel === CACHE_INVALIDATE_CHANNEL) clearLocalBotCache(botId);
});

logger.info('worker started — listening for inbound messages');

async function shutdown() {
  logger.info('worker shutting down');
  await worker.close();
  await closePubSub();
  await db.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
