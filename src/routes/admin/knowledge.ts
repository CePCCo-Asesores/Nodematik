import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { invalidateBotCache } from '../../services/bot.service';
import { generateEmbedding, encodeEmbedding } from '../../services/knowledge.service';
import { decrypt } from '../../crypto';

const knowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { botId: string } }>('/:botId/knowledge', async (req, reply) => {
    const items = await db.botKnowledge.findMany({
      where: { botId: req.params.botId },
      select: { id: true, botId: true, title: true, content: true, tags: true, hasEmbedding: true },
    });
    return reply.send(items);
  });

  fastify.post<{ Params: { botId: string }; Body: KnowledgeBody }>('/:botId/knowledge', async (req, reply) => {
    const item = await db.botKnowledge.create({
      data: { botId: req.params.botId, title: req.body.title, content: req.body.content, tags: req.body.tags ?? [] },
    });
    invalidateBotCache(req.params.botId);
    return reply.status(201).send(item);
  });

  fastify.put<{ Params: { botId: string; itemId: string }; Body: Partial<KnowledgeBody> }>('/:botId/knowledge/:itemId', async (req, reply) => {
    const updateData: Prisma.BotKnowledgeUpdateInput = {};
    if (req.body.title !== undefined) updateData.title = req.body.title;
    if (req.body.content !== undefined) updateData.content = req.body.content;
    if (req.body.tags !== undefined) updateData.tags = req.body.tags;
    // Clear embedding when content changes — it becomes stale
    if (req.body.content !== undefined) {
      updateData.embeddingData = null;
      updateData.hasEmbedding = false;
    }
    const item = await db.botKnowledge.update({ where: { id: req.params.itemId }, data: updateData });
    invalidateBotCache(req.params.botId);
    return reply.send(item);
  });

  fastify.delete<{ Params: { botId: string; itemId: string } }>('/:botId/knowledge/:itemId', async (req, reply) => {
    await db.botKnowledge.delete({ where: { id: req.params.itemId } });
    invalidateBotCache(req.params.botId);
    return reply.status(204).send();
  });

  // Generate / refresh embeddings for all knowledge entries of a bot.
  // Uses the bot's OpenAI LLM key if available; otherwise a dedicated embeddings integration.
  fastify.post<{ Params: { botId: string } }>('/:botId/knowledge/embed', async (req, reply) => {
    const bot = await db.bot.findUnique({
      where: { id: req.params.botId },
      include: { knowledge: true, integrations: { where: { kind: 'embeddings', status: 'active' } } },
    });
    if (!bot) return reply.status(404).send({ error: 'Bot not found' });

    // Resolve the embedding API key
    let embedApiKey: string | undefined;
    if (bot.integrations.length > 0) {
      const creds = JSON.parse(decrypt(bot.integrations[0].credentials)) as { apiKey: string };
      embedApiKey = creds.apiKey;
    } else if (bot.llmProvider === 'openai' && bot.llmApiKeyEnc) {
      embedApiKey = decrypt(bot.llmApiKeyEnc);
    }

    if (!embedApiKey) {
      return reply.status(422).send({ error: 'No embedding API key configured. Add an OpenAI LLM key or a dedicated embeddings integration.' });
    }

    let updated = 0;
    let failed = 0;
    for (const entry of bot.knowledge) {
      try {
        const vec = await generateEmbedding(`${entry.title}\n${entry.content}`, embedApiKey);
        await db.botKnowledge.update({
          where: { id: entry.id },
          data: { embeddingData: encodeEmbedding(vec), hasEmbedding: true },
        });
        updated++;
      } catch {
        failed++;
      }
    }

    invalidateBotCache(req.params.botId);
    return reply.send({ updated, failed, total: bot.knowledge.length });
  });
};

interface KnowledgeBody {
  title: string;
  content: string;
  tags?: string[];
}

export default knowledgeRoutes;
