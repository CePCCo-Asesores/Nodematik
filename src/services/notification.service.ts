// Notification service — Phase A: structured console logging (visible in Railway logs)
// Phase B: swap in email/webhook per org_user contact.
//
// Callers must NOT include credentials, message content, or user identifiers.

export interface CredentialErrorEvent {
  botId: string;
  botName: string;
  errorMessage: string;
  detectedAt: Date;
}

export function notifyCredentialError(event: CredentialErrorEvent): void {
  // Structured log — Railway log explorer can filter on these fields
  console.error(JSON.stringify({
    level: 'alert',
    type: 'credential_error',
    botId: event.botId,
    botName: event.botName,
    // Truncate to avoid leaking any embedded key fragment from error messages
    error: event.errorMessage.slice(0, 120),
    detectedAt: event.detectedAt.toISOString(),
  }));
  // Phase B: send email to org owner, post webhook to branding.supportContact, etc.
}

export function notifyBotRestored(botId: string, botName: string): void {
  console.info(JSON.stringify({
    level: 'info',
    type: 'bot_restored',
    botId,
    botName,
    restoredAt: new Date().toISOString(),
  }));
}
