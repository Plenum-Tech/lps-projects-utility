import type mongoose from "mongoose";
import {
  EMPLOYEE_DOCUMENT_TYPE_LABELS,
  EmployeeDocument,
  type EmployeeDocumentType,
} from "../models/EmployeeDocument.js";
import { User } from "../models/User.js";
import { addDays, appDateKey, appToday } from "./appTime.js";
import { documentExpiringTemplate, hrDateTemplate, relativeDays } from "./email.js";
import { daysBetween, departmentHeadIds } from "./hr.js";
import { formatDueDate, notifyUsersAsync } from "./notifications.js";

// ---------------------------------------------------------------------------
// Daily HR reminders (Inngest cron 08:00 + `bun run jobs:hr` + dev interval).
// - Documents expiring in 30 / 7 / 0 days or already expired → `document_expiring`
//   (owner + admins). Each threshold fires once per expiry date: the keys live
//   in `EmployeeDocument.reminderKeys` (reset when the expiry date changes).
// - Probation / notice / internship ending in 7 days and today →
//   `hr_date_upcoming` (employee + department heads + admins), once per
//   `<field>:<date>:<threshold>` key in `User.lastHrReminderKeys` (last 20 kept).
// Date-only comparisons use APP_TIMEZONE's today.
// ---------------------------------------------------------------------------

const DOCUMENT_WINDOW_DAYS = 30;
const HR_DATE_WINDOW_DAYS = 7;
const MAX_HR_KEYS = 20;

/** Most urgent threshold reached: "expired" | "0d" | "7d" | "30d" (null = not yet). */
export function documentThreshold(inDays: number): string | null {
  if (inDays < 0) return "expired";
  if (inDays === 0) return "0d";
  if (inDays <= 7) return "7d";
  if (inDays <= DOCUMENT_WINDOW_DAYS) return "30d";
  return null;
}

const HR_DATE_KINDS = [
  { field: "probationEndDate", label: "Probation" },
  { field: "noticePeriodEnd", label: "Notice period" },
  { field: "internshipEndDate", label: "Internship" },
] as const;

export interface HrRemindersResult {
  date: string;
  documents: { checked: number; reminded: number };
  hrDates: { checked: number; reminded: number };
}

export async function runHrReminders(now: Date = new Date()): Promise<HrRemindersResult> {
  const today = appToday(now);
  const result: HrRemindersResult = {
    date: appDateKey(now),
    documents: { checked: 0, reminded: 0 },
    hrDates: { checked: 0, reminded: 0 },
  };
  const admins = (await User.find({ role: "admin" }).select("_id").lean()).map(
    (a) => a._id as mongoose.Types.ObjectId
  );

  // --- Documents --------------------------------------------------------------
  const docs = await EmployeeDocument.find({
    expiryDate: { $ne: null, $lte: addDays(today, DOCUMENT_WINDOW_DAYS) },
  })
    .select("user name type expiryDate reminderKeys")
    .populate<{ user: { _id: mongoose.Types.ObjectId; name: string } | null }>({ path: "user", select: "name" })
    .lean();
  result.documents.checked = docs.length;

  for (const doc of docs) {
    if (!doc.user || !doc.expiryDate) continue; // owner deleted
    const inDays = daysBetween(today, doc.expiryDate);
    const key = documentThreshold(inDays);
    if (!key || doc.reminderKeys?.includes(key)) continue;

    // Atomic claim — overlapping runs (cron + dev interval) send once.
    const claimed = await EmployeeDocument.findOneAndUpdate(
      { _id: doc._id, expiryDate: doc.expiryDate, reminderKeys: { $ne: key } },
      { $addToSet: { reminderKeys: key } }
    );
    if (!claimed) continue;

    const owner = doc.user;
    const typeLabel = EMPLOYEE_DOCUMENT_TYPE_LABELS[doc.type as EmployeeDocumentType] ?? doc.type;
    const expiry = formatDueDate(doc.expiryDate) ?? "";
    const when = relativeDays(inDays);
    const expired = inDays < 0;
    await notifyUsersAsync({
      recipients: [owner._id, ...admins],
      actor: null,
      type: "document_expiring",
      title: expired ? "Document expired" : "Document expiring",
      message: expired
        ? `${doc.name} (${typeLabel}) of ${owner.name} ${when} (${expiry}).`
        : `${doc.name} (${typeLabel}) of ${owner.name} expires ${when} (${expiry}).`,
      link: "/documents",
      email: {
        subject: expired ? `⚠️ ${doc.name} has expired` : `⏰ ${doc.name} expires ${when}`,
        heading: expired ? "Document Expired" : "Document Expiring Soon",
        intro: "",
        render: (firstName, recipientId) =>
          documentExpiringTemplate({
            firstName,
            documentName: doc.name,
            documentType: typeLabel,
            ownerName: owner.name,
            expiryDate: expiry,
            inDays,
            isOwner: recipientId === owner._id.toString(),
          }),
      },
    });
    result.documents.reminded++;
  }

  // --- Probation / notice / internship ----------------------------------------
  const windowEnd = addDays(today, HR_DATE_WINDOW_DAYS);
  const users = await User.find({
    $or: HR_DATE_KINDS.map(({ field }) => ({ [field]: { $gte: today, $lte: windowEnd } })),
  })
    .select("name department probationEndDate noticePeriodEnd internshipEndDate lastHrReminderKeys")
    .lean();
  result.hrDates.checked = users.length;

  const headsByDept = new Map<string, mongoose.Types.ObjectId[]>();
  for (const user of users) {
    for (const { field, label } of HR_DATE_KINDS) {
      const date = user[field] as Date | null | undefined;
      if (!date || date < today || date > windowEnd) continue;
      const inDays = daysBetween(today, date);
      const threshold = inDays === 0 ? "0d" : "7d";
      const key = `${field}:${date.toISOString().slice(0, 10)}:${threshold}`;
      if (user.lastHrReminderKeys?.includes(key)) continue;

      const claimed = await User.findOneAndUpdate(
        { _id: user._id, lastHrReminderKeys: { $ne: key } },
        { $push: { lastHrReminderKeys: { $each: [key], $slice: -MAX_HR_KEYS } } }
      );
      if (!claimed) continue;

      const deptKey = user.department ? user.department.toString() : "";
      if (deptKey && !headsByDept.has(deptKey)) {
        headsByDept.set(deptKey, await departmentHeadIds(user.department as mongoose.Types.ObjectId));
      }
      const heads = headsByDept.get(deptKey) ?? [];
      const formatted = formatDueDate(date) ?? "";
      const when = inDays === 0 ? "today" : `in ${inDays} day${inDays === 1 ? "" : "s"}`;
      const userId = user._id as mongoose.Types.ObjectId;
      await notifyUsersAsync({
        recipients: [userId, ...heads, ...admins],
        actor: null,
        type: "hr_date_upcoming",
        title: `${label} ending ${when}`,
        message: `${user.name}'s ${label.toLowerCase()} ends ${when} (${formatted}).`,
        link: "/dashboard",
        email: {
          subject: `📅 ${user.name}: ${label.toLowerCase()} ends ${when}`,
          heading: `${label} Ending`,
          intro: "",
          render: (firstName, recipientId) =>
            hrDateTemplate({
              firstName,
              employeeName: user.name,
              label,
              date: formatted,
              inDays,
              isSelf: recipientId === userId.toString(),
            }),
        },
      });
      result.hrDates.reminded++;
    }
  }

  return result;
}
