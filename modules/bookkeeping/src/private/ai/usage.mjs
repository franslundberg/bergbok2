export function emptyUsage() {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, estimated_usd: 0 };
}

export function addUsage(total, response, price) {
  const input = response.usage?.input_tokens ?? 0;
  const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
  const output = response.usage?.output_tokens ?? 0;
  total.input_tokens += input;
  total.cached_input_tokens += cached;
  total.output_tokens += output;
  total.estimated_usd += ((input - cached) * price.input_usd_per_million
    + cached * price.cached_input_usd_per_million
    + output * price.output_usd_per_million) / 1_000_000;
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output };
}
