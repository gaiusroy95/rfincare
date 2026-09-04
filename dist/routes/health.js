import { Router } from "express";
import { getPlatformArchitecture, checkDatabaseConnection } from "../lib/architecture.js";
const healthRouter = Router();
const API_BUILD = {
  id: "2026-09-04-agent-delete",
  features: {
    agentPermanentDelete: true,
    agentDeleteViaPatch: true,
    agentDeletePost: true
  }
};
healthRouter.get("/", async (_req, res) => {
  const db = await checkDatabaseConnection();
  res.json({
    ok: db.ok,
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    build: API_BUILD,
    architecture: getPlatformArchitecture(),
    database: db
  });
});
export {
  API_BUILD,
  healthRouter
};
