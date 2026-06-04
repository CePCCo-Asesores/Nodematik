import type { Bot, BotBranding, BotCommand, BotCrisisConfig, BotIntegration, BotKnowledge, Channel } from '@prisma/client';
import { db } from '../db';

export type BotWithRelations = Bot & {
  branding: BotBranding | null;
  commands: BotCommand[];
  crisisConfig: BotCrisisConfig[];
  channels: Channel[];
  knowledge: BotKnowledge[];
  integrations: BotIntegration[];
};

export type ChannelWithBot = Channel & {
  bot: BotWithRelations;
};

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const BOT_CACHE_TTL_MS = 5 * 60 * 1000;
const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

const botCache = new Map<string, CacheEntry<BotWithRelations>>();
const channelCache = new Map<string, CacheEntry<ChannelWithBot>>();

const BOT_INCLUDES = {
  branding: true,
  commands: true,
  crisisConfig: true,
  channels: true,
  knowledge: true,
  integrations: true,
} as const;

export async function loadChannelByPhoneId(phoneId: string): Promise<ChannelWithBot | null> {
  const cached = channelCache.get(phoneId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const channel = await db.channel.findFirst({
    where: { phoneId },
    include: { bot: { include: BOT_INCLUDES } },
  });

  if (!channel) return null;

  const entry: CacheEntry<ChannelWithBot> = {
    value: channel as ChannelWithBot,
    expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS,
  };
  channelCache.set(phoneId, entry);
  return entry.value;
}

export async function loadBotById(botId: string): Promise<BotWithRelations | null> {
  const cached = botCache.get(botId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const bot = await db.bot.findUnique({
    where: { id: botId },
    include: BOT_INCLUDES,
  });

  if (!bot) return null;

  const entry: CacheEntry<BotWithRelations> = {
    value: bot,
    expiresAt: Date.now() + BOT_CACHE_TTL_MS,
  };
  botCache.set(botId, entry);
  return entry.value;
}

export function invalidateBotCache(botId: string): void {
  botCache.delete(botId);
  for (const [key, entry] of channelCache) {
    if (entry.value.botId === botId) channelCache.delete(key);
  }
}
