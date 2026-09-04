import { readFile } from "node:fs/promises";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvLocal(source) {
  const values = {};
  const seen = new Set();
  for (const [index, original] of source.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    let line = original.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Malformed .env.local line ${index + 1}`);
    const key = line.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key) || seen.has(key)) throw new Error(`Invalid or duplicate variable on .env.local line ${index + 1}`);
    seen.add(key);
    const raw = line.slice(separator + 1).trim();
    if (raw.startsWith('"')) values[key] = JSON.parse(raw);
    else if (raw.startsWith("'")) {
      if (!raw.endsWith("'")) throw new Error(`Malformed quoted value on .env.local line ${index + 1}`);
      values[key] = raw.slice(1, -1);
    } else values[key] = raw;
  }
  return values;
}

export async function loadEnvironment(file, environment = process.env) {
  try {
    return { ...parseEnvLocal(await readFile(file, "utf8")), ...environment };
  } catch (error) {
    if (error?.code === "ENOENT") return { ...environment };
    throw error;
  }
}
