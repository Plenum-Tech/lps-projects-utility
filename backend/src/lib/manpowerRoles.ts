/**
 * Roles of the manpower plan (the columns of the planning sheet). The project
 * team step uses the same roles plus "others".
 */
export const MANPOWER_ROLES = [
  { key: "programLead", label: "Program Lead" },
  { key: "pm", label: "SPM / PM" },
  { key: "programExecution", label: "Program Execution" },
  { key: "socialMedia", label: "Social Media Manager / Creator" },
  { key: "videographer", label: "Videographer" },
  { key: "juniorVideo", label: "Junior Video" },
  { key: "editor", label: "Editor" },
  { key: "creativeLead", label: "Creative Lead" },
  { key: "englishCopy", label: "English Copy" },
  { key: "arabicCopy", label: "Arabic Copy" },
  { key: "artDirector", label: "Art Director" },
  { key: "designer", label: "Designer" },
  { key: "animator", label: "Animator" },
  { key: "producer", label: "Producer" },
  { key: "cmLead", label: "CM Lead" },
  { key: "communityManager", label: "Community Manager" },
] as const;

export type ManpowerRole = (typeof MANPOWER_ROLES)[number]["key"];
export const MANPOWER_ROLE_KEYS: readonly string[] = MANPOWER_ROLES.map((r) => r.key);

/** Project team roles: the plan roles plus "others" (people without a plan role). */
export const TEAM_ROLE_KEYS: readonly string[] = [...MANPOWER_ROLE_KEYS, "others"];

export const MANPOWER_LIMITS = {
  maxRows: 300,
  nameMax: 120,
  noteMax: 300,
  placeholderMax: 60,
  maxPlaceholdersPerCell: 6,
  maxUsersPerCell: 20,
  versionNoteMax: 300,
  defaultMaxProjectsPerPerson: 6,
  maxProjectsPerPersonMax: 100,
} as const;
