import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db', () => ({
  db: {
    organization: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { checkQuota, incrementUsage } from '../src/services/quota.service';

function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    plan: 'free',
    msgQuota: 0, // 0 = use plan default
    msgUsed: 0,
    currentPeriodStart: new Date(), // same month
    ...overrides,
  };
}

describe('checkQuota', () => {
  let db: { organization: Record<string, ReturnType<typeof vi.fn>> };

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../src/db');
    db = (mod.db as typeof db);
    db.organization.update.mockResolvedValue({});
  });

  it('returns true when org is under the free plan limit', async () => {
    db.organization.findUnique.mockResolvedValue(makeOrg({ msgUsed: 500 }));
    expect(await checkQuota('org-1')).toBe(true);
  });

  it('returns false when org has reached the free plan limit (1000)', async () => {
    db.organization.findUnique.mockResolvedValue(makeOrg({ msgUsed: 1000 }));
    expect(await checkQuota('org-1')).toBe(false);
  });

  it('returns false when org exceeds the free plan limit', async () => {
    db.organization.findUnique.mockResolvedValue(makeOrg({ msgUsed: 1500 }));
    expect(await checkQuota('org-1')).toBe(false);
  });

  it('returns true when msgQuota=0 and plan=enterprise (unlimited)', async () => {
    db.organization.findUnique.mockResolvedValue(makeOrg({ plan: 'enterprise', msgUsed: 99999 }));
    expect(await checkQuota('org-1')).toBe(true);
  });

  it('respects a custom msgQuota override (pro plan with custom quota 500)', async () => {
    db.organization.findUnique.mockResolvedValue(makeOrg({ plan: 'pro', msgQuota: 500, msgUsed: 499 }));
    expect(await checkQuota('org-1')).toBe(true);

    db.organization.findUnique.mockResolvedValue(makeOrg({ plan: 'pro', msgQuota: 500, msgUsed: 500 }));
    expect(await checkQuota('org-1')).toBe(false);
  });

  it('resets usage and returns true when period has rolled over to a new month', async () => {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    db.organization.findUnique.mockResolvedValue(makeOrg({ msgUsed: 999, currentPeriodStart: lastMonth }));

    const result = await checkQuota('org-1');
    expect(result).toBe(true);
    expect(db.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ msgUsed: 0 }) }),
    );
  });

  it('returns true (fail open) when org is not found', async () => {
    db.organization.findUnique.mockResolvedValue(null);
    expect(await checkQuota('unknown-org')).toBe(true);
  });
});

describe('incrementUsage', () => {
  let db: { organization: Record<string, ReturnType<typeof vi.fn>> };

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../src/db');
    db = (mod.db as typeof db);
    db.organization.update.mockResolvedValue({});
  });

  it('calls db.organization.update with increment: 1', async () => {
    await incrementUsage('org-1');
    expect(db.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { msgUsed: { increment: 1 } },
    });
  });
});
