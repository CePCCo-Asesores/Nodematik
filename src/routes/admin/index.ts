import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config';
import botRoutes from './bots';
import channelRoutes from './channels';
import orgRoutes from './organizations';
import knowledgeRoutes from './knowledge';

const adminRoutes: FastifyPluginAsync = async (fastify) => {
  // Phase A: simple API key auth
  fastify.addHook('preHandler', async (req, reply) => {
    const key = req.headers['x-admin-key'] ?? (req.headers['authorization']?.replace('Bearer ', ''));
    if (key !== config.ADMIN_API_KEY) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.register(orgRoutes, { prefix: '/organizations' });
  fastify.register(botRoutes, { prefix: '/bots' });
  fastify.register(channelRoutes, { prefix: '/bots' });
  fastify.register(knowledgeRoutes, { prefix: '/bots' });
};

export default adminRoutes;
