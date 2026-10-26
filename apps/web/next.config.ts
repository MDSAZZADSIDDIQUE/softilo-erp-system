import type { NextConfig } from "next";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4000";

const config: NextConfig = {
  // The browser only ever talks to this origin; /api is proxied to the API server so the session cookie stays first-party.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  poweredByHeader: false,
};

export default config;
