import { resolve } from "node:path";
import type { NextConfig } from "next";

// The food & beverage API (core modules plus /api/fnb) runs on port 4010 in development.
const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4010";

const config: NextConfig = {
  // Core screens are compiled from apps/web, so the bundler root is the repository.
  turbopack: { root: resolve(process.cwd(), "../../..") },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  poweredByHeader: false,
};

export default config;
