import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const RUN_DIRECTORY = /^run-(\d+)$/;

export async function allocateRunDirectory(generatedRoot) {
  await mkdir(generatedRoot, { recursive: true });
  const entries = await readdir(generatedRoot, { withFileTypes: true });
  let number = entries.reduce((highest, entry) => {
    if (!entry.isDirectory()) return highest;
    const match = RUN_DIRECTORY.exec(entry.name);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0) + 1;

  while (Number.isSafeInteger(number)) {
    const target = path.join(generatedRoot, `run-${String(number).padStart(3, "0")}`);
    try {
      await mkdir(target);
      return target;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      number += 1;
    }
  }
  throw new Error("No safe demo run number remains");
}
