import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Load the repo-root `.env` into `process.env`, for CLIs and tests run on a laptop. Variables that are
 * already set win, so CI, GitHub Actions and Vercel (which have no file) are unaffected. Walks up from
 * `from` to the workspace root (the directory holding `pnpm-workspace.yaml`). Returns the file it
 * loaded, or null.
 */
export function loadRootEnvFile(from: string = process.cwd()): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      const file = path.join(dir, ".env");
      if (!existsSync(file)) return null;
      process.loadEnvFile(file);
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
