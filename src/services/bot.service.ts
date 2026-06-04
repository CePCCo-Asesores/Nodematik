import type { Bot, BotBranding, BotCommand, BotCrisisConfig, BotKnowledge, Channel } from '@prisma/client';
import { db } from '../db';

// Full bot config loaded from DB — includes all related tables needed by the engine
export type BotWithRelations = Bot & {
  branding: BotBranding | null;
  commands: BotCommand[];
  crisisConfig: BotCrisisConfig[];
  channels: Channel[];
  knowledge: BotKnowledge[];
};

// Channel + its bot loaded by phoneId — the primary routing lookup
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

// Call after any bot mutation so the next request gets fresh data
export function invalidateBotCache(botId: string): void {
  botCache.delete(botId);
  // Also invalidate any channel entries pointing at this bot
  for (const [key, entry] of channelCache) {
    if (entry.value.botId === botId) channelCache.delete(key);
  }
}
