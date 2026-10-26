import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4010";
// The monorepo root, so core screens in apps/web can be compiled into this edition.
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const config: NextConfig = {
  // The browser only ever talks to this origin; /api is proxied to the pharma API so the session cookie stays first-party.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  turbopack: { root },
  outputFileTracingRoot: root,
  poweredByHeader: false,
};

export default config;
