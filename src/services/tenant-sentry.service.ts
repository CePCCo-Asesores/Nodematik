import * as SentrySDK from '@sentry/node';
import { db } from '../db';
import { decrypt } from '../crypto';
import { config } from '../config';

// Cache one NodeClient per DSN — avoids re-creating transport connections on
// every error event. DSN is the cache key (already hashed by URL equality).
const clientCache = new Map<string, SentrySDK.NodeClient>();

function getOrCreateClient(dsn: string): SentrySDK.NodeClient {
  const cached = clientCache.get(dsn);
  if (cached) return cached;

  const client = new SentrySDK.NodeClient({
    dsn,
    transport: SentrySDK.makeNodeTransport,
    stackParser: SentrySDK.defaultStackParser,
    integrations: [],
    environment: config.NODE_ENV,
    sendDefaultPii: false,
  });
  clientCache.set(dsn, client);
  return client;
}

/**
 * Send an exception to the tenant's own Sentry project (if configured).
 * Fire-and-forget: never throws, never delays the caller.
 */
export function captureTenantException(
  orgId: string,
  err: Error,
  context: Record<string, unknown> = {},
): void {
  if (config.NODE_ENV === 'test') return;

  // Load DSN lazily — keep off the hot path
  db.organization
    .findUnique({ where: { id: orgId }, select: { sentryDsnEnc: true } })
    .then((org) => {
      if (!org?.sentryDsnEnc) return;

      let dsn: string;
      try {
        dsn = decrypt(org.sentryDsnEnc);
      } catch {
        return; // corrupt/unreadable DSN — silently skip
      }

      const client = getOrCreateClient(dsn);
      const scope = new SentrySDK.Scope();
      scope.setClient(client);
      scope.setExtra('orgId', orgId);
      for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
      scope.captureException(err);
      Promise.resolve(client.flush(2000)).catch(() => { /* non-critical */ });
    })
    .catch(() => { /* DB unavailable — silently skip */ });
}

/** Exposed for tests to reset state between test runs. */
export function clearTenantSentryCache(): void {
  clientCache.clear();
}
