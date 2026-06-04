import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider } from './types';
import { LLMCredentialError, LLMRateLimitError } from './types';
import { recordLLMUsage, recordLLMError } from '../../services/metrics.service';
import type { LLMCompletionInput, LLMCompletionOutput } from '../../types';

export class AnthropicProvider implements LLMProvider {
  async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
    const client = new Anthropic({ apiKey: input.apiKey });

    const messages: Anthropic.MessageParam[] = [
      ...input.history.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: input.userMessage },
    ];

    const startMs = Date.now();
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: input.model,
        system: input.systemPrompt,
        messages,
        max_tokens: (input.params?.max_tokens as number | undefined) ?? 1024,
        temperature: input.params?.temperature as number | undefined,
      });
    } catch (err) {
      recordLLMError('anthropic', err instanceof Anthropic.RateLimitError ? 'rate_limit' : 'api_error');
      throw translateError(err);
    }

    const durationMs = Date.now() - startMs;
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    recordLLMUsage('anthropic', input.model, durationMs, inputTokens, outputTokens);

    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    return { text, usage: { inputTokens, outputTokens } };
  }
}

function translateError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new LLMCredentialError(`Anthropic authentication failed: ${(err as Error).message}`);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new LLMCredentialError(`Anthropic permission denied: ${(err as Error).message}`);
  }
  if (err instanceof Anthropic.RateLimitError) {
    const retryAfter = Number((err as { headers?: Record<string, string> }).headers?.['retry-after'] ?? 0) * 1000;
    return new LLMRateLimitError(`Anthropic rate limit: ${(err as Error).message}`, retryAfter || undefined);
  }
  return err instanceof Error ? err : new Error(String(err));
}
