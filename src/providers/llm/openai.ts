import OpenAI from 'openai';
import type { LLMProvider } from './types';
import { LLMCredentialError, LLMRateLimitError } from './types';
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

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model: input.model,
        messages,
        max_tokens: (input.params?.max_tokens as number | undefined) ?? 1024,
        temperature: input.params?.temperature as number | undefined,
      });
    } catch (err) {
      throw translateError(err);
    }

    return {
      text: response.choices[0]?.message?.content ?? '',
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
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
