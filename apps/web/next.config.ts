import { withAui } from "@assistant-ui/next";
import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: false,
  serverExternalPackages: ["pdfkit"],
  turbopack: { root: repositoryRoot },
};

export default withAui(nextConfig);
