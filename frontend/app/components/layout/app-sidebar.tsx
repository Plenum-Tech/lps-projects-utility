import {
  Activity,
  BarChart3,
  Building2,
  CalendarCheck,
  CalendarDays,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  FileText,
  FolderKanban,
  GraduationCap,
  History,
  ListChecks,
  MailPlus,
  Timer,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Megaphone,
  MessageSquareText,
  MessagesSquare,
  Settings,
  Sparkles,
  Trophy,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";

import { BrandLogo, BrandMark, useBrand } from "@/components/layout/brand";
import { PRODUCT_NAME, PRODUCT_SHORT_NAME, PRODUCT_TAGLINE } from "@/lib/brand";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useCurrentUser, useLogout } from "@/hooks/use-auth";
import { useApprovalQueue } from "@/hooks/use-project-approval";
import { FEATURES, type FeatureName } from "@/lib/features";
import type { Role } from "@/types";

const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  employee: "Employee",
  head: "Head of Department",
};

interface NavItem {
  title: string;
  /** Link target; a per-role map opens the right view for each role. */
  to: string | Partial<Record<Role, string>>;
  icon: LucideIcon;
  /** Omit for every role. */
  roles?: Role[];
  /** Extra path prefixes that mark this item active (e.g. /projects/:id). */
  match?: string[];
  /** Custom active test (pathname + query), e.g. two tabs of one page. */
  isActive?: (pathname: string, search: URLSearchParams) => boolean;
  /** Shown only while this feature switch is on (lib/features.ts). */
  feature?: FeatureName;
  /** Shown only to project approvers, with the number of projects waiting. */
  approvers?: boolean;
  /** Shown only to people who may see the Time Log Report (admins, heads, Finance). */
  timeReport?: boolean;
}

interface ResolvedNavItem extends Omit<NavItem, "to"> {
  to: string;
  /** Count shown at the end of the item (e.g. projects waiting for approval). */
  count?: number;
}

interface NavGroup {
  /** Omit for an unlabelled block (Dashboard, Settings). */
  label?: string;
  items: NavItem[];
  /** Collapsible groups remember their open state per browser. */
  collapsible?: boolean;
}

interface ResolvedNavGroup {
  key: string;
  label?: string;
  collapsible?: boolean;
  items: ResolvedNavItem[];
}

interface NavLocation {
  pathname: string;
  search: URLSearchParams;
}

const ADMIN: Role[] = ["admin"];
const MANAGERS: Role[] = ["admin", "head"];

const usersTab = (search: URLSearchParams) =>
  search.get("tab") === "invitations" ? "invitations" : "users";

