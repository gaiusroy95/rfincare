import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { requireRoles } from "../middleware/requireRoles.js";
import {
  listGeoPolicyVersions,
  getGeoPolicyVersion,
  approveGeoPolicyVersion,
  ensureLenderGeoPolicySchema
} from "../lib/lenderGeoPolicy.js";
const lenderGeoPolicyRouter = Router();
lenderGeoPolicyRouter.use(authenticate);
lenderGeoPolicyRouter.get(
  "/versions",
  authorize({ resource: "banks", action: "read" }),
  async (req, res, next) => {
    try {
      await ensureLenderGeoPolicySchema();
      const rows = await listGeoPolicyVersions(Number(req.query.limit) || 30);
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  }
);
lenderGeoPolicyRouter.get(
  "/versions/:id",
  authorize({ resource: "banks", action: "read" }),
  async (req, res, next) => {
    try {
      const data = await getGeoPolicyVersion(req.params.id);
      if (!data) return res.status(404).json({ error: "Version not found" });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);
lenderGeoPolicyRouter.post(
  "/versions/:id/approve",
  requireRoles("super_admin"),
  async (req, res, next) => {
    try {
      const version = await approveGeoPolicyVersion(req.params.id, req.auth.userId);
      res.json({
        data: version,
        message: "Geo policy version activated. Previous active version superseded."
      });
    } catch (err) {
      next(err);
    }
  }
);
export {
  lenderGeoPolicyRouter
};
