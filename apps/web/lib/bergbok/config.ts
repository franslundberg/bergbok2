import path from "node:path";
import { fileURLToPath } from "node:url";

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} saknas.`);
  return value;
};

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const defaultDataRoot = path.join(repositoryRoot, "var");

export const appConfig = () => {
  const dataRoot = path.resolve(process.env.BERGBOK_DATA_ROOT?.trim() || defaultDataRoot);
  return {
    dataRoot,
    databasePath: path.join(dataRoot, "app.sqlite"),
    recordRoot: path.join(dataRoot, "companies", "fiktiv-ab", "record"),
    snapshotRoot: path.join(dataRoot, "chat-snapshots"),
    artifactRoot: path.join(dataRoot, "companies", "fiktiv-ab", "artifacts"),
    ownerEmail: required("BERGBOK_OWNER_EMAIL").toLowerCase(),
  };
};

export const authConfig = () => ({
  pepper: required("AUTH_PEPPER"),
  sessionSecret: required("SESSION_SECRET"),
  secureCookies: process.env.BERGBOK_SECURE_COOKIES === "true",
  ownerEmail: appConfig().ownerEmail,
});

export const workspaceConfig = () => ({
  url: process.env.WORKSPACE_MANAGER_URL ?? "http://127.0.0.1:8086",
  token: required("WORKSPACE_MANAGER_TOKEN"),
});

export const modelConfig = () => ({
  model: process.env.OPENAI_MODEL?.trim() || "gpt-5.6-luna",
  reasoningEffort: process.env.OPENAI_REASONING_EFFORT?.trim() || "medium",
});

const BOOKKEEPING_VARIANTS = {
  "gpt-5.6-luna": "openai-gpt-5.6-luna-high-v3",
  "gpt-5.6-sol": "openai-gpt-5.6-sol-high-v3",
} as const;

export const bookkeepingModelConfig = () => {
  const model = process.env.BOOKKEEPING_MODEL?.trim() || "gpt-5.6-luna";
  if (!(model in BOOKKEEPING_VARIANTS)) {
    throw new Error(
      `BOOKKEEPING_MODEL must be gpt-5.6-luna or gpt-5.6-sol; received ${JSON.stringify(model)}.`,
    );
  }
  const bookkeepingModel = model as keyof typeof BOOKKEEPING_VARIANTS;
  return {
    model: bookkeepingModel,
    variant: { id: BOOKKEEPING_VARIANTS[bookkeepingModel] },
  };
};