/**
 * Dashboard · HR · Work · Reports · Settings. Items are filtered by role and
 * feature switch; a group left empty for a role is hidden.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ title: "Dashboard", to: "/dashboard", icon: LayoutDashboard }],
  },
  {
    label: "HR",
    collapsible: true,
    items: [
      {
        title: "Employees",
        to: "/admin/users",
        icon: Users,
        roles: ADMIN,
        isActive: (pathname, search) => pathname === "/admin/users" && usersTab(search) === "users",
      },
      { title: "Departments", to: "/admin/departments", icon: Building2, roles: ADMIN },
      {
        title: "Leaves",
        to: { admin: "/leaves?tab=team", head: "/leaves?tab=team", employee: "/leaves" },
        icon: CalendarDays,
        match: ["/admin/leaves"],
      },
      { title: "Attendance", to: "/attendance", icon: CalendarCheck },
      { title: "Documents", to: "/documents", icon: FileText },
      {
        title: "Performance Reviews",
        to: {
          admin: "/performance-reviews?tab=team",
          head: "/performance-reviews?tab=team",
          employee: "/performance-reviews",
        },
        icon: Trophy,
        match: ["/admin/performance-reviews"],
      },
      {
        title: "Feedback",
        to: { admin: "/feedback?tab=all", head: "/feedback", employee: "/feedback" },
        icon: MessageSquareText,
        match: ["/admin/feedback"],
      },
      { title: "Announcements", to: "/announcements", icon: Megaphone },
      { title: "Training", to: "/training", icon: GraduationCap, match: ["/training/"] },
      {
        title: "Invitations",
        to: "/admin/users?tab=invitations",
        icon: MailPlus,
        roles: ADMIN,
        isActive: (pathname, search) =>
          pathname === "/admin/users" && usersTab(search) === "invitations",
      },
    ],
  },
  {
    label: "Work",
    collapsible: true,
    items: [
      { title: "Projects", to: "/projects", icon: FolderKanban, match: ["/projects/"] },
      { title: "Approvals", to: "/approvals", icon: ClipboardCheck, approvers: true },
      { title: "Tasks", to: "/tasks", icon: ClipboardList, match: ["/tasks/"] },
      { title: "Meetings", to: "/meetings", icon: MessagesSquare, match: ["/meetings/"] },
      { title: "Manpower plan", to: "/manpower", icon: UsersRound, roles: MANAGERS },
      { title: "Timesheet", to: "/timesheet", icon: Timer, match: ["/timelogs"] },
    ],
  },
  {
    label: "Reports",
    collapsible: true,
    items: [
      { title: "Delivery Pulse", to: "/reports/delivery", icon: Activity },
      { title: "Task Report", to: "/reports/tasks", icon: ListChecks },
      { title: "Time Log Report", to: "/reports/time", icon: BarChart3, timeReport: true },
      // Weekly Timesheet (submit/approve workflow) is hidden: hours are covered by the
      // Time Log Report. The page still exists at /reports/timesheets.
      { title: "Activity Log", to: "/admin/activity-log", icon: History, roles: ADMIN },
      {
        title: "AI Insights",
        to: { admin: "/admin/ai-insights", head: "/admin/ai-insights", employee: "/ai-insights" },
        icon: Sparkles,
        feature: "aiInsights",
        match: ["/ai-insights"],
      },
    ],
  },
  {
    items: [{ title: "Settings", to: "/settings", icon: Settings, match: ["/settings/"] }],
  },
];

function resolveGroups(
  role: Role,
  approver: { isApprover: boolean; pending: number },
  access: { timeReport: boolean },
): ResolvedNavGroup[] {
  return NAV_GROUPS.map((group, index) => ({
    key: group.label ?? `block-${index}`,
    label: group.label,
    collapsible: group.collapsible,
    items: group.items
      .filter((item) => !item.roles || item.roles.includes(role))
      .filter((item) => !item.feature || FEATURES[item.feature])
      .filter((item) => !item.approvers || approver.isApprover)
      .filter((item) => !item.timeReport || access.timeReport)
      .map((item) => ({
        ...item,
        to: typeof item.to === "string" ? item.to : (item.to[role] ?? ""),
        count: item.approvers ? approver.pending : undefined,
      }))
      .filter((item) => item.to !== ""),
  })).filter((group) => group.items.length > 0);
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * App sidebar: company brand, role-gated navigation, user card (→ profile
 * settings) and sign out.
 *
 * `RequireAuth` gates the layout before this renders, so the current user is
 * always available here.
 */
export function AppSidebar() {
  const { data: user } = useCurrentUser();
  const { pathname, search } = useLocation();
  const logout = useLogout();
  const navigate = useNavigate();
  const brand = useBrand();
  const approvals = useApprovalQueue(Boolean(user));

  if (!user) return null;

  const groups = resolveGroups(
    user.role,
    {
      isApprover: Boolean(approvals.data?.isApprover),
      // Projects and new brands waiting for leadership.
      pending: (approvals.data?.pending.length ?? 0) + (approvals.data?.brands?.pending.length ?? 0),
    },
    { timeReport: user.access?.timeReport ?? user.role !== "employee" },
  );
  const location: NavLocation = { pathname, search: new URLSearchParams(search) };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link
          to="/dashboard"
          title={`${PRODUCT_NAME} — Dashboard`}
          className="flex flex-col items-start gap-2 rounded-lg px-1 py-1 outline-none ring-sidebar-ring focus-visible:ring-2 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0"
        >
          <BrandLogo src={brand.logo} className="h-9 group-data-[collapsible=icon]:hidden" />
          <BrandMark
            src={brand.logo}
            className="hidden size-8 rounded-lg group-data-[collapsible=icon]:flex"
          />
          <span className="grid min-w-0 max-w-full leading-tight group-data-[collapsible=icon]:sr-only">
            <span className="truncate font-heading text-sm font-semibold">
              <span className="sr-only">{PRODUCT_SHORT_NAME} – </span>
              {PRODUCT_TAGLINE}
            </span>
            {brand.company && (
              <span className="truncate text-xs text-sidebar-foreground/60">{brand.company}</span>
            )}
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) =>
          group.collapsible && group.label ? (
            <CollapsibleNavGroup
              key={group.key}
              label={group.label}
              items={group.items}
              location={location}
            />
          ) : (
            <SidebarGroup key={group.key}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <NavItems items={group.items} location={location} />
              </SidebarGroupContent>
            </SidebarGroup>
          )
        )}
      </SidebarContent>

      <SidebarFooter>
        <Link
          to="/settings/profile"
          title="Profile settings"
          className="flex items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-2 outline-none transition-colors duration-150 ease-out hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0"
        >
          <Avatar className="size-8">
            <AvatarFallback>{initials(user.name)}</AvatarFallback>
          </Avatar>
          <span className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-medium">{user.name}</span>
            <span className="truncate text-xs text-sidebar-foreground/60">
              {ROLE_LABELS[user.role]}
            </span>
          </span>
          <span className="sr-only">— open profile settings</span>
        </Link>
        <Button
          variant="ghost"
          onClick={() => logout.mutate(undefined, { onSuccess: () => navigate("/") })}
          disabled={logout.isPending}
          className="w-full justify-start gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          {logout.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <LogOut />
          )}
          <span className="group-data-[collapsible=icon]:hidden">
            {logout.isPending ? "Signing out…" : "Sign out"}
          </span>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}

