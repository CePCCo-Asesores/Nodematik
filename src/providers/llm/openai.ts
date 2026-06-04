import OpenAI from 'openai';
import type { LLMProvider } from './types';
import { LLMCredentialError, LLMRateLimitError } from './types';
import { recordLLMUsage, recordLLMError } from '../../services/metrics.service';
import type { LLMCompletionInput, LLMCompletionOutput } from '../../types';

export class OpenAIProvider implements LLMProvider {
  async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
    const client = new OpenAI({ apiKey: input.apiKey });

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.history.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: input.userMessage },
    ];

    const startMs = Date.now();
    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model: input.model,
        messages,
        max_tokens: (input.params?.max_tokens as number | undefined) ?? 1024,
        temperature: input.params?.temperature as number | undefined,
      });
    } catch (err) {
      recordLLMError('openai', err instanceof OpenAI.RateLimitError ? 'rate_limit' : 'api_error');
      throw translateError(err);
    }

    const durationMs = Date.now() - startMs;
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;
    recordLLMUsage('openai', input.model, durationMs, inputTokens, outputTokens);

    return {
      text: response.choices[0]?.message?.content ?? '',
      usage: { inputTokens, outputTokens },
    };
  }
}

function translateError(err: unknown): Error {
  if (err instanceof OpenAI.AuthenticationError) {
    return new LLMCredentialError(`OpenAI authentication failed: ${(err as Error).message}`);
  }
  if (err instanceof OpenAI.PermissionDeniedError) {
    return new LLMCredentialError(`OpenAI permission denied: ${(err as Error).message}`);
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new LLMRateLimitError(`OpenAI rate limit: ${(err as Error).message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
