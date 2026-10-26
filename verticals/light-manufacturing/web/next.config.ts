import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4030";
// The edition reuses the core web app's screens and components from apps/web, so the build root is the monorepo.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const config: NextConfig = {
  // The browser only ever talks to this origin; /api is proxied to the edition API so the session cookie stays first-party.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  turbopack: { root },
  outputFileTracingRoot: root,
  poweredByHeader: false,
};

export default config;
