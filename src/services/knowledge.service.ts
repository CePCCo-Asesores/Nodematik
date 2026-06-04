import OpenAI from 'openai';
import type { BotKnowledge } from '@prisma/client';

const SIMILARITY_THRESHOLD = 0.35;
const TOP_N = 3;

// ─── Embedding codec ──────────────────────────────────────────────────────────

export function encodeEmbedding(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

export function decodeEmbedding(data: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  // Float32Array needs 4-byte alignment; copy if needed
  if (buf.byteOffset % 4 !== 0) {
    const aligned = Buffer.allocUnsafe(buf.byteLength);
    buf.copy(aligned);
    return new Float32Array(aligned.buffer, 0, aligned.byteLength / 4);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Embedding generation ─────────────────────────────────────────────────────

export async function generateEmbedding(
  text: string,
  apiKey: string,
  model = 'text-embedding-3-small',
): Promise<number[]> {
  const client = new OpenAI({ apiKey });
  const response = await client.embeddings.create({ model, input: text });
  return response.data[0].embedding;
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

export function getByKeyword(knowledge: BotKnowledge[], query: string): BotKnowledge[] {
  const lowerQuery = query.toLowerCase();
  const words = lowerQuery.split(/\s+/).filter(w => w.length > 3);
  if (!words.length) return [];
  return knowledge.filter(k => {
    const haystack = `${k.title} ${k.content} ${k.tags.join(' ')}`.toLowerCase();
    return words.some(w => haystack.includes(w));
  });
}

export async function getRelevantKnowledge(
  knowledge: BotKnowledge[],
  query: string,
  embedderApiKey?: string,
): Promise<string> {
  if (!knowledge.length) return '';

  // Semantic path — only when an embedder key is provided AND at least one entry
  // has a stored embedding
  if (embedderApiKey) {
    const withEmbeddings = knowledge.filter(k => k.embeddingData);
    if (withEmbeddings.length > 0) {
      try {
        return await semanticRetrieval(knowledge, query, embedderApiKey);
      } catch {
        // Embedding call failed — fall through to keyword
      }
    }
  }

  // Keyword fallback (always available, no API call)
  const relevant = getByKeyword(knowledge, query);
  return formatKnowledge(relevant.slice(0, TOP_N));
}

async function semanticRetrieval(
  knowledge: BotKnowledge[],
  query: string,
  apiKey: string,
): Promise<string> {
  const queryVec = new Float32Array(await generateEmbedding(query, apiKey));

  const withEmbeddings = knowledge.filter(k => k.embeddingData);
  const scored = withEmbeddings.map(k => ({
    entry: k,
    score: cosineSimilarity(queryVec, decodeEmbedding(k.embeddingData!)),
  }));

  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.slice(0, TOP_N).filter(s => s.score >= SIMILARITY_THRESHOLD);

  if (!relevant.length) {
    // Nothing above threshold — try keyword on the full set
    return formatKnowledge(getByKeyword(knowledge, query).slice(0, TOP_N));
  }

  return formatKnowledge(relevant.map(r => r.entry));
}

function formatKnowledge(entries: BotKnowledge[]): string {
  if (!entries.length) return '';
  return entries.map(k => `[${k.title}]\n${k.content}`).join('\n\n');
}
