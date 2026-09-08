import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prettyCanonicalJson } from "../contracts/src/canonical.mjs";
import { render } from "../modules/artifacts/src/index.mjs";

const workDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.join(workDirectory, "report-source.json"));
const outputDirectory = path.resolve(process.argv[3] ?? path.join(workDirectory, "rendered"));
const profiles = process.argv.slice(4);
const snapshot = JSON.parse(await readFile(sourcePath, "utf8"));

await mkdir(outputDirectory, { recursive: true });

for (const profile of profiles.length ? profiles : ["report-html-v1", "report-pdf-v1"]) {
  const bundle = await render(snapshot, profile);
  const artifact = bundle.payload.artifacts[0];
  const artifactPath = path.join(outputDirectory, artifact.filename);
  const bundlePath = path.join(outputDirectory, `${profile}-bundle.json`);

  await writeFile(artifactPath, Buffer.from(artifact.content_base64, "base64"));
  await writeFile(bundlePath, prettyCanonicalJson(bundle));
  console.log(`${profile}: ${artifactPath} (${artifact.sha256})`);
}
