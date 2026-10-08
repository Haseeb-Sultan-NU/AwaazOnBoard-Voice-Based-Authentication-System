import type { NextConfig } from "next";

// Where the Next.js server proxies `/api/*`. Server-side only: the browser always
// calls same-origin `/api`. In Docker Compose this is the Awaaz service DNS name.
const AWAAZ_API_INTERNAL_URL = (process.env.AWAAZ_API_INTERNAL_URL ?? "http://localhost:8000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${AWAAZ_API_INTERNAL_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
