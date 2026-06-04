import { db } from '../db';

const PLAN_QUOTAS: Record<string, number> = {
  free: 1_000,
  pro: 10_000,
  enterprise: 0, // 0 = unlimited
};

function isSamePeriod(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

export async function checkQuota(orgId: string): Promise<boolean> {
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { plan: true, msgQuota: true, msgUsed: true, currentPeriodStart: true },
  });
  if (!org) return true;

  const now = new Date();
  if (!isSamePeriod(now, org.currentPeriodStart)) {
    await db.organization.update({
      where: { id: orgId },
      data: { msgUsed: 0, currentPeriodStart: now },
    });
    return true;
  }

  const limit = org.msgQuota > 0 ? org.msgQuota : (PLAN_QUOTAS[org.plan] ?? PLAN_QUOTAS.free);
  if (limit === 0) return true; // enterprise unlimited
  return org.msgUsed < limit;
}

export async function incrementUsage(orgId: string): Promise<void> {
  await db.organization.update({
    where: { id: orgId },
    data: { msgUsed: { increment: 1 } },
  });
}
