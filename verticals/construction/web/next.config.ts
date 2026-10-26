import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4010";
// The edition reuses the core web app's styles and components, so the bundler's root is the monorepo.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const config: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
};

export default config;
