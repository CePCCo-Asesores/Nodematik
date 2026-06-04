import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';

const feedbackRoutes: FastifyPluginAsync = async (fastify) => {
  // List feedback entries for a bot (newest first)
  fastify.get<{ Params: { botId: string }; Querystring: { limit?: string } }>('/:botId/feedback', async (req, reply) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const entries = await db.feedback.findMany({
      where: { message: { botId: req.params.botId } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, rating: true, createdAt: true, messageId: true },
    });
    return reply.send(entries);
  });

  // Aggregate stats for a bot
  fastify.get<{ Params: { botId: string } }>('/:botId/feedback/stats', async (req, reply) => {
    const entries = await db.feedback.findMany({
      where: { message: { botId: req.params.botId } },
      select: { rating: true },
    });

    if (!entries.length) return reply.send({ count: 0, average: null, distribution: {} });

    const distribution: Record<number, number> = {};
    let sum = 0;
    for (const { rating } of entries) {
      sum += rating;
      distribution[rating] = (distribution[rating] ?? 0) + 1;
    }

    return reply.send({
      count: entries.length,
      average: Number((sum / entries.length).toFixed(2)),
      distribution,
    });
  });
};

export default feedbackRoutes;
