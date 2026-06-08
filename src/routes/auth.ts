import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db';
import { hashPassword, verifyPassword, signToken } from '../services/auth.service';
import { parseBody, RegisterSchema, LoginSchema } from '../lib/validate';

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Create org + owner account — 5 registrations per hour per IP
  fastify.post('/register', { config: { rateLimit: { max: 5, timeWindow: 60 * 60 * 1000 } } }, async (req, reply) => {
    const body = parseBody(RegisterSchema, req.body);
    const email = body.email.trim().toLowerCase();

    const existing = await db.orgUser.findFirst({ where: { email } });
    if (existing) return reply.status(409).send({ error: 'Email already registered' });

    const passwordHash = await hashPassword(body.password);

    // Wrap org + user + bot creation in a transaction — partial failure leaves no orphaned data.
    // Cada organización nace con un bot universal (su "asistente") sin credenciales LLM;
    // el cliente lo configura con su propia API key (modelo BYO) antes de operar soluciones.
    const { org, user, bot } = await db.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name: body.orgName } });
      const user = await tx.orgUser.create({
        data: { orgId: org.id, email, passwordHash, role: 'owner' },
      });
      const bot = await tx.bot.create({
        data: { orgId: org.id, name: `Asistente de ${body.orgName}`, status: 'draft' },
      });
      return { org, user, bot };
    });

    const token = signToken({ sub: user.id, orgId: org.id, role: 'owner' });
    return reply.status(201).send({ token, orgId: org.id, userId: user.id, botId: bot.id, llmConfigured: false });
  });

  // Login — 10 attempts per 15 minutes per IP
  fastify.post('/login', { config: { rateLimit: { max: 10, timeWindow: 15 * 60 * 1000 } } }, async (req, reply) => {
    const body = parseBody(LoginSchema, req.body);
    const email = body.email.trim().toLowerCase();

    const user = await db.orgUser.findFirst({ where: { email } });
    if (!user) return reply.status(401).send({ error: 'Invalid credentials' });

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) return reply.status(401).send({ error: 'Invalid credentials' });

    // Bot universal de la organización. Si por alguna razón no existe (cuentas previas
    // al cambio), se crea al vuelo para que ninguna org quede sin su asistente.
    let bot = await db.bot.findFirst({ where: { orgId: user.orgId }, orderBy: { createdAt: 'asc' } });
    if (!bot) {
      const org = await db.organization.findUnique({ where: { id: user.orgId } });
      bot = await db.bot.create({
        data: { orgId: user.orgId, name: `Asistente de ${org?.name ?? 'mi organización'}`, status: 'draft' },
      });
    }

    const token = signToken({ sub: user.id, orgId: user.orgId, role: user.role });
    return reply.send({ token, orgId: user.orgId, userId: user.id, role: user.role, botId: bot.id, llmConfigured: !!bot.llmApiKeyEnc, expiresIn: '7d' });
  });
};

export default authRoutes;
