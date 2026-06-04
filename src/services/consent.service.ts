import type { Bot, EndUser } from '@prisma/client';
import { db } from '../db';
import { config } from '../config';
import { getChannelProvider } from '../providers/channel';
import type { MetaCloudCredentials, InteractiveButton } from '../types';

const ACCEPT_ID = 'consent_accept';
const DECLINE_ID = 'consent_decline';

export async function hasConsent(endUserId: string, botId: string): Promise<boolean> {
  // Consent must match the current POLICY_VERSION — a version bump forces re-consent
  const consent = await db.consent.findFirst({
    where: { endUserId, botId, policyVersion: config.POLICY_VERSION },
    orderBy: { acceptedAt: 'desc' },
  });
  return consent !== null;
}

export async function recordConsent(endUserId: string, botId: string): Promise<void> {
  await db.$transaction([
    db.consent.create({ data: { endUserId, botId, policyVersion: config.POLICY_VERSION } }),
    // Clear the declined flag when they accept
    db.endUser.update({ where: { id: endUserId }, data: { consentDeclined: false } }),
  ]);
}

export async function sendOnboarding(
  bot: Bot & { branding: { companyName?: string | null; privacyPolicyUrl?: string | null; termsUrl?: string | null } | null },
  channelProvider: ReturnType<typeof getChannelProvider>,
  channelPhoneId: string,
  channelCreds: MetaCloudCredentials,
  to: string,
  apiVersion: string,
): Promise<void> {
  const companyName = bot.branding?.companyName ?? bot.name;
  const privacyUrl = bot.branding?.privacyPolicyUrl;
  const termsUrl = bot.branding?.termsUrl;

  let bodyText = bot.onboardingMsg
    ?? `Hola, soy el asistente de *${companyName}*. Para continuar necesito tu consentimiento.`;

  if (privacyUrl || termsUrl) {
    const links: string[] = [];
    if (privacyUrl) links.push(`Privacidad: ${privacyUrl}`);
    if (termsUrl) links.push(`Términos: ${termsUrl}`);
    bodyText += `\n\n${links.join('\n')}`;
  }

  const buttons: InteractiveButton[] = [
    { id: ACCEPT_ID, title: 'Acepto' },
    { id: DECLINE_ID, title: 'No acepto' },
  ];

  await channelProvider.sendInteractive({
    phoneId: channelPhoneId,
    accessToken: channelCreds.accessToken,
    to,
    bodyText,
    buttons,
    apiVersion,
  });
}

export function isConsentAccept(buttonId: string): boolean {
  return buttonId === ACCEPT_ID;
}

export function isConsentDecline(buttonId: string): boolean {
  return buttonId === DECLINE_ID;
}

/** Admin-initiated suspension — ignores all future messages. */
export async function pauseEndUser(endUser: EndUser): Promise<void> {
  await db.endUser.update({ where: { id: endUser.id }, data: { paused: true } });
}

/** User-initiated consent decline — they can re-consent by writing again. */
export async function markConsentDeclined(endUserId: string): Promise<void> {
  await db.endUser.update({ where: { id: endUserId }, data: { consentDeclined: true } });
}

export async function deleteEndUserData(endUserId: string): Promise<void> {
  // ARCO right to erasure — cascade deletes all child records (messages, consents,
  // crisisEvents, feedback) via DB-level ON DELETE CASCADE constraints.
  await db.endUser.delete({ where: { id: endUserId } });
}
