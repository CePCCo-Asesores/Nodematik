import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { hashPassword } from '../../services/auth.service';
import { parseBody, CreateOrgSchema, UpdateOrgSchema, InviteMemberSchema, UpdateMemberRoleSchema } from '../../lib/validate';

const orgRoutes: FastifyPluginAsync = async (fastify) => {
  // List orgs — superadmin sees all, org users see only their own
  fastify.get('/', async (req, reply) => {
    if (req.user!.isSuperadmin) {
      return reply.send(await db.organization.findMany({ orderBy: { createdAt: 'desc' } }));
    }
    const org = await db.organization.findUnique({ where: { id: req.user!.orgId } });
    return reply.send(org ? [org] : []);
  });

  // Create org — superadmin only (regular users create via POST /auth/register)
  fastify.post('/', async (req, reply) => {
    if (!req.user!.isSuperadmin) return reply.status(403).send({ error: 'Forbidden' });
    const { name, plan, msgQuota } = parseBody(CreateOrgSchema, req.body);
    const org = await db.organization.create({ data: { name, plan: plan ?? 'free', msgQuota: msgQuota ?? 1000 } });
    return reply.status(201).send(org);
  });

  // Get single org
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const org = await db.organization.findUnique({
      where: { id: req.params.id },
      include: { bots: { select: { id: true, name: true, status: true, createdAt: true } } },
    });
    if (!org) return reply.status(404).send({ error: 'Organization not found' });
    return reply.send(org);
  });

  // Update org
  fastify.put<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const { name, plan, msgQuota } = parseBody(UpdateOrgSchema, req.body);
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    // Only superadmin can change plan/quota
    if (req.user!.isSuperadmin) {
      if (plan !== undefined) data.plan = plan;
      if (msgQuota !== undefined) data.msgQuota = msgQuota;
    }
    const org = await db.organization.update({ where: { id: req.params.id }, data });
    return reply.send(org);
  });

  // Delete org — superadmin only
  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!req.user!.isSuperadmin) return reply.status(403).send({ error: 'Forbidden' });
    await db.organization.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });

  // ── Members ───────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/:id/members', async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const members = await db.orgUser.findMany({
      where: { orgId: req.params.id },
      select: { id: true, email: true, role: true, createdAt: true },
    });
    return reply.send(members);
  });

  // Invite member to org
  fastify.post<{ Params: { id: string } }>('/:id/members', async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    if (!req.user!.isSuperadmin && req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      return reply.status(403).send({ error: 'Only owners and admins can invite members' });
    }
    const { email, password, role } = parseBody(InviteMemberSchema, req.body);
    const existing = await db.orgUser.findFirst({ where: { email } });
    if (existing) return reply.status(409).send({ error: 'Email already registered' });

    const passwordHash = await hashPassword(password);
    const user = await db.orgUser.create({
      data: { orgId: req.params.id, email, passwordHash, role: role ?? 'editor' },
      select: { id: true, email: true, role: true, createdAt: true },
    });
    return reply.status(201).send(user);
  });

  // Change member role
  fastify.put<{ Params: { id: string; userId: string } }>('/:id/members/:userId', async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    if (!req.user!.isSuperadmin && req.user!.role !== 'owner') {
      return reply.status(403).send({ error: 'Only owners can change roles' });
    }
    const { role } = parseBody(UpdateMemberRoleSchema, req.body);
    // Verify the target user actually belongs to this org
    const target = await db.orgUser.findUnique({ where: { id: req.params.userId }, select: { orgId: true } });
    if (!target || target.orgId !== req.params.id) {
      return reply.status(404).send({ error: 'Member not found in this organization' });
    }
    const user = await db.orgUser.update({
      where: { id: req.params.userId },
      data: { role },
      select: { id: true, email: true, role: true },
    });
    return reply.send(user);
  });

  // Remove member
  fastify.delete<{ Params: { id: string; userId: string } }>('/:id/members/:userId', async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    if (!req.user!.isSuperadmin && req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      return reply.status(403).send({ error: 'Only owners and admins can remove members' });
    }
    // Verify the target user actually belongs to this org
    const target = await db.orgUser.findUnique({ where: { id: req.params.userId }, select: { orgId: true } });
    if (!target || target.orgId !== req.params.id) {
      return reply.status(404).send({ error: 'Member not found in this organization' });
    }
    await db.orgUser.delete({ where: { id: req.params.userId } });
    return reply.status(204).send();
  });
};

export default orgRoutes;
