import OpenAI, { toFile } from 'openai';
import type { Transcriber, TranscribeOptions } from './types';
import { SttCredentialError } from './types';

export class WhisperTranscriber implements Transcriber {
  async transcribe(opts: TranscribeOptions): Promise<string> {
    const client = new OpenAI({ apiKey: opts.apiKey });

    // Whisper uses ISO-639-1 language codes; strip region (e.g. 'es-MX' → 'es')
    const language = opts.language?.split(/[-_]/)[0];

    let response: { text: string };
    try {
      const audioFile = await toFile(opts.audioBuffer, 'audio.ogg', { type: opts.mimeType });
      response = await client.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        ...(language ? { language } : {}),
      });
    } catch (err) {
      if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
        throw new SttCredentialError(`Whisper auth failed: ${(err as Error).message}`);
      }
      throw err;
    }

    return response.text;
  }
}
