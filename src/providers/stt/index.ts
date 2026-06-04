import type { Transcriber } from './types';
import { WhisperTranscriber } from './whisper';

export { SttCredentialError, SttError } from './types';
export type { Transcriber };

const registry = new Map<string, Transcriber>();

registry.set('openai_whisper', new WhisperTranscriber());
registry.set('whisper', new WhisperTranscriber()); // alias

export function getTranscriber(provider: string): Transcriber {
  const t = registry.get(provider);
  if (!t) throw new Error(`Unknown STT provider: "${provider}". Registered: ${[...registry.keys()].join(', ')}`);
  return t;
}
