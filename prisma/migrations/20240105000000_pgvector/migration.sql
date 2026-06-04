-- Enable pgvector extension.
-- Railway PostgreSQL 16 ships with pgvector pre-installed.
-- For self-hosted Postgres, install the pgvector package first:
--   https://github.com/pgvector/pgvector#installation
CREATE EXTENSION IF NOT EXISTS vector;

-- Add 1536-dimension vector column (text-embedding-3-small default dimension).
-- NULL until the /embed endpoint populates it; allows gradual backfill.
ALTER TABLE "bot_knowledge" ADD COLUMN "embedding_vec" vector(1536);

-- HNSW index for approximate cosine similarity search.
-- Much faster than exact IVFFlat at query time; build is offline so it does
-- not block writes during deployment.
-- Paramters: m=16, ef_construction=64 are pgvector defaults (good for ≤1M vectors).
CREATE INDEX "bot_knowledge_embedding_vec_hnsw_idx"
  ON "bot_knowledge"
  USING hnsw ("embedding_vec" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
