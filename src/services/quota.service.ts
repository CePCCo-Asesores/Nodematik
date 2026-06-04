import { db } from '../db';

function isSamePeriod(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/**
 * Atomically checks quota and increments usage in one database operation.
 * Returns true if the message is within quota (and usage was incremented),
 * false if the quota is exceeded (usage is NOT incremented).
 *
 * msg_quota = 0 means unlimited.
 * Concurrent workers are handled safely via conditional SQL UPDATEs.
 */
export async function tryIncrementQuota(orgId: string): Promise<boolean> {
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { msgQuota: true, msgUsed: true, currentPeriodStart: true },
  });
  if (!org) return true; // fail open — unknown org does not block conversations

  const now = new Date();

  // Period rolled over — atomically reset counter (guards against concurrent workers
  // both detecting the rollover and both writing msgUsed = 1)
  if (!isSamePeriod(now, org.currentPeriodStart)) {
    const resetAffected: number = await db.$executeRaw`
      UPDATE organizations
      SET msg_used = 1, current_period_start = NOW()
      WHERE id = ${orgId}
        AND DATE_TRUNC('month', current_period_start) < DATE_TRUNC('month', NOW())
    `;
    if (resetAffected > 0) return true;
    // Another worker already reset the period — fall through to normal check
  }

  // Unlimited org — just increment
  if (org.msgQuota === 0) {
    await db.organization.update({ where: { id: orgId }, data: { msgUsed: { increment: 1 } } });
    return true;
  }

  // Atomic conditional increment: succeeds only when msg_used < msg_quota
  const affected: number = await db.$executeRaw`
    UPDATE organizations SET msg_used = msg_used + 1
    WHERE id = ${orgId} AND msg_used < msg_quota
  `;
  return affected > 0;
}
