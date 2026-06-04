import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { invalidateBotCache } from '../../services/bot.service';
import { generateEmbedding, encodeEmbedding } from '../../services/knowledge.service';
import { decrypt, decryptJson } from '../../crypto';
import { parseBody, KnowledgeSchema, UpdateKnowledgeSchema } from '../../lib/validate';

const knowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { botId: string } }>('/:botId/knowledge', async (req, reply) => {
    const items = await db.botKnowledge.findMany({
      where: { botId: req.params.botId },
      select: { id: true, botId: true, title: true, content: true, tags: true, hasEmbedding: true },
    });
    return reply.send(items);
  });

  fastify.post<{ Params: { botId: string } }>('/:botId/knowledge', async (req, reply) => {
    const { title, content, tags } = parseBody(KnowledgeSchema, req.body);
    const item = await db.botKnowledge.create({
      data: { botId: req.params.botId, title, content, tags: tags ?? [] },
    });
    invalidateBotCache(req.params.botId);
    return reply.status(201).send(item);
  });

  fastify.put<{ Params: { botId: string; itemId: string } }>('/:botId/knowledge/:itemId', async (req, reply) => {
    const body = parseBody(UpdateKnowledgeSchema, req.body);
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.content !== undefined) {
      data.content = body.content;
      // Clear embedding when content changes — it becomes stale
      data.embeddingData = null;
      data.hasEmbedding = false;
    }
    if (body.tags !== undefined) data.tags = body.tags;
    const item = await db.botKnowledge.update({ where: { id: req.params.itemId }, data });
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
      const creds = decryptJson<{ apiKey: string }>(bot.integrations[0].credentials);
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

export default knowledgeRoutes;
