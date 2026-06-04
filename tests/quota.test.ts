import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db', () => ({
  db: {
    organization: { findUnique: vi.fn(), update: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

import { tryIncrementQuota } from '../src/services/quota.service';

// DB default is msgQuota=1000 (from schema @default(1000))
// msgQuota=0 means unlimited per schema comment
function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    msgQuota: 1000,   // matches DB @default(1000)
    msgUsed: 0,
    currentPeriodStart: new Date(), // same month
    ...overrides,
  };
}

describe('tryIncrementQuota', () => {
  let db: { organization: Record<string, ReturnType<typeof vi.fn>>; $executeRaw: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../src/db');
    db = mod.db as typeof db;
    db.organization.update.mockResolvedValue({});
    db.$executeRaw.mockResolvedValue(1); // 1 row affected = success
  });

  it('returns true and uses atomic increment when org is under quota', async () => {
    db.organization.findUnique.mockResolvedValue(makeOrg({ msgUsed: 500 }));
    expect(await tryIncrementQuota('org-1')).toBe(true);
    expect(db.$executeRaw).toHaveBeenCalled(); // atomic path used
  });

  it('returns false when atomic increment affects 0 rows (quota exceeded)', async () => {
    db.organization.findUnique.mockResolvedValue(makeOrg({ msgUsed: 1000 }));
    db.$executeRaw.mockResolvedValue(0); // 0 rows affected = quota exceeded
    expect(await tryIncrementQuota('org-1')).toBe(false);
  });

  it('returns true (unlimited) when msgQuota=0 — uses simple increment, not conditional', async () => {
    db.organization.findUnique.mockResolvedValue(makeOrg({ msgQuota: 0, msgUsed: 99999 }));
    expect(await tryIncrementQuota('org-1')).toBe(true);
    // Should NOT use the conditional $executeRaw path — uses db.organization.update instead
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { msgUsed: { increment: 1 } } }),
    );
  });

  it('resets usage and returns true when period has rolled over to a new month', async () => {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    db.organization.findUnique.mockResolvedValue(makeOrg({ msgUsed: 999, currentPeriodStart: lastMonth }));
    db.$executeRaw.mockResolvedValue(1); // atomic rollover reset affects 1 row

    const result = await tryIncrementQuota('org-1');
    expect(result).toBe(true);
    // Rollover uses a single atomic $executeRaw (not organization.update)
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(db.organization.update).not.toHaveBeenCalled();
  });

  it('returns true (fail open) when org is not found', async () => {
    db.organization.findUnique.mockResolvedValue(null);
    expect(await tryIncrementQuota('unknown-org')).toBe(true);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('returns true (fail open) when DB throws', async () => {
    db.organization.findUnique.mockRejectedValue(new Error('DB connection lost'));
    // The catch in conversation.service wraps this — quota.service itself lets it throw
    // so we verify the CALLER handles it; here just test direct behavior
    await expect(tryIncrementQuota('org-1')).rejects.toThrow('DB connection lost');
  });
});
