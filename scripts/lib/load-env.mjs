import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

export const repoRoot = resolve(import.meta.dirname, "../..");

export function loadLocalEnv() {
  loadDotenv({ path: resolve(repoRoot, ".env") });
  loadDotenv({ path: resolve(repoRoot, ".env.local"), override: true });
  loadDotenv();
}
