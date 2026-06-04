import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';

const orgRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (_req, reply) => {
    const orgs = await db.organization.findMany({ orderBy: { createdAt: 'desc' } });
    return reply.send(orgs);
  });

  fastify.post<{ Body: { name: string } }>('/', async (req, reply) => {
    const org = await db.organization.create({ data: { name: req.body.name } });
    return reply.status(201).send(org);
  });

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const org = await db.organization.findUnique({
      where: { id: req.params.id },
      include: { bots: { select: { id: true, name: true, status: true, createdAt: true } } },
    });
    if (!org) return reply.status(404).send({ error: 'Organization not found' });
    return reply.send(org);
  });

  fastify.put<{ Params: { id: string }; Body: { name: string } }>('/:id', async (req, reply) => {
    const org = await db.organization.update({ where: { id: req.params.id }, data: { name: req.body.name } });
    return reply.send(org);
  });

  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    await db.organization.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });
};

export default orgRoutes;
