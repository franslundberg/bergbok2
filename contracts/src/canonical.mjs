import { createHash } from "node:crypto";

export const CANONICAL_JSON_PROFILE = "bergbok-canonical-json-v1";

export function canonicalStringify(value) {
  assertJsonValue(value, "$", new Set());
  return serialize(value);
}

export function prettyCanonicalJson(value) {
  assertJsonValue(value, "$", new Set());
  return `${JSON.stringify(sortRecursively(value), null, 2)}\n`;
}

export function sha256Bytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Json(value) {
  return sha256Bytes(Buffer.from(canonicalStringify(value), "utf8"));
}

export function cloneJson(value) {
  return JSON.parse(canonicalStringify(value));
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function serialize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`).join(",")}}`;
}

function sortRecursively(value) {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortRecursively(value[key])]),
    );
  }
  return value;
}

function assertJsonValue(value, path, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain a finite number`);
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} is not a JSON value`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`, ancestors));
  } else {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}
