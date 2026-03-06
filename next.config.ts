import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [],
  experimental: {},
  // Exclude Python venvs from Turbopack file traversal (broken symlinks crash the build)
  outputFileTracingExcludes: {
    '*': [
      'python-service/venv310/**',
      'python-service/venv313/**',
      'python-service/timesfm/venv310/**',
      'python-service/timesfm/venv313/**',
      'venv310/**',
      'venv313/**',
      'timesfm/**',
    ],
  },
};

export default nextConfig;
