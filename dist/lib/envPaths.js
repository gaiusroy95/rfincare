import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(__dirname, "../..");
const BACKEND_ENV_PATH = join(BACKEND_ROOT, ".env");
const MONOREPO_FRONTEND_ENV_PATH = join(BACKEND_ROOT, "../frontend/.env");
const STORED_FRONTEND_ENV_PATH = join(BACKEND_ROOT, "data/frontend.env");
const FRONTEND_ENV_PATH = MONOREPO_FRONTEND_ENV_PATH;
async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
async function resolveFrontendEnvPath() {
  if (process.env.FRONTEND_ENV_PATH) {
    return {
      path: process.env.FRONTEND_ENV_PATH,
      storageMode: "custom",
      hint: null
    };
  }
  const monorepoDir = dirname(MONOREPO_FRONTEND_ENV_PATH);
  if (await pathExists(monorepoDir)) {
    return {
      path: MONOREPO_FRONTEND_ENV_PATH,
      storageMode: "monorepo",
      hint: null
    };
  }
  return {
    path: STORED_FRONTEND_ENV_PATH,
    storageMode: "server-store",
    hint: "Saved on the API server (frontend is hosted separately). Copy these values into Vercel → Project → Settings → Environment Variables, then redeploy the frontend."
  };
}
export {
  BACKEND_ENV_PATH,
  FRONTEND_ENV_PATH,
  MONOREPO_FRONTEND_ENV_PATH,
  STORED_FRONTEND_ENV_PATH,
  resolveFrontendEnvPath
};
