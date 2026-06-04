import type { ChannelProvider } from './types';
import type {
  ParsedWebhook,
  InboundMessage,
  SendTextOptions,
  SendInteractiveOptions,
  SendTemplateOptions,
} from '../../types';

const GRAPH_BASE = 'https://graph.facebook.com';

export class MetaCloudProvider implements ChannelProvider {
  parseInbound(payload: unknown): ParsedWebhook {
    const body = payload as MetaWebhookBody;
    const messages: InboundMessage[] = [];

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        const phoneId = value?.metadata?.phone_number_id;
        if (!phoneId) continue;

        for (const msg of value.messages ?? []) {
          messages.push(normalizeMessage(phoneId, msg));
        }
      }
    }

    return { messages };
  }

  async sendText(opts: SendTextOptions): Promise<void> {
    await this.post(opts.apiVersion, opts.phoneId, opts.accessToken, {
      messaging_product: 'whatsapp',
      to: opts.to,
      type: 'text',
      text: { body: opts.text },
    });
  }

  async sendInteractive(opts: SendInteractiveOptions): Promise<void> {
    await this.post(opts.apiVersion, opts.phoneId, opts.accessToken, {
      messaging_product: 'whatsapp',
      to: opts.to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: opts.bodyText },
        action: {
          buttons: opts.buttons.map(b => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  }

  async sendTemplate(opts: SendTemplateOptions): Promise<void> {
    await this.post(opts.apiVersion, opts.phoneId, opts.accessToken, {
      messaging_product: 'whatsapp',
      to: opts.to,
      type: 'template',
      template: {
        name: opts.templateName,
        language: { code: opts.languageCode },
        components: opts.components ?? [],
      },
    });
  }

  private async post(
    apiVersion: string,
    phoneId: string,
    accessToken: string,
    body: unknown,
  ): Promise<void> {
    const url = `${GRAPH_BASE}/${apiVersion}/${phoneId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new MetaApiError(`Meta API error ${res.status}: ${text}`);
      err.statusCode = res.status;
      throw err;
    }
  }
}

export class MetaApiError extends Error {
  statusCode?: number;
}

function normalizeMessage(phoneId: string, msg: MetaMessage): InboundMessage {
  const base = {
    phoneId,
    from: msg.from,
    messageId: msg.id,
    timestamp: Number(msg.timestamp),
  };

  if (msg.type === 'text') {
    return { ...base, type: 'text', textBody: msg.text?.body };
  }
  if (msg.type === 'audio') {
    return { ...base, type: 'audio', audioId: msg.audio?.id };
  }
  if (msg.type === 'interactive') {
    const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
    return {
      ...base,
      type: 'interactive',
      interactiveReply: reply
        ? { type: msg.interactive!.type as 'button_reply' | 'list_reply', id: reply.id, title: reply.title }
        : undefined,
    };
  }
  if (msg.type === 'image') {
    return { ...base, type: 'image' };
  }

  return { ...base, type: 'unknown' };
}

// ─── Meta webhook payload types ───────────────────────────────────────────────

interface MetaWebhookBody {
  object?: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      field: string;
      value?: MetaChangeValue;
    }>;
  }>;
}

interface MetaChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  messages?: MetaMessage[];
}

interface MetaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string };
  image?: { id: string; mime_type?: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
}
