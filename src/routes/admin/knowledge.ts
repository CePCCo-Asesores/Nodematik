import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { invalidateBotCache } from '../../services/bot.service';

const knowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { botId: string } }>('/:botId/knowledge', async (req, reply) => {
    const items = await db.botKnowledge.findMany({ where: { botId: req.params.botId } });
    return reply.send(items);
  });

  fastify.post<{ Params: { botId: string }; Body: KnowledgeBody }>('/:botId/knowledge', async (req, reply) => {
    const item = await db.botKnowledge.create({ data: { botId: req.params.botId, ...req.body } });
    invalidateBotCache(req.params.botId);
    return reply.status(201).send(item);
  });

  fastify.put<{ Params: { botId: string; itemId: string }; Body: Partial<KnowledgeBody> }>('/:botId/knowledge/:itemId', async (req, reply) => {
    const item = await db.botKnowledge.update({ where: { id: req.params.itemId }, data: req.body });
    invalidateBotCache(req.params.botId);
    return reply.send(item);
  });

  fastify.delete<{ Params: { botId: string; itemId: string } }>('/:botId/knowledge/:itemId', async (req, reply) => {
    await db.botKnowledge.delete({ where: { id: req.params.itemId } });
    invalidateBotCache(req.params.botId);
    return reply.status(204).send();
  });
};

interface KnowledgeBody {
  title: string;
  content: string;
  tags?: string[];
}

export default knowledgeRoutes;
