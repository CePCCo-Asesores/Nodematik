import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

// Isolated registry — avoids polluting the global default registry in tests
export const registry = new Registry();
registry.setDefaultLabels({ service: 'nodematik' });

// Collect Node.js runtime metrics (heap, GC, event loop lag, etc.)
if (process.env.NODE_ENV !== 'test') {
  collectDefaultMetrics({ register: registry });
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

export const llmDurationMs = new Histogram({
  name: 'nodematik_llm_request_duration_ms',
  help: 'LLM API call latency in milliseconds',
  labelNames: ['provider', 'model'] as const,
  buckets: [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000],
  registers: [registry],
});

export const llmInputTokens = new Counter({
  name: 'nodematik_llm_input_tokens_total',
  help: 'Total input tokens consumed across all LLM calls',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});

export const llmOutputTokens = new Counter({
  name: 'nodematik_llm_output_tokens_total',
  help: 'Total output tokens generated across all LLM calls',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});

export const llmCostUsd = new Counter({
  name: 'nodematik_llm_estimated_cost_usd_total',
  help: 'Estimated LLM spend in USD based on public per-token pricing',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});

export const llmErrors = new Counter({
  name: 'nodematik_llm_errors_total',
  help: 'LLM API errors by provider and error type',
  labelNames: ['provider', 'error_type'] as const,
  registers: [registry],
});

// ─── Meta / WhatsApp ─────────────────────────────────────────────────────────

export const metaApiErrors = new Counter({
  name: 'nodematik_meta_api_errors_total',
  help: 'Meta (WhatsApp Cloud API) errors by HTTP status code',
  labelNames: ['status_code'] as const,
  registers: [registry],
});

// ─── Queue ───────────────────────────────────────────────────────────────────

export const dlqDepth = new Gauge({
  name: 'nodematik_dlq_depth',
  help: 'Current number of jobs waiting in the dead-letter queue',
  registers: [registry],
});

// ─── Business ────────────────────────────────────────────────────────────────

export const quotaBlocks = new Counter({
  name: 'nodematik_quota_blocks_total',
  help: 'Inbound messages rejected because the org monthly quota was exceeded',
  registers: [registry],
});

export const safetyBlocks = new Counter({
  name: 'nodematik_safety_blocks_total',
  help: 'Messages intercepted by the safety classifier',
  labelNames: ['action_taken'] as const,
  registers: [registry],
});

export const messagesProcessed = new Counter({
  name: 'nodematik_messages_processed_total',
  help: 'Total inbound messages fully processed (past all gates)',
  registers: [registry],
});

// ─── Cost estimation table (USD per 1M tokens, Q1 2025) ──────────────────────
// Keys are substrings matched against the model name (longest match wins).

const COST_INPUT_PER_M: [string, number][] = [
  ['claude-opus-4', 15.0],
  ['claude-sonnet-4', 3.0],
  ['claude-haiku-4', 0.80],
  ['claude-haiku', 0.25],
  ['claude-sonnet', 3.0],
  ['claude-opus', 15.0],
  ['gpt-4o-mini', 0.15],
  ['gpt-4o', 2.50],
  ['gpt-4', 30.0],
  ['gpt-3.5', 0.50],
];

const COST_OUTPUT_PER_M: [string, number][] = [
  ['claude-opus-4', 75.0],
  ['claude-sonnet-4', 15.0],
  ['claude-haiku-4', 4.0],
  ['claude-haiku', 1.25],
  ['claude-sonnet', 15.0],
  ['claude-opus', 75.0],
  ['gpt-4o-mini', 0.60],
  ['gpt-4o', 10.0],
  ['gpt-4', 60.0],
  ['gpt-3.5', 1.50],
];

function lookupCost(table: [string, number][], model: string): number {
  const lower = model.toLowerCase();
  // Iterate in declared order (most-specific first)
  for (const [key, cost] of table) {
    if (lower.includes(key)) return cost;
  }
  return 1.0; // unknown model — conservative fallback
}

// ─── Helper functions called by providers / services ─────────────────────────

export function recordLLMUsage(
  provider: string,
  model: string,
  durationMs: number,
  inputTokens: number,
  outputTokens: number,
): void {
  const labels = { provider, model };
  llmDurationMs.observe(labels, durationMs);
  if (inputTokens > 0) llmInputTokens.inc(labels, inputTokens);
  if (outputTokens > 0) llmOutputTokens.inc(labels, outputTokens);

  const inputCost = (inputTokens / 1_000_000) * lookupCost(COST_INPUT_PER_M, model);
  const outputCost = (outputTokens / 1_000_000) * lookupCost(COST_OUTPUT_PER_M, model);
  if (inputCost + outputCost > 0) llmCostUsd.inc(labels, inputCost + outputCost);
}

export function recordLLMError(provider: string, errorType: string): void {
  llmErrors.inc({ provider, error_type: errorType });
}

export function recordMetaError(statusCode: number): void {
  metaApiErrors.inc({ status_code: String(statusCode) });
}

export function recordQuotaBlock(): void {
  quotaBlocks.inc();
}

export function recordSafetyBlock(actionTaken: string): void {
  safetyBlocks.inc({ action_taken: actionTaken });
}

export function recordMessageProcessed(): void {
  messagesProcessed.inc();
}

export function updateDLQDepth(depth: number): void {
  dlqDepth.set(depth);
}
