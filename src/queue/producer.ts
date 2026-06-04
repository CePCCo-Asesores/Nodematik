import { messageQueue } from './queue';
import type { InboundMessageJob } from '../types';

export async function enqueueInboundMessage(job: InboundMessageJob): Promise<void> {
  // Use waMessageId as the job ID for idempotency — BullMQ deduplicates by ID
  await messageQueue.add('process', job, {
    jobId: `wa-${job.waMessageId}`,
    // If a duplicate arrives within 60s, BullMQ silently skips it
    delay: 0,
  });
}