function isItemActive(item: ResolvedNavItem, { pathname, search }: NavLocation) {
  if (item.isActive) return item.isActive(pathname, search);
  const path = item.to.split("?")[0];
  return pathname === path || (item.match ?? []).some((prefix) => pathname.startsWith(prefix));
}

function NavItems({ items, location }: { items: ResolvedNavItem[]; location: NavLocation }) {
  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.title}>
          <SidebarMenuButton
            render={<Link to={item.to} />}
            isActive={isItemActive(item, location)}
            tooltip={item.title}
            className="rounded-lg group-data-[collapsible=icon]:justify-center before:absolute before:top-1/2 before:left-0 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-sidebar-primary before:opacity-0 before:transition-opacity data-active:before:opacity-100 group-data-[collapsible=icon]:before:hidden"
          >
            <item.icon />
            <span>{item.title}</span>
          </SidebarMenuButton>
          {item.count ? (
            <SidebarMenuBadge aria-label={`${item.count} waiting`} className="bg-primary text-primary-foreground">
              {item.count}
            </SidebarMenuBadge>
          ) : null}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

const GROUP_STORAGE_PREFIX = "ems.sidebar.group.";

function readGroupOpen(label: string): boolean | null {
  try {
    const stored = window.localStorage.getItem(GROUP_STORAGE_PREFIX + label);
    return stored === "open" ? true : stored === "closed" ? false : null;
  } catch {
    return null;
  }
}

function storeGroupOpen(label: string, open: boolean) {
  try {
    window.localStorage.setItem(GROUP_STORAGE_PREFIX + label, open ? "open" : "closed");
  } catch {
    // Storage unavailable — the group still toggles for this visit.
  }
}

/**
 * Collapsible nav group (HR, Work, Reports). Open by default; the state is kept
 * in localStorage. In the icon rail the items are always shown, and a group
 * holding the active page re-opens itself.
 */
function CollapsibleNavGroup({
  label,
  items,
  location,
}: {
  label: string;
  items: ResolvedNavItem[];
  location: NavLocation;
}) {
  const { state, isMobile } = useSidebar();
  const [open, setOpen] = useState(true);
  const hasActive = items.some((item) => isItemActive(item, location));

  useEffect(() => {
    const stored = readGroupOpen(label);
    if (stored !== null) setOpen(stored);
  }, [label]);

  useEffect(() => {
    if (hasActive) setOpen(true);
  }, [hasActive]);

  const iconRail = state === "collapsed" && !isMobile;
  const contentId = `sidebar-group-${label.toLowerCase()}`;

  return (
    <Collapsible
      open={iconRail || open}
      onOpenChange={(next) => {
        setOpen(next);
        storeGroupOpen(label, next);
      }}
      render={<SidebarGroup />}
    >
      <SidebarGroupLabel
        render={
          <CollapsibleTrigger
            aria-controls={contentId}
            className="group/collapsible-trigger w-full cursor-pointer justify-between hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          />
        }
      >
        {label}
        <ChevronRight
          aria-hidden
          className="transition-transform duration-200 ease-out group-data-[panel-open]/collapsible-trigger:rotate-90"
        />
      </SidebarGroupLabel>
      <CollapsibleContent id={contentId}>
        <SidebarGroupContent>
          <NavItems items={items} location={location} />
        </SidebarGroupContent>
      </CollapsibleContent>
    </Collapsible>
  );
}
