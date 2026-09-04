export const API_URL = "https://api.openai.com/v1/responses";
export const WORKER_IMAGE = "bergbok-bookkeeping-worker:1.0.0";
export const EGRESS_IMAGE = "bergbok-bookkeeping-egress:1.0.0";
export const MAX_STEPS = 30;
export const MAX_RUN_MS = 20 * 60_000;
export const MAX_TOOL_TIMEOUT_MS = 120_000;
export const MAX_TOOL_OUTPUT_CHARS = 100_000;

export const MODEL_VARIANTS = Object.freeze({
  "openai-gpt-5.6-luna-high-v2": {
    model: "gpt-5.6-luna",
    reasoning_effort: "high",
    input_usd_per_million: 0.2,
    cached_input_usd_per_million: 0.02,
    output_usd_per_million: 1.2,
  },
  "openai-gpt-5.6-sol-high-v2": {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    input_usd_per_million: 4,
    cached_input_usd_per_million: 0.4,
    output_usd_per_million: 20,
  },
  "openai-gpt-5.6-luna-high-v1": {
    model: "gpt-5.6-luna",
    reasoning_effort: "high",
    input_usd_per_million: 0.2,
    cached_input_usd_per_million: 0.02,
    output_usd_per_million: 1.2,
  },
  "openai-gpt-5.6-sol-high-v1": {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    input_usd_per_million: 4,
    cached_input_usd_per_million: 0.4,
    output_usd_per_million: 20,
  },
});
