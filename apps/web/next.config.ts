import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them.
  transpilePackages: ["@repo/core", "@repo/crm-hubspot", "@repo/db", "@repo/queue"],
  serverExternalPackages: ["pg", "pg-boss"],
  typedRoutes: true,
  poweredByHeader: false,
};

export default config;
