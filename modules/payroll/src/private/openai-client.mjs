const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_HTTP_RETRIES = 2;

export async function createStructuredResponse({
  apiKey,
  body,
  fetchImpl = globalThis.fetch,
  baseUrl = process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw technicalError("BERGBOK_PAYROLL_MISSING_API_KEY", "OPENAI_API_KEY is required for payroll evidence assessment.");
  }
  if (typeof fetchImpl !== "function") {
    throw technicalError("BERGBOK_PAYROLL_API_ERROR", "No fetch implementation is available.");
  }

  const url = responsesUrl(baseUrl);
  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) {
        throw technicalError("BERGBOK_PAYROLL_API_TIMEOUT", `Payroll assessment timed out after ${timeoutMs} ms.`, error);
      }
      throw technicalError("BERGBOK_PAYROLL_API_ERROR", `Payroll assessment request failed: ${error.message}`, error);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    if (!response.ok) {
      if (attempt < MAX_HTTP_RETRIES && (response.status === 429 || response.status >= 500)) {
        await wait(retryDelayMs(response.headers.get("retry-after"), attempt));
        continue;
      }
      throw technicalError(
        "BERGBOK_PAYROLL_API_ERROR",
        `Payroll assessment API returned HTTP ${response.status}${safeApiMessage(text)}.`,
      );
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw technicalError("BERGBOK_PAYROLL_API_ERROR", "Payroll assessment API returned invalid JSON.", error);
    }
  }
  throw technicalError("BERGBOK_PAYROLL_API_ERROR", "Payroll assessment API retries were exhausted.");
}

export function extractResponseJson(response) {
  if (response?.status && response.status !== "completed") {
    throw technicalError(
      "BERGBOK_PAYROLL_API_ERROR",
      `Payroll assessment response did not complete (status ${response.status}).`,
    );
  }
  const refusal = response?.output
    ?.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .find((item) => item?.type === "refusal");
  if (refusal) {
    throw technicalError(
      "BERGBOK_PAYROLL_MODEL_REFUSAL",
      `Payroll assessment was refused${refusal.refusal ? `: ${refusal.refusal}` : "."}`,
    );
  }
  const outputText = typeof response?.output_text === "string"
    ? response.output_text
    : response?.output
      ?.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .find((item) => item?.type === "output_text")?.text;
  if (typeof outputText !== "string" || outputText.trim().length === 0) {
    throw technicalError("BERGBOK_PAYROLL_API_ERROR", "Payroll assessment response contained no output text.");
  }
  try {
    return JSON.parse(outputText);
  } catch (error) {
    throw technicalError("BERGBOK_PAYROLL_ASSESSMENT_INVALID", "Payroll assessment output was not valid JSON.", error);
  }
}

export function technicalError(code, message, cause = undefined, details = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "PayrollTechnicalError";
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function responsesUrl(baseUrl) {
  const normalized = String(baseUrl).replace(/\/+$/, "");
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function safeApiMessage(text) {
  try {
    const value = JSON.parse(text);
    const message = value?.error?.message;
    return typeof message === "string" && message.length > 0 ? `: ${message}` : "";
  } catch {
    return "";
  }
}

function retryDelayMs(retryAfter, attempt) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
  }
  return 100 * (2 ** attempt);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
