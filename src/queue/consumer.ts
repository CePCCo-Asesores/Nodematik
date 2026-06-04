import { Worker } from 'bullmq';
import { redisConnection, MESSAGE_QUEUE } from './queue';
import { processInboundMessage } from '../services/conversation.service';
import type { InboundMessageJob } from '../types';

export function startWorker(): Worker {
  const worker = new Worker<InboundMessageJob>(
    MESSAGE_QUEUE,
    async (job) => {
      await processInboundMessage(job.data);
    },
    {
      connection: redisConnection,
      concurrency: 10,
    },
  );

  worker.on('failed', (job, err) => {
    console.error('[worker] job failed', {
      jobId: job?.id,
      phoneId: job?.data?.phoneId,
      attempt: job?.attemptsMade,
      error: err?.message,
    });
  });

  worker.on('error', (err) => {
    console.error('[worker] worker error', err.message);
  });

  return worker;
}
