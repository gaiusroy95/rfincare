import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import {
  listLenderBranches,
  createLenderBranch,
  updateLenderBranch,
  deleteLenderBranch,
  listLenderContacts,
  createLenderContact,
  updateLenderContact,
  deleteLenderContact
} from "../lib/lenderMaster.js";
const adminLenderMasterRouter = Router();
adminLenderMasterRouter.use(authenticate);
adminLenderMasterRouter.get(
  "/:bankId/branches",
  authorize({ resource: "banks", action: "read" }),
  async (req, res, next) => {
    try {
      res.json({ data: await listLenderBranches(req.params.bankId) });
    } catch (err) {
      next(err);
    }
  }
);
adminLenderMasterRouter.post(
  "/:bankId/branches",
  authorize({ resource: "banks", action: "update" }),
  async (req, res, next) => {
    try {
      const body = z.object({
        branchName: z.string().min(1),
        branchCode: z.string().optional().nullable(),
        addressLine1: z.string().optional().nullable(),
        addressLine2: z.string().optional().nullable(),
        city: z.string().optional().nullable(),
        state: z.string().optional().nullable(),
        pincode: z.string().optional().nullable(),
        phone: z.string().optional().nullable(),
        email: z.string().optional().nullable(),
        isActive: z.boolean().optional()
      }).parse(req.body || {});
      res.status(201).json({ data: await createLenderBranch(req.params.bankId, body) });
    } catch (err) {
      next(err);
    }
  }
);
adminLenderMasterRouter.patch(
  "/branches/:branchId",
  authorize({ resource: "banks", action: "update" }),
  async (req, res, next) => {
    try {
      const body = z.object({
        branchName: z.string().optional(),
        branchCode: z.string().optional().nullable(),
        addressLine1: z.string().optional().nullable(),
        addressLine2: z.string().optional().nullable(),
        city: z.string().optional().nullable(),
        state: z.string().optional().nullable(),
        pincode: z.string().optional().nullable(),
        phone: z.string().optional().nullable(),
        email: z.string().optional().nullable(),
        isActive: z.boolean().optional()
      }).parse(req.body || {});
      res.json({ data: await updateLenderBranch(req.params.branchId, body) });
    } catch (err) {
      next(err);
    }
  }
);
adminLenderMasterRouter.delete(
  "/branches/:branchId",
  authorize({ resource: "banks", action: "update" }),
  async (req, res, next) => {
    try {
      await deleteLenderBranch(req.params.branchId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);
adminLenderMasterRouter.get(
  "/:bankId/contacts",
  authorize({ resource: "banks", action: "read" }),
  async (req, res, next) => {
    try {
      res.json({ data: await listLenderContacts(req.params.bankId) });
    } catch (err) {
      next(err);
    }
  }
);
adminLenderMasterRouter.post(
  "/:bankId/contacts",
  authorize({ resource: "banks", action: "update" }),
  async (req, res, next) => {
    try {
      const body = z.object({
        branchId: z.string().optional().nullable(),
        contactName: z.string().min(1),
        roleTitle: z.string().optional().nullable(),
        department: z.string().optional().nullable(),
        email: z.string().optional().nullable(),
        phone: z.string().optional().nullable(),
        isPrimary: z.boolean().optional(),
        notes: z.string().optional().nullable()
      }).parse(req.body || {});
      res.status(201).json({ data: await createLenderContact(req.params.bankId, body) });
    } catch (err) {
      next(err);
    }
  }
);
adminLenderMasterRouter.patch(
  "/contacts/:contactId",
  authorize({ resource: "banks", action: "update" }),
  async (req, res, next) => {
    try {
      const body = z.object({
        branchId: z.string().optional().nullable(),
        contactName: z.string().optional(),
        roleTitle: z.string().optional().nullable(),
        department: z.string().optional().nullable(),
        email: z.string().optional().nullable(),
        phone: z.string().optional().nullable(),
        isPrimary: z.boolean().optional(),
        notes: z.string().optional().nullable()
      }).parse(req.body || {});
      res.json({ data: await updateLenderContact(req.params.contactId, body) });
    } catch (err) {
      next(err);
    }
  }
);
adminLenderMasterRouter.delete(
  "/contacts/:contactId",
  authorize({ resource: "banks", action: "update" }),
  async (req, res, next) => {
    try {
      await deleteLenderContact(req.params.contactId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);
export {
  adminLenderMasterRouter
};
