import { Router } from "express";
import { getPlatformArchitecture, checkDatabaseConnection } from "../lib/architecture.js";
const healthRouter = Router();
healthRouter.get("/", async (_req, res) => {
  const db = await checkDatabaseConnection();
  res.json({
    ok: db.ok,
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    architecture: getPlatformArchitecture(),
    database: db
  });
});
export {
  healthRouter
};
