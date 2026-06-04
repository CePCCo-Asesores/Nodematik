import type { FastifyRequest, FastifyReply } from 'fastify';

export type Action =
  | 'bot:create'
  | 'bot:delete'
  | 'bot:update-config'
  | 'bot:update-credentials'
  | 'bot:update-prompt'
  | 'bot:update-knowledge'
  | 'bot:update-branding'
  | 'bot:update-commands'
  | 'bot:update-crisis-config'
  | 'channel:manage'
  | 'integration:manage'
  | 'user:suspend'
  | 'user:erase'
  | 'member:invite'
  | 'member:remove'
  | 'member:change-role'
  | 'org:update-billing'
  | 'org:delete'
  | 'proactive:send';

const PERMISSIONS: Record<string, Set<Action>> = {
  owner: new Set([
    'bot:create', 'bot:delete', 'bot:update-config', 'bot:update-credentials',
    'bot:update-prompt', 'bot:update-knowledge', 'bot:update-branding',
    'bot:update-commands', 'bot:update-crisis-config',
    'channel:manage', 'integration:manage',
    'user:suspend', 'user:erase',
    'member:invite', 'member:remove', 'member:change-role',
    'org:update-billing', 'org:delete',
    'proactive:send',
  ]),
  admin: new Set([
    'bot:create', 'bot:delete', 'bot:update-config', 'bot:update-credentials',
    'bot:update-prompt', 'bot:update-knowledge', 'bot:update-branding',
    'bot:update-commands', 'bot:update-crisis-config',
    'channel:manage', 'integration:manage',
    'user:suspend', 'user:erase',
    'member:invite', 'member:remove',
    'proactive:send',
  ]),
  editor: new Set([
    'bot:update-config',
    'bot:update-prompt', 'bot:update-knowledge', 'bot:update-branding',
    'bot:update-commands', 'bot:update-crisis-config',
  ]),
};

export function can(role: string, action: Action): boolean {
  return PERMISSIONS[role]?.has(action) ?? false;
}

/** Fastify preHandler that rejects requests without the required permission. */
export function requirePermission(action: Action) {
  return async function checkPermission(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
    if (req.user.isSuperadmin) return; // superadmin bypasses RBAC
    if (!can(req.user.role, action)) {
      return reply.status(403).send({ error: `Forbidden: requires permission '${action}'` });
    }
  };
}
