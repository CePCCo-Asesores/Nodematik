import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhisperTranscriber } from '../src/providers/stt/whisper';
import { getTranscriber } from '../src/providers/stt';
import { SttCredentialError } from '../src/providers/stt/types';

// ── Stable mock objects ───────────────────────────────────────────────────────

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({ text: 'hola mundo esto es una prueba' }),
}));

// ── Module mock ───────────────────────────────────────────────────────────────

vi.mock('openai', () => {
  class AuthenticationError extends Error { status = 401; }
  class PermissionDeniedError extends Error { status = 403; }

  const MockOpenAI = vi.fn().mockImplementation(() => ({
    audio: { transcriptions: { create: mockCreate } },
  }));
  (MockOpenAI as unknown as Record<string, unknown>).AuthenticationError = AuthenticationError;
  (MockOpenAI as unknown as Record<string, unknown>).PermissionDeniedError = PermissionDeniedError;

  return { default: MockOpenAI, toFile: vi.fn().mockResolvedValue('mocked-file') };
});

// ─────────────────────────────────────────────────────────────────────────────

describe('WhisperTranscriber', () => {
  beforeEach(() => {
    mockCreate.mockResolvedValue({ text: 'hola mundo esto es una prueba' });
  });

  it('returns transcribed text from OpenAI Whisper', async () => {
    const transcriber = new WhisperTranscriber();
    const result = await transcriber.transcribe({
      audioBuffer: Buffer.from('fake-audio-bytes'),
      mimeType: 'audio/ogg; codecs=opus',
      language: 'es-MX',
      apiKey: 'sk-test-key',
    });
    expect(result).toBe('hola mundo esto es una prueba');
  });

  it('strips region from language code before passing to Whisper', async () => {
    const transcriber = new WhisperTranscriber();
    await transcriber.transcribe({
      audioBuffer: Buffer.from('fake'),
      mimeType: 'audio/ogg',
      language: 'es-MX',
      apiKey: 'sk-test',
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'es' }),
    );
  });

  it('throws SttCredentialError on authentication failure', async () => {
    const OpenAI = (await import('openai')).default;
    const AuthErr = (OpenAI as unknown as Record<string, new (m: string) => Error>).AuthenticationError;
    mockCreate.mockRejectedValueOnce(new AuthErr('invalid api key'));

    const transcriber = new WhisperTranscriber();
    await expect(transcriber.transcribe({
      audioBuffer: Buffer.from('fake'),
      mimeType: 'audio/ogg',
      apiKey: 'bad-key',
    })).rejects.toThrow(SttCredentialError);
  });
});

describe('STT provider registry', () => {
  it('resolves openai_whisper to WhisperTranscriber', () => {
    expect(getTranscriber('openai_whisper')).toBeInstanceOf(WhisperTranscriber);
  });

  it('resolves whisper alias to WhisperTranscriber', () => {
    expect(getTranscriber('whisper')).toBeInstanceOf(WhisperTranscriber);
  });

  it('throws for unknown provider', () => {
    expect(() => getTranscriber('deepgram')).toThrow('Unknown STT provider');
  });
});
