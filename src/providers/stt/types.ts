export interface TranscribeOptions {
  audioBuffer: Buffer;
  mimeType: string;
  language?: string; // BCP-47 e.g. 'es-MX' or ISO-639-1 'es'
  apiKey: string;
}

export interface Transcriber {
  transcribe(opts: TranscribeOptions): Promise<string>;
}

export class SttCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SttCredentialError';
  }
}

export class SttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SttError';
  }
}
