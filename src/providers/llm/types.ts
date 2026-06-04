import type { LLMCompletionInput, LLMCompletionOutput } from '../../types';

export interface LLMProvider {
  complete(input: LLMCompletionInput): Promise<LLMCompletionOutput>;
}

// Errors that signal a bad/expired key or exceeded quota — should trigger
// credential_error status on the bot and NOT be retried endlessly.
export class LLMCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMCredentialError';
  }
}

export class LLMRateLimitError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'LLMRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}
