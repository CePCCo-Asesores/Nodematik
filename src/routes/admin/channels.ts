import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { encryptJson, decryptJson } from '../../crypto';
import { invalidateBotCache } from '../../services/bot.service';
import type { MetaCloudCredentials } from '../../types';

const channelRoutes: FastifyPluginAsync = async (fastify) => {
  // List channels for a bot
  fastify.get<{ Params: { botId: string } }>('/:botId/channels', async (req, reply) => {
    const channels = await db.channel.findMany({ where: { botId: req.params.botId } });
    return reply.send(channels.map(sanitizeChannel));
  });

  // Add channel to a bot
  fastify.post<{ Params: { botId: string }; Body: CreateChannelBody }>('/:botId/channels', async (req, reply) => {
    const { botId } = req.params;
    const { provider, phoneId, accessToken, businessAccountId, verifyToken } = req.body;

    const creds: MetaCloudCredentials = { accessToken, businessAccountId };
    const channel = await db.channel.create({
      data: {
        botId,
        provider,
        phoneId,
        credentials: encryptJson(creds),
        verifyToken,
        status: 'connected',
      },
    });

    invalidateBotCache(botId);
    return reply.status(201).send(sanitizeChannel(channel));
  });

  // Update channel (rotate token, change status)
  fastify.put<{ Params: { botId: string; channelId: string }; Body: UpdateChannelBody }>('/:botId/channels/:channelId', async (req, reply) => {
    const { botId, channelId } = req.params;
    const body = req.body;

    const existing = await db.channel.findUnique({ where: { id: channelId } });
    if (!existing) return reply.status(404).send({ error: 'Channel not found' });

    const data: Record<string, unknown> = {};
    if (body.status !== undefined) data.status = body.status;
    if (body.verifyToken !== undefined) data.verifyToken = body.verifyToken;

    if (body.accessToken !== undefined) {
      const existingCreds = decryptJson<MetaCloudCredentials>(existing.credentials);
      const newCreds: MetaCloudCredentials = {
        ...existingCreds,
        accessToken: body.accessToken,
        ...(body.businessAccountId ? { businessAccountId: body.businessAccountId } : {}),
      };
      data.credentials = encryptJson(newCreds);
    }

    const channel = await db.channel.update({ where: { id: channelId }, data });
    invalidateBotCache(botId);
    return reply.send(sanitizeChannel(channel));
  });

  // Delete channel
  fastify.delete<{ Params: { botId: string; channelId: string } }>('/:botId/channels/:channelId', async (req, reply) => {
    await db.channel.delete({ where: { id: req.params.channelId } });
    invalidateBotCache(req.params.botId);
    return reply.status(204).send();
  });
};

function sanitizeChannel(channel: Record<string, unknown>): Record<string, unknown> {
  const { credentials, ...rest } = channel;
  void credentials;
  return rest;
}

interface CreateChannelBody {
  provider: string;
  phoneId: string;
  accessToken: string;
  businessAccountId?: string;
  verifyToken: string;
}

interface UpdateChannelBody {
  status?: string;
  verifyToken?: string;
  accessToken?: string;
  businessAccountId?: string;
}

export default channelRoutes;
