import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("portable contract schemas are valid JSON Schema documents with unique identifiers", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = (await readdir(root)).filter((name) => name.endsWith(".schema.json")).sort();
  assert.ok(files.length >= 5);
  const ids = new Set();
  for (const file of files) {
    const schema = JSON.parse(await readFile(path.join(root, file), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /^https:\/\/schemas\.bergbok\.se\//);
    assert.equal(ids.has(schema.$id), false, `duplicate schema ID in ${file}`);
    ids.add(schema.$id);
    assert.equal(typeof schema.title, "string");
  }
});
