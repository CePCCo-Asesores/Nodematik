import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getByKeyword,
  getRelevantKnowledge,
  encodeEmbedding,
  decodeEmbedding,
  generateEmbedding,
} from '../src/services/knowledge.service';
import type { BotKnowledge } from '@prisma/client';

// ── Stable mock objects ───────────────────────────────────────────────────────

const { mockEmbeddingsCreate } = vi.hoisted(() => ({
  mockEmbeddingsCreate: vi.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
}));

// ── Module mock ───────────────────────────────────────────────────────────────

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: { create: mockEmbeddingsCreate },
  })),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEntry(id: string, title: string, content: string, tags: string[] = [], embeddingVec?: number[]): BotKnowledge {
  return {
    id,
    botId: 'bot-1',
    title,
    content,
    tags,
    embeddingData: embeddingVec ? encodeEmbedding(embeddingVec) : null,
    hasEmbedding: !!embeddingVec,
  };
}

const KB: BotKnowledge[] = [
  makeEntry('e1', 'Serpientes en sueños', 'Las serpientes suelen representar transformación o peligro latente.', ['serpiente', 'transformación']),
  makeEntry('e2', 'Volar en sueños', 'Soñar que vuelas puede indicar deseo de libertad o escapar de problemas.', ['volar', 'libertad']),
  makeEntry('e3', 'Agua en sueños', 'El agua simboliza las emociones y el subconsciente.', ['agua', 'emoción']),
];

// ─── Keyword retrieval ────────────────────────────────────────────────────────

describe('getByKeyword', () => {
  it('returns entries matching a query word', () => {
    const results = getByKeyword(KB, 'soñé con serpientes');
    expect(results.map(r => r.id)).toContain('e1');
  });

  it('returns entries matching via tags', () => {
    const results = getByKeyword(KB, 'libertad');
    expect(results.map(r => r.id)).toContain('e2');
  });

  it('returns empty array when no match', () => {
    const results = getByKeyword(KB, 'dinosaurio');
    expect(results).toHaveLength(0);
  });

  it('ignores short words (≤3 chars)', () => {
    const results = getByKeyword(KB, 'en el');
    expect(results).toHaveLength(0);
  });

  it('matches multiple entries for broad queries', () => {
    const results = getByKeyword(KB, 'sueños emoción transformación');
    const ids = results.map(r => r.id);
    expect(ids).toContain('e1');
    expect(ids).toContain('e3');
  });
});

// ─── Embedding codec ──────────────────────────────────────────────────────────

describe('encodeEmbedding / decodeEmbedding', () => {
  it('round-trips a float32 vector', () => {
    const original = [0.1, 0.5, -0.3, 0.9, 0.0];
    const encoded = encodeEmbedding(original);
    const decoded = decodeEmbedding(encoded);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('handles a 1536-dim vector (text-embedding-3-small output size)', () => {
    const vec = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    const buf = encodeEmbedding(vec);
    const back = decodeEmbedding(buf);
    expect(back.length).toBe(1536);
    expect(back[0]).toBeCloseTo(vec[0], 5);
  });
});

// ─── getRelevantKnowledge (integrated) ───────────────────────────────────────

describe('getRelevantKnowledge', () => {
  it('returns keyword results when no embedder key is provided', async () => {
    const result = await getRelevantKnowledge('bot-1', KB, 'soñé con agua', undefined);
    expect(result).toContain('Agua en sueños');
    expect(result).not.toContain('Volar en sueños');
  });

  it('returns empty string when nothing matches', async () => {
    const result = await getRelevantKnowledge('bot-1', KB, 'dinosaurio jurásico', undefined);
    expect(result).toBe('');
  });

  it('returns empty string for empty knowledge base', async () => {
    const result = await getRelevantKnowledge('bot-1', [], 'serpiente', undefined);
    expect(result).toBe('');
  });

  it('uses semantic retrieval when embedder key is provided and entries have embeddings', async () => {
    const vec1 = [1, 0, 0, 0];
    const vec2 = [0, 1, 0, 0];
    const vec3 = [0, 0, 1, 0];
    const queryVec = [1, 0.1, 0, 0]; // close to vec1

    const kbWithEmbeddings: BotKnowledge[] = [
      makeEntry('s1', 'Serpientes', 'Transformación', [], vec1),
      makeEntry('s2', 'Volar', 'Libertad', [], vec2),
      makeEntry('s3', 'Agua', 'Emociones', [], vec3),
    ];

    mockEmbeddingsCreate.mockResolvedValueOnce({ data: [{ embedding: queryVec }] });

    // pgvector DB search will fail (db not mocked) → falls through to in-process cosine
    const result = await getRelevantKnowledge('bot-1', kbWithEmbeddings, 'serpiente', 'fake-key');
    expect(result).toContain('Serpientes');
    expect(result).not.toContain('Volar');
  });

  it('falls back to keyword search when semantic fails (API error)', async () => {
    const kbWithEmbeddings: BotKnowledge[] = [
      makeEntry('s1', 'Serpientes', 'Transformación y peligro', [], [1, 0, 0]),
    ];

    // Both DB and in-process embedding calls will reject → keyword fallback
    mockEmbeddingsCreate.mockRejectedValueOnce(new Error('OpenAI API error'));
    mockEmbeddingsCreate.mockRejectedValueOnce(new Error('OpenAI API error'));

    const result = await getRelevantKnowledge('bot-1', kbWithEmbeddings, 'serpiente transformación', 'fake-key');
    expect(result).toContain('Serpientes'); // keyword fallback worked
  });
});

// ─── generateEmbedding ────────────────────────────────────────────────────────

describe('generateEmbedding', () => {
  beforeEach(() => {
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  });

  it('calls the OpenAI embeddings API with the correct model', async () => {
    const result = await generateEmbedding('test text', 'sk-test', 'text-embedding-3-small');
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'text-embedding-3-small', input: 'test text' }),
    );
  });
});
