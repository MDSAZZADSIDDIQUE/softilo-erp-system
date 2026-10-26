import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4070";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const config: NextConfig = {
  // Core screens and components are imported from apps/web, so the bundler root is the repository.
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  poweredByHeader: false,
};

export default config;
