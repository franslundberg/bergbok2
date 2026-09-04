import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open as openFile,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { prettyCanonicalJson, sha256Bytes } from "../../../../contracts/src/canonical.mjs";
import { contentRefKey, verifySealedContent } from "../../../../contracts/src/index.mjs";

export class StorageIntegrityError extends Error {
  constructor(message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "StorageIntegrityError";
    this.code = "BERGBOK_INTEGRITY_ERROR";
    this.details = details;
  }
}

export function storagePaths(rootDir) {
  return Object.freeze({
    root: rootDir,
    catalog: path.join(rootDir, "control", "catalog.json"),
    lock: path.join(rootDir, "control", ".writer-lock"),
    objects: path.join(rootDir, "objects"),
    blobs: path.join(rootDir, "blobs"),
  });
}

export async function initializeDirectories(paths) {
  await mkdir(path.dirname(paths.catalog), { recursive: true });
  await mkdir(paths.objects, { recursive: true });
  await mkdir(paths.blobs, { recursive: true });
}

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function objectPath(paths, ref) {
  return path.join(paths.objects, ref.sha256.slice(0, 2), `${ref.sha256}.json`);
}

export function blobPath(paths, sha256) {
  return path.join(paths.blobs, sha256.slice(0, 2), `${sha256}.bin`);
}

export async function writeImmutableSealed(paths, sealed) {
  verifySealedContent(sealed);
  const target = objectPath(paths, sealed.ref);
  await writeImmutableBytes(target, Buffer.from(prettyCanonicalJson(sealed), "utf8"));
  return target;
}

export async function readImmutableSealed(paths, ref, label = "stored object") {
  const target = objectPath(paths, ref);
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new StorageIntegrityError(`${label} is missing`, { ref });
    }
    throw error;
  }

  let sealed;
  try {
    sealed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new StorageIntegrityError(`${label} is not valid JSON`, { ref }, error);
  }

  try {
    verifySealedContent(sealed, label);
  } catch (error) {
    throw new StorageIntegrityError(`${label} failed its content hash`, { ref }, error);
  }
  if (contentRefKey(sealed.ref) !== contentRefKey(ref)) {
    throw new StorageIntegrityError(`${label} does not match the requested reference`, {
      requested_ref: ref,
      stored_ref: sealed.ref,
    });
  }
  return sealed;
}

export async function writeImmutableBlob(paths, bytes) {
  const sha256 = sha256Bytes(bytes);
  const target = blobPath(paths, sha256);
  await writeImmutableBytes(target, bytes);
  return Object.freeze({ sha256, byte_length: bytes.length });
}

export async function readImmutableBlob(paths, sha256) {
  const target = blobPath(paths, sha256);
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new StorageIntegrityError("Original byte object is missing", { sha256 });
    }
    throw error;
  }
  const actual = sha256Bytes(bytes);
  if (actual !== sha256) {
    throw new StorageIntegrityError("Original byte object failed its content hash", {
      expected_sha256: sha256,
      actual_sha256: actual,
    });
  }
  return bytes;
}

export async function readCatalog(paths) {
  let bytes;
  try {
    bytes = await readFile(paths.catalog);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let sealed;
  try {
    sealed = JSON.parse(bytes.toString("utf8"));
    verifySealedContent(sealed, "Company Record catalog");
  } catch (error) {
    throw new StorageIntegrityError("Company Record catalog failed integrity validation", {}, error);
  }
  return sealed;
}

export async function replaceCatalog(paths, sealed) {
  verifySealedContent(sealed, "Company Record catalog");
  await atomicReplace(paths.catalog, Buffer.from(prettyCanonicalJson(sealed), "utf8"));
}

export async function withWriterLock(paths, operation) {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(paths.lock);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - started > 5_000) {
        throw new Error("Timed out waiting for the Company Record writer lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  try {
    return await operation();
  } finally {
    await rmdir(paths.lock).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function writeImmutableBytes(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });

  if (await pathExists(target)) {
    await assertExistingBytes(target, bytes);
    return;
  }

  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await openFile(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;

    try {
      await link(temporary, target);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await assertExistingBytes(target, bytes);
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function assertExistingBytes(target, expected) {
  const actual = await readFile(target);
  if (!actual.equals(expected)) {
    throw new StorageIntegrityError("Immutable object already exists with different bytes", {
      path: target,
      expected_sha256: sha256Bytes(expected),
      actual_sha256: sha256Bytes(actual),
    });
  }
}

async function atomicReplace(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await openFile(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
