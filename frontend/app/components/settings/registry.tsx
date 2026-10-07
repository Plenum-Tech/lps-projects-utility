import type { ComponentType } from "react";
import type { IconType } from "react-icons";
import {
  LuBell,
  LuBuilding2,
  LuCalendarDays,
  LuClipboardList,
  LuFileUp,
  LuFolderKanban,
  LuMapPin,
  LuMessagesSquare,
  LuShieldCheck,
  LuSlidersHorizontal,
  LuTimer,
  LuUserRound,
} from "react-icons/lu";

import { ImportsHistorySection } from "@/components/imports/imports-history";
import { AddressSection } from "@/components/settings/sections/address-section";
import { AppSection } from "@/components/settings/sections/app-section";
import {
  LeaveSection,
  MeetingSection,
  NotificationSection,
  ProfileSection,
  ProjectSection,
  SecuritySection,
  TaskSection,
  TimeLogSection,
} from "@/components/settings/sections/card-sections";
import { CompanySection } from "@/components/settings/sections/company-section";
import type { Role } from "@/types";

export interface SettingsSectionDef {
  /** URL segment: /settings/:id */
  id: string;
  title: string;
  description: string;
  /** Extra search terms (matched together with the title). */
  keywords: string[];
  /** Omit for every role. */
  roles?: readonly Role[];
  icon: IconType;
  component: ComponentType;
}

const ADMIN: readonly Role[] = ["admin"];

/** Every settings section, in menu order. */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: "company",
    title: "Company Settings",
    description: "Company name, contact details and logo.",
    keywords: ["name", "email", "phone", "website", "logo", "brand", "organisation", "organization"],
    roles: ADMIN,
    icon: LuBuilding2,
    component: CompanySection,
  },
  {
    id: "address",
    title: "Business Address",
    description: "Your registered address, shown in email footers.",
    keywords: ["address", "city", "state", "postal", "zip", "country", "footer"],
    roles: ADMIN,
    icon: LuMapPin,
    component: AddressSection,
  },
  {
    id: "app",
    title: "App Settings",
    description: "Timezone, date and time formats, week start, currency and app URL.",
    keywords: ["timezone", "time zone", "date format", "time format", "12h", "24h", "week", "sunday", "monday", "currency", "url", "link"],
    roles: ADMIN,
    icon: LuSlidersHorizontal,
    component: AppSection,
  },
  {
    id: "profile",
    title: "Profile Settings",
    description: "Your name, employment details and department.",
    keywords: ["profile", "name", "account", "employment", "department", "me"],
    icon: LuUserRound,
    component: ProfileSection,
  },
  {
    id: "notifications",
    title: "Notification Settings",
    description: "Choose which emails you receive.",
    keywords: ["email", "notifications", "smtp", "mail", "test email", "preferences"],
    icon: LuBell,
    component: NotificationSection,
  },
  {
    id: "tasks",
    title: "Task Settings",
    description: "Labels, categories and due-date reminders for tasks.",
    keywords: ["labels", "categories", "reminders", "due date"],
    roles: ADMIN,
    icon: LuClipboardList,
    component: TaskSection,
  },
  {
    id: "projects",
    title: "Project Settings",
    description: "Project statuses, categories and deadline reminders.",
    keywords: ["statuses", "categories", "deadline", "reminders"],
    roles: ADMIN,
    icon: LuFolderKanban,
    component: ProjectSection,
  },
  {
    id: "time-logs",
    title: "Time Log Settings",
    description: "Who can log time, approvals, auto-stop, tracker reminders and the daily report.",
    keywords: ["timelog", "time log", "timer", "approval", "auto stop", "tracker", "daily report"],
    roles: ADMIN,
    icon: LuTimer,
    component: TimeLogSection,
  },
  {
    id: "leaves",
    title: "Leave Settings",
    description: "Leave policies: limits per request and per year for each leave type.",
    keywords: ["leave", "policies", "policy", "types", "annual", "sick", "entitlement"],
    roles: ADMIN,
    icon: LuCalendarDays,
    component: LeaveSection,
  },
  {
    id: "meetings",
    title: "Meeting Settings",
    description: "AI action-item extraction status.",
    keywords: ["meetings", "ai", "gemini", "transcript", "extraction"],
    roles: ADMIN,
    icon: LuMessagesSquare,
    component: MeetingSection,
  },
  {
    id: "imports",
    title: "Imports",
    description: "History of project and task imports, error reports and undo.",
    keywords: ["import", "excel", "xlsx", "csv", "spreadsheet", "upload", "undo", "history"],
    roles: ADMIN,
    icon: LuFileUp,
    component: ImportsHistorySection,
  },
  {
    id: "security",
    title: "Security",
    description: "Change your password.",
    keywords: ["password", "security", "sign in", "login"],
    icon: LuShieldCheck,
    component: SecuritySection,
  },
];

export function sectionsForRole(role: Role): SettingsSectionDef[] {
  return SETTINGS_SECTIONS.filter((section) => !section.roles || section.roles.includes(role));
}

export function defaultSectionId(role: Role): string {
  return role === "admin" ? "company" : "profile";
}

/** Case-insensitive match on the title and keywords. */
export function matchesSearch(section: SettingsSectionDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [section.title, section.description, ...section.keywords].join(" ").toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}
