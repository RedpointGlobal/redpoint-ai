// Build version single source of truth = packages/shared/version.json (the server
// /health endpoint reads the same file via @redpoint-ai/shared). Read here by a
// DIRECT relative JSON import: apps/web deliberately avoids importing the
// @redpoint-ai/shared *package* (Next/webpack workspace-package traversal hiccup —
// see lib/api.ts), but a direct file import of the JSON is safe and keeps one source.
import data from "../../../packages/shared/version.json";

export const APP_VERSION = data.version;
