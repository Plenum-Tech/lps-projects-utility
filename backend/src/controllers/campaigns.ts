import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { isLeadershipActor, requestChange } from "../lib/changeRequests.js";
import { isInvalidObjectId, param } from "../lib/projectAccess.js";
import { Brand } from "../models/Brand.js";
import { Campaign, CAMPAIGN_LIMITS } from "../models/Campaign.js";

// ---------------------------------------------------------------------------
// /api/brands/:id/campaigns — a brand's campaigns. Everyone reads (approved,
// plus pending ones marked); anyone who creates projects may add one: it is
// live at once for leadership, otherwise it waits for leadership approval.
// ---------------------------------------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

async function brandOr404(req: Request, res: Response) {
  const id = param(req, "id");
  const brand = id && !isInvalidObjectId(id) ? await Brand.findById(id).select("name status") : null;
  if (!brand) res.status(404).json({ error: "Brand not found" });
  return brand;
}

/** GET /api/brands/:id/campaigns */
export async function listCampaigns(req: Request, res: Response): Promise<void> {
  const brand = await brandOr404(req, res);
  if (!brand) return;
  const campaigns = await Campaign.find({ brand: brand._id, status: { $ne: "rejected" }, active: true })
    .sort({ status: 1, name: 1 })
    .lean();
  res.json({
    campaigns: campaigns.map((c) => ({
      _id: String(c._id),
      name: c.name,
      startMonth: c.startMonth,
      endMonth: c.endMonth,
      status: c.status,
    })),
  });
}

/** POST /api/brands/:id/campaigns `{ name, startMonth?, endMonth? }` */
export async function createCampaign(req: Request, res: Response): Promise<void> {
  const brand = await brandOr404(req, res);
  if (!brand) return;
  if (brand.status && brand.status !== "approved") {
    res.status(409).json({ error: "This brand is waiting for leadership approval" });
    return;
  }
  const body = (req.body ?? {}) as { name?: unknown; startMonth?: unknown; endMonth?: unknown };
  const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
  if (!name) {
    res.status(400).json({ error: "Enter the campaign name" });
    return;
  }
  if (name.length > CAMPAIGN_LIMITS.nameMax || name.includes("_")) {
    res.status(400).json({ error: `Campaign names are up to ${CAMPAIGN_LIMITS.nameMax} characters, without "_"` });
    return;
  }
  const month = (v: unknown) => (typeof v === "string" && MONTH.test(v) ? v : null);
  const startMonth = month(body.startMonth);
  const endMonth = month(body.endMonth);
  if (startMonth && endMonth && endMonth < startMonth) {
    res.status(400).json({ error: "The campaign can't end before it starts" });
    return;
  }
  const actor = req.user!;
  const leader = await isLeadershipActor(actor);
  try {
    const campaign = await Campaign.create({
      brand: brand._id,
      name,
      startMonth,
      endMonth,
      status: leader ? "approved" : "pending",
      requestedBy: actor._id,
      ...(leader ? { decidedBy: actor._id, decidedAt: new Date() } : {}),
    });
    if (!leader) {
      const range = [startMonth, endMonth].filter(Boolean).join(" – ");
      await requestChange({
        kind: "campaign_new",
        actor,
        title: `New campaign for ${brand.name}: ${name}`,
        changes: [{ label: "New campaign", before: "—", after: range ? `${name} (${range})` : name }],
        payload: { campaign: String(campaign._id) },
        brand: brand._id as mongoose.Types.ObjectId,
        ip: req.ip,
      });
    }
    logActivity({
      action: "settings_updated",
      actor,
      targetType: "brand",
      targetId: brand._id as mongoose.Types.ObjectId,
      targetName: brand.name,
      details: { campaign: name, status: campaign.status },
      ip: req.ip,
    });
    res.status(201).json({
      campaign: { _id: String(campaign._id), name, startMonth, endMonth, status: campaign.status },
      ...(leader ? {} : { pendingApproval: `"${name}" was sent to leadership for approval. Projects can use it once it's approved.` }),
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      res.status(409).json({ error: `${brand.name} already has a campaign called "${name}"` });
      return;
    }
    throw err;
  }
}
