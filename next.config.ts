import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / heavy server-only deps must not be bundled.
  serverExternalPackages: ["better-sqlite3", "playwright"],
};

export default nextConfig;
