import './config'; // Validate env vars on startup
import { startWorker } from './queue/consumer';
import { db } from './db';

const worker = startWorker();

console.log('[worker] started — listening for inbound messages');

async function shutdown() {
  console.log('[worker] shutting down...');
  await worker.close();
  await db.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
