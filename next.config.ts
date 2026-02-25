import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow server-side fetches to Kalshi and CoinMarketCap without timeout issues
  serverExternalPackages: [],
  experimental: {},
};

export default nextConfig;
