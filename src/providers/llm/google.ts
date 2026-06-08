import type { LLMProvider } from './types';
import { LLMCredentialError, LLMRateLimitError } from './types';
import { recordLLMUsage, recordLLMError } from '../../services/metrics.service';
import type { LLMCompletionInput, LLMCompletionOutput } from '../../types';

/**
 * Proveedor de Google Gemini (API REST generativelanguage.googleapis.com).
 * Implementado con fetch directo para no añadir dependencias al build.
 * Gemini ofrece un tier gratuito generoso (sin tarjeta) vía Google AI Studio,
 * lo que reduce la fricción para que un cliente pruebe Nodematik con su propia clave.
 */
export class GoogleProvider implements LLMProvider {
  async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
    // Gemini separa el system prompt (systemInstruction) del historial (contents).
    // El historial alterna user/model; aquí mapeamos 'assistant' -> 'model'.
    const contents = [
      ...input.history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      { role: 'user', parts: [{ text: input.userMessage }] },
    ];

    const body: Record<string, unknown> = {
      contents,
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      generationConfig: {
        maxOutputTokens: (input.params?.max_tokens as number | undefined) ?? 1024,
        ...(input.params?.temperature !== undefined
          ? { temperature: input.params.temperature as number }
          : {}),
      },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      input.model,
    )}:generateContent`;

    const startMs = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // La clave del cliente va en header (no en query) para no filtrarla en logs/URLs.
          'x-goog-api-key': input.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      recordLLMError('google', 'api_error');
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // 400/401/403 con clave inválida -> error de credencial (no reintentar).
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        recordLLMError('google', 'api_error');
        throw new LLMCredentialError(`Google Gemini authentication failed (${res.status}): ${errText}`);
      }
      if (res.status === 429) {
        recordLLMError('google', 'rate_limit');
        const retryAfter = Number(res.headers.get('retry-after') ?? 0) * 1000;
        throw new LLMRateLimitError(`Google Gemini rate limit: ${errText}`, retryAfter || undefined);
      }
      recordLLMError('google', 'api_error');
      throw new Error(`Google Gemini API error (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const durationMs = Date.now() - startMs;
    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    recordLLMUsage('google', input.model, durationMs, inputTokens, outputTokens);

    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
    return { text, usage: { inputTokens, outputTokens } };
  }
}
