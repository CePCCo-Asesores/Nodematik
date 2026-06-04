import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { encryptJson, decryptJson } from '../../crypto';
import { invalidateBotCache } from '../../services/bot.service';

const integrationRoutes: FastifyPluginAsync = async (fastify) => {
  // List integrations for a bot (credentials redacted)
  fastify.get<{ Params: { botId: string } }>('/:botId/integrations', async (req, reply) => {
    const integrations = await db.botIntegration.findMany({ where: { botId: req.params.botId } });
    return reply.send(integrations.map(sanitize));
  });

  // Add integration
  fastify.post<{ Params: { botId: string }; Body: CreateIntegrationBody }>('/:botId/integrations', async (req, reply) => {
    const { botId } = req.params;
    const { kind, provider, apiKey, ...extra } = req.body;
    const integration = await db.botIntegration.create({
      data: {
        botId,
        kind,
        provider,
        credentials: encryptJson({ apiKey, ...extra }),
        status: 'active',
      },
    });
    invalidateBotCache(botId);
    return reply.status(201).send(sanitize(integration));
  });

  // Update integration (e.g. rotate key)
  fastify.put<{ Params: { botId: string; integrationId: string }; Body: UpdateIntegrationBody }>('/:botId/integrations/:integrationId', async (req, reply) => {
    const { botId, integrationId } = req.params;
    const existing = await db.botIntegration.findUnique({ where: { id: integrationId } });
    if (!existing || existing.botId !== botId) return reply.status(404).send({ error: 'Integration not found' });

    const data: Record<string, unknown> = {};
    if (req.body.status !== undefined) data.status = req.body.status;
    if (req.body.apiKey !== undefined) {
      const existingCreds = decryptJson<Record<string, unknown>>(existing.credentials);
      data.credentials = encryptJson({ ...existingCreds, apiKey: req.body.apiKey });
    }

    const updated = await db.botIntegration.update({ where: { id: integrationId }, data });
    invalidateBotCache(botId);
    return reply.send(sanitize(updated));
  });

  // Delete integration
  fastify.delete<{ Params: { botId: string; integrationId: string } }>('/:botId/integrations/:integrationId', async (req, reply) => {
    const { botId, integrationId } = req.params;
    await db.botIntegration.delete({ where: { id: integrationId } });
    invalidateBotCache(botId);
    return reply.status(204).send();
  });
};

function sanitize(i: Record<string, unknown>) {
  const { credentials, ...rest } = i;
  void credentials;
  return rest;
}

interface CreateIntegrationBody {
  kind: string;     // 'stt' | 'embeddings' | ...
  provider: string; // 'openai_whisper' | 'openai' | ...
  apiKey: string;
  [extra: string]: unknown;
}

interface UpdateIntegrationBody {
  status?: string;
  apiKey?: string;
}

export default integrationRoutes;
