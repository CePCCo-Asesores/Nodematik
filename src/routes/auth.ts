import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db';
import { hashPassword, verifyPassword, signToken } from '../services/auth.service';

interface RegisterBody { email: string; password: string; orgName: string }
interface LoginBody { email: string; password: string }
interface InviteBody { email: string; password: string; role?: string }

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Create org + owner account
  fastify.post<{ Body: RegisterBody }>('/register', async (req, reply) => {
    const { email, password, orgName } = req.body ?? {};
    if (!email || !password || !orgName) {
      return reply.status(400).send({ error: 'email, password, and orgName are required' });
    }

    const existing = await db.orgUser.findFirst({ where: { email } });
    if (existing) return reply.status(409).send({ error: 'Email already registered' });

    const passwordHash = await hashPassword(password);

    // Wrap org + user creation in a transaction — partial failure leaves no orphaned org
    const { org, user } = await db.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name: orgName } });
      const user = await tx.orgUser.create({
        data: { orgId: org.id, email, passwordHash, role: 'owner' },
      });
      return { org, user };
    });

    const token = signToken({ sub: user.id, orgId: org.id, role: 'owner' });
    return reply.status(201).send({ token, orgId: org.id, userId: user.id });
  });

  // Login
  fastify.post<{ Body: LoginBody }>('/login', async (req, reply) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'email and password are required' });
    }

    const user = await db.orgUser.findFirst({ where: { email } });
    if (!user) return reply.status(401).send({ error: 'Invalid credentials' });

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return reply.status(401).send({ error: 'Invalid credentials' });

    const token = signToken({ sub: user.id, orgId: user.orgId, role: user.role });
    return reply.send({ token, orgId: user.orgId, userId: user.id, role: user.role, expiresIn: '7d' });
  });
};

export default authRoutes;
