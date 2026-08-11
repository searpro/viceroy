import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; bundling it breaks the .node binding
  // resolution in the server runtime.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
