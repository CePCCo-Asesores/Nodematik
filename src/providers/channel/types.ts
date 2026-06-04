import type {
  ParsedWebhook,
  SendTextOptions,
  SendInteractiveOptions,
  SendTemplateOptions,
} from '../../types';

export interface ChannelProvider {
  parseInbound(payload: unknown): ParsedWebhook;
  sendText(opts: SendTextOptions): Promise<void>;
  sendInteractive(opts: SendInteractiveOptions): Promise<void>;
  sendTemplate(opts: SendTemplateOptions): Promise<void>;
}
