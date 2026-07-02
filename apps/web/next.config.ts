import type { NextConfig } from "next";
import path from "path";
import { existsSync, readFileSync } from "fs";

// Load root .env for monorepo — Next.js only reads .env from its own project root (apps/web/).
const rootEnv = path.resolve(import.meta.dirname, "../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf("#");
      if (commentIdx > 0) value = value.slice(0, commentIdx).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {},
  env: {
    AUTH_REQUIRED: process.env.AUTH_REQUIRED,
    AUTH_SECRET: process.env.AUTH_SECRET,
  },
  webpack: (config) => {
    config.resolve.modules = [
      path.resolve(import.meta.dirname, "node_modules"),
      "node_modules",
      ...(config.resolve.modules || []),
    ];
    return config;
  },
};

export default nextConfig;
