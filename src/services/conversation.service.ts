import { createHash } from 'crypto';
import type { BotCommand, BotCrisisConfig, BotKnowledge } from '@prisma/client';
import { db } from '../db';
import { decrypt, decryptJson, encrypt } from '../crypto';
import { config } from '../config';
import { loadChannelByPhoneId, invalidateBotCache } from './bot.service';
import { safetyClassifier } from './safety.service';
import * as consentService from './consent.service';
import { getLLMProvider, LLMCredentialError, LLMRateLimitError } from '../providers/llm';
import { getChannelProvider } from '../providers/channel';
import type { InboundMessageJob, LLMMessage, MetaCloudCredentials, ClassificationResult } from '../types';

export async function processInboundMessage(job: InboundMessageJob): Promise<void> {
  // ── Step 1: Identify bot by phone_id ─────────────────────────────────────
  const channelWithBot = await loadChannelByPhoneId(job.phoneId);
  if (!channelWithBot) {
    // Unknown phone_id — nothing to do
    return;
  }

  const { bot } = channelWithBot;
  const channel = channelWithBot;

  if (bot.status === 'paused') return;

  const channelCreds = decryptJson<MetaCloudCredentials>(channel.credentials);
  const channelProvider = getChannelProvider(channel.provider);

  // ── Step 3: Resolve / create end_user ────────────────────────────────────
  const phoneHash = hashPhone(job.from);
  let endUser = await db.endUser.findFirst({ where: { botId: bot.id, waPhoneHash: phoneHash } });
  if (!endUser) {
    endUser = await db.endUser.create({ data: { botId: bot.id, waPhoneHash: phoneHash, locale: bot.locale } });
  }
  if (endUser.paused) return;

  // ── Consent flow (interactive button replies handled first) ───────────────
  if (job.messageType === 'interactive' && job.interactiveReply) {
    await handleInteractiveReply(job, endUser, bot.id, channelProvider, channel.phoneId, channelCreds);
    return;
  }

  const hasConsent = await consentService.hasConsent(endUser.id, bot.id);
  if (!hasConsent) {
    await consentService.sendOnboarding(bot, channelProvider, channel.phoneId, channelCreds, job.from, config.META_API_VERSION);
    return;
  }

  // ── Step 4: Check for configured command ──────────────────────────────────
  if (job.messageType === 'text' && job.textBody) {
    const command = matchCommand(bot.commands, job.textBody);
    if (command) {
      await executeCommand(command, channelProvider, channel.phoneId, channelCreds, job.from);
      return;
    }
  }

  // ── Step 5: Voice → text (Phase 5) ───────────────────────────────────────
  if (job.messageType === 'audio') {
    await channelProvider.sendText({ phoneId: channel.phoneId, accessToken: channelCreds.accessToken, to: job.from, text: 'Lo siento, los mensajes de voz aún no están disponibles.', apiVersion: config.META_API_VERSION });
    return;
  }

  const inputText = job.textBody?.trim() ?? '';
  if (!inputText) return;

  // ── Step 6: SafetyClassifier on INPUT (platform-controlled, not client LLM) ─
  const inputSafety = safetyClassifier.classify(inputText);
  if (inputSafety.isCrisis) {
    await handleCrisis(bot.id, bot.crisisConfig, endUser.id, channelProvider, channel.phoneId, channelCreds, job.from, inputSafety, 'input_detected');
    return;
  }

  // ── Step 7: Retrieve history + relevant knowledge ─────────────────────────
  const history = await getHistory(bot.id, endUser.id, bot.historyWindow);
  const knowledge = await getRelevantKnowledge(bot.knowledge, inputText);

  // ── Step 8: LLM call (client's provider + key) ────────────────────────────
  if (!bot.llmProvider || !bot.llmModel || !bot.llmApiKeyEnc) {
    await channelProvider.sendText({ phoneId: channel.phoneId, accessToken: channelCreds.accessToken, to: job.from, text: 'El servicio no está configurado aún. Intenta más tarde.', apiVersion: config.META_API_VERSION });
    return;
  }

  const llmProvider = getLLMProvider(bot.llmProvider);
  const apiKey = decrypt(bot.llmApiKeyEnc);
  const systemPrompt = buildSystemPrompt(bot.systemPrompt ?? '', knowledge, bot.branding);

  // Persist inbound message
  await persistMessage(bot.id, endUser.id, 'in', job.messageType === 'text' ? 'text' : 'interactive', inputText, job.waMessageId);

  let responseText: string;
  try {
    const result = await llmProvider.complete({
      systemPrompt,
      history,
      userMessage: inputText,
      params: (bot.llmParams as Record<string, unknown> | null) ?? undefined,
      apiKey,
      model: bot.llmModel,
    });
    responseText = result.text;
  } catch (err) {
    await handleLLMError(err, bot.id, channelProvider, channel.phoneId, channelCreds, job.from);
    return;
  }

  // ── Step 9: SafetyClassifier on OUTPUT ────────────────────────────────────
  const outputSafety = safetyClassifier.classify(responseText);
  if (outputSafety.isCrisis) {
    responseText = buildCrisisMessage(bot.crisisConfig);
    await recordCrisisEvent(bot.id, endUser.id, outputSafety.category ?? 'unknown', 'output_filtered');
  }

  // ── Step 10: Persist outbound message ────────────────────────────────────
  await persistMessage(bot.id, endUser.id, 'out', 'text', responseText);

  // ── Step 11: Send to WhatsApp ─────────────────────────────────────────────
  await channelProvider.sendText({ phoneId: channel.phoneId, accessToken: channelCreds.accessToken, to: job.from, text: responseText, apiVersion: config.META_API_VERSION });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashPhone(phone: string): string {
  return createHash('sha256').update(phone).digest('hex');
}

async function handleInteractiveReply(
  job: InboundMessageJob,
  endUser: { id: string },
  botId: string,
  channelProvider: ReturnType<typeof getChannelProvider>,
  phoneId: string,
  creds: MetaCloudCredentials,
): Promise<void> {
  const reply = job.interactiveReply!;
  if (consentService.isConsentAccept(reply.id)) {
    await consentService.recordConsent(endUser.id, botId);
    await channelProvider.sendText({ phoneId, accessToken: creds.accessToken, to: job.from, text: '¡Gracias! Ya puedes escribirme.', apiVersion: config.META_API_VERSION });
  } else if (consentService.isConsentDecline(reply.id)) {
    await consentService.pauseEndUser(endUser as Parameters<typeof consentService.pauseEndUser>[0]);
    await channelProvider.sendText({ phoneId, accessToken: creds.accessToken, to: job.from, text: 'Entendido. No procesaré tus mensajes. Escríbeme de nuevo si cambias de opinión.', apiVersion: config.META_API_VERSION });
  }
}

function matchCommand(commands: BotCommand[], text: string): BotCommand | undefined {
  const lower = text.trim().toLowerCase().replace(/^\//, '');
  return commands.find(c => c.trigger.toLowerCase() === lower);
}

async function executeCommand(
  command: BotCommand,
  channelProvider: ReturnType<typeof getChannelProvider>,
  phoneId: string,
  creds: MetaCloudCredentials,
  to: string,
): Promise<void> {
  if (command.responseType === 'static') {
    const payload = command.payload as { message?: string };
    if (payload.message) {
      await channelProvider.sendText({ phoneId, accessToken: creds.accessToken, to, text: payload.message, apiVersion: config.META_API_VERSION });
    }
  }
  // 'action' type responses are handled in future phases
}

async function getHistory(botId: string, endUserId: string, windowSize: number): Promise<LLMMessage[]> {
  const msgs = await db.message.findMany({
    where: { botId, endUserId },
    orderBy: { createdAt: 'desc' },
    take: windowSize * 2, // pairs of in/out
  });

  return msgs
    .reverse()
    .map(m => ({
      role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
      content: decrypt(m.bodyEnc),
    }));
}

function getRelevantKnowledge(knowledge: BotKnowledge[], query: string): string {
  if (!knowledge.length) return '';
  const lowerQuery = query.toLowerCase();
  const relevant = knowledge.filter(k => {
    const text = `${k.title} ${k.content} ${k.tags.join(' ')}`.toLowerCase();
    return lowerQuery.split(/\s+/).some(word => word.length > 3 && text.includes(word));
  });
  if (!relevant.length) return '';
  return relevant.map(k => `[${k.title}]\n${k.content}`).join('\n\n');
}

function buildSystemPrompt(
  basePrompt: string,
  knowledge: string,
  branding: { companyName?: string | null; supportContact?: string | null } | null | undefined,
): string {
  let prompt = basePrompt;
  if (knowledge) {
    prompt += `\n\n---\nBase de conocimiento relevante:\n${knowledge}\n---`;
  }
  if (branding?.supportContact) {
    prompt += `\n\nContacto de soporte: ${branding.supportContact}`;
  }
  return prompt;
}

async function persistMessage(
  botId: string,
  endUserId: string,
  direction: 'in' | 'out',
  inputType: string,
  body: string,
  externalId?: string,
): Promise<void> {
  await db.message.create({
    data: {
      botId,
      endUserId,
      direction,
      inputType,
      bodyEnc: encrypt(body),
      externalId: externalId ?? null,
    },
  });
}

async function handleCrisis(
  botId: string,
  crisisConfigs: BotCrisisConfig[],
  endUserId: string,
  channelProvider: ReturnType<typeof getChannelProvider>,
  phoneId: string,
  creds: MetaCloudCredentials,
  to: string,
  safety: ClassificationResult,
  actionTaken: string,
): Promise<void> {
  await recordCrisisEvent(botId, endUserId, safety.category ?? 'unknown', actionTaken);
  const message = buildCrisisMessage(crisisConfigs);
  await channelProvider.sendText({ phoneId, accessToken: creds.accessToken, to, text: message, apiVersion: config.META_API_VERSION });
}

function buildCrisisMessage(crisisConfigs: BotCrisisConfig[]): string {
  const enabled = crisisConfigs.filter(c => c.enabled);
  if (!enabled.length) {
    return 'Parece que estás pasando por un momento difícil. Por favor, busca apoyo con alguien de confianza o llama a una línea de crisis.\n\nMéxico:\n• SAPTEL: 55 5259-8121 (24h)\n• Línea de la Vida: 800 911 2000 (24h)';
  }

  const lines = enabled.flatMap(c => {
    const l = c.lines as Array<{ name: string; phone: string; hours?: string }>;
    return l.map(line => `• ${line.name}: ${line.phone}${line.hours ? ` (${line.hours})` : ''}`);
  });

  return `Parece que estás pasando por un momento muy difícil. No estás solo/a. Por favor comunícate con:\n\n${lines.join('\n')}`;
}

async function recordCrisisEvent(botId: string, endUserId: string, category: string, actionTaken: string): Promise<void> {
  await db.crisisEvent.create({ data: { botId, endUserId, category, actionTaken } });
}

async function handleLLMError(
  err: unknown,
  botId: string,
  channelProvider: ReturnType<typeof getChannelProvider>,
  phoneId: string,
  creds: MetaCloudCredentials,
  to: string,
): Promise<void> {
  if (err instanceof LLMCredentialError) {
    // Mark the bot and stop — do not retry
    await db.bot.update({ where: { id: botId }, data: { status: 'credential_error' } });
    invalidateBotCache(botId);
    await channelProvider.sendText({ phoneId, accessToken: creds.accessToken, to, text: 'El servicio no está disponible en este momento. Inténtalo más tarde.', apiVersion: config.META_API_VERSION });
    return;
  }
  if (err instanceof LLMRateLimitError) {
    // Re-throw so BullMQ retries with backoff
    throw err;
  }
  // Unknown error — re-throw for BullMQ retry
  throw err;
}
