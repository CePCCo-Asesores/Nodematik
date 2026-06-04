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
 * Concurrent workers are handled safely via a conditional SQL UPDATE.
 */
export async function tryIncrementQuota(orgId: string): Promise<boolean> {
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { msgQuota: true, msgUsed: true, currentPeriodStart: true },
  });
  if (!org) return true; // fail open — unknown org does not block conversations

  const now = new Date();

  // Period rolled over — reset counter and count this message as the first
  if (!isSamePeriod(now, org.currentPeriodStart)) {
    await db.organization.update({
      where: { id: orgId },
      data: { msgUsed: 1, currentPeriodStart: now },
    });
    return true;
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
