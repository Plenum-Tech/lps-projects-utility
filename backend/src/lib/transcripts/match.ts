import mongoose from "mongoose";
import type { IProject } from "../../models/Project.js";
import type { IUser } from "../../models/User.js";
import { User } from "../../models/User.js";

// ---------------------------------------------------------------------------
// Speaker → LPS user matching. Candidates are the users the uploader can
// assign: project members + manager when there's a project, otherwise the
// assignable-users rule (admin: everyone, head: their department, employee:
// themselves). Full name first (case/accents-insensitive), then a unique
// first name. Anything else stays unmatched for the mapping step.
// ---------------------------------------------------------------------------

export interface CandidateUser {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
}

/** Lower-case, accent-free, single-spaced. */
export function normalizeName(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Sharma, Priya (Contoso)" → "Priya Sharma"; strips "(Guest)"/"(External)" suffixes. */
export function canonicalSpeakerName(input: string): string {
  let name = input.replace(/\s*[([].*?[)\]]\s*/g, " ").trim();
  const comma = /^([^,]+),\s*([^,]+)$/.exec(name);
  if (comma) name = `${comma[2]} ${comma[1]}`;
  return name.replace(/\s+/g, " ").trim();
}

function firstName(input: string): string {
  return normalizeName(canonicalSpeakerName(input)).split(" ")[0] ?? "";
}

/** Users `actor` may map speakers / assign items to. */
export async function candidateUsers(
  actor: Pick<IUser, "_id" | "role" | "department">,
  project: Pick<IProject, "members" | "manager"> | null
): Promise<CandidateUser[]> {
  let filter: Record<string, unknown>;
  if (project) {
    const ids = project.members.map((m) => m.user);
    if (project.manager) ids.push(project.manager);
    filter = { _id: { $in: ids } };
  } else if (actor.role === "admin") {
    filter = {};
  } else if (actor.role === "head") {
    filter = actor.department ? { department: actor.department } : { _id: actor._id };
  } else {
    filter = { _id: actor._id };
  }
  const users = await User.find(filter).select("name email").sort({ name: 1 }).lean();
  return users.map((u) => ({ _id: u._id as mongoose.Types.ObjectId, name: u.name, email: u.email }));
}

/** Matches one name against candidates (full name, then unique first name). */
export function matchName(name: string, candidates: CandidateUser[]): CandidateUser | null {
  const canonical = normalizeName(canonicalSpeakerName(name));
  if (!canonical) return null;
  const full = candidates.filter((c) => normalizeName(c.name) === canonical);
  if (full.length === 1) return full[0]!;
  if (full.length > 1) return null; // two LPS users with the same name: let the user decide
  // Email local part ("priya.sharma") — Teams guests sometimes appear by address.
  const byEmail = candidates.filter((c) => normalizeName(c.email.split("@")[0]!.replace(/[._]/g, " ")) === canonical);
  if (byEmail.length === 1) return byEmail[0]!;
  const first = firstName(name);
  if (!first) return null;
  const byFirst = candidates.filter((c) => firstName(c.name) === first);
  if (byFirst.length !== 1) return null;
  // "Priya Sharma" must not match "Priya Patel": only use the first name when the
  // transcript gives no surname, or the surname is a prefix/initial of the user's.
  const words = canonical.split(" ");
  if (words.length > 1) {
    const userWords = normalizeName(byFirst[0]!.name).split(" ");
    const last = words[words.length - 1]!.replace(/\.$/, "");
    const userLast = userWords.length > 1 ? userWords[userWords.length - 1]! : "";
    if (!userLast || !userLast.startsWith(last)) return null;
  }
  return byFirst[0]!;
}

/** Matches every speaker name; returns name → candidate (or null). */
export function matchSpeakers(names: string[], candidates: CandidateUser[]): Map<string, CandidateUser | null> {
  const result = new Map<string, CandidateUser | null>();
  for (const name of names) result.set(name, matchName(name, candidates));
  return result;
}
