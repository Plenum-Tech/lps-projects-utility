import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  LuCheck,
  LuCircleAlert,
  LuCopy,
  LuLoaderCircle,
  LuMailCheck,
  LuRefreshCw,
  LuSend,
  LuUserCheck,
  LuUserPlus,
} from "react-icons/lu";

import { MultiSelect, type MultiSelectOption } from "@/components/globals/multi-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmailChipsInput, isValidEmail } from "@/components/users/email-chips-input";
import { useDepartments } from "@/hooks/use-departments";
import { copyInviteLink, useCreateInvitations } from "@/hooks/use-invitations";
import { useProjectOptions } from "@/hooks/use-projects";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { InviteResult, InviteResultStatus, Role } from "@/types";

const MAX_EMAILS = 50;
const MAX_PROJECTS = 20;
const MESSAGE_MAX = 500;

const RESULT_META: Record<
  InviteResultStatus,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive"; icon: typeof LuCheck }
> = {
  invited: { label: "Invited", variant: "default", icon: LuMailCheck },
  resent: { label: "Re-sent", variant: "secondary", icon: LuRefreshCw },
  already_user: { label: "Already a user", variant: "outline", icon: LuUserCheck },
  invalid: { label: "Invalid", variant: "destructive", icon: LuCircleAlert },
};

/**
 * Admin "Invite people" dialog: many emails + role/department/projects/message,
 * then a results step with each email's outcome and a Copy link fallback for
 * when email delivery fails.
 */
export function InviteDialog({
  open,
  onOpenChange,
  onViewInvitations,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Switches the page to the Invitations tab. */
  onViewInvitations?: () => void;
}) {
  const create = useCreateInvitations();
  const [results, setResults] = useState<InviteResult[] | null>(null);

  useEffect(() => {
    if (open) {
      setResults(null);
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        {results ? (
          <InviteResults
            results={results}
            onInviteMore={() => setResults(null)}
            onDone={() => onOpenChange(false)}
            onViewInvitations={
              onViewInvitations
                ? () => {
                    onOpenChange(false);
                    onViewInvitations();
                  }
                : undefined
            }
          />
        ) : (
          <InviteForm
            pending={create.isPending}
            error={create.error}
            onCancel={() => onOpenChange(false)}
            onSubmit={(input) => create.mutate(input, { onSuccess: setResults })}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1: form                                                        */
/* ------------------------------------------------------------------ */

function InviteForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (input: {
    emails: string[];
    role: Role;
    department: string | null;
    projects: string[];
    message?: string;
  }) => void;
}) {
  const { data: departmentsData } = useDepartments();
  const projectsQuery = useProjectOptions();
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<Role>("employee");
  const [department, setDepartment] = useState<string | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const departmentOptions = useMemo(
    () => (departmentsData?.departments ?? []).map((item) => ({ value: item._id, label: item.name })),
    [departmentsData]
  );
  const selectedDepartment = departmentOptions.find((option) => option.value === department) ?? null;
  const projectOptions = useMemo<MultiSelectOption[]>(
    () =>
      (projectsQuery.data ?? []).map((project) => ({
        value: project._id,
        label: `${project.code} · ${project.name}`,
      })),
    [projectsQuery.data]
  );

  const validCount = emails.filter(isValidEmail).length;
  const emailsInvalid = submitted && validCount === 0;
  const headDepartmentInvalid = submitted && role === "head" && !department;
  const messageTooLong = message.trim().length > MESSAGE_MAX;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (validCount === 0) return;
    if (role === "head" && !department) return;
    if (messageTooLong) return;
    onSubmit({
      emails,
      role,
      department,
      projects,
      message: message.trim() || undefined,
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Invite people</DialogTitle>
        <DialogDescription>
          Each person gets an email with a link to set their name and password. Links expire after 7 days.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="invite-emails">Email addresses</Label>
          <EmailChipsInput
            id="invite-emails"
            value={emails}
            onValueChange={setEmails}
            max={MAX_EMAILS}
            invalid={emailsInvalid}
            disabled={pending}
            aria-describedby={emailsInvalid ? "invite-emails-error" : undefined}
          />
          {emailsInvalid && (
            <p id="invite-emails-error" className="text-xs text-destructive">
              Add at least one valid email address.
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as Role)}
              items={{ employee: "Employee", head: "Head of Department", admin: "Admin" }}
              disabled={pending}
            >
              <SelectTrigger id="invite-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="employee">Employee</SelectItem>
                <SelectItem value="head">Head of Department</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-department">
              Department
              {role !== "head" && <span className="font-normal text-muted-foreground">(optional)</span>}
            </Label>
            <Combobox
              items={departmentOptions}
              value={selectedDepartment}
              onValueChange={(item) => setDepartment(item?.value ?? null)}
              autoHighlight
              disabled={pending}
            >
              <ComboboxInput
                id="invite-department"
                placeholder="Search departments…"
                className="w-full"
                showClear
                aria-invalid={headDepartmentInvalid || undefined}
                aria-describedby={headDepartmentInvalid ? "invite-department-error" : undefined}
              />
              <ComboboxContent sideOffset={4}>
                <ComboboxEmpty>No departments found.</ComboboxEmpty>
                <ComboboxList>
                  {(item) => (
                    <ComboboxItem key={item.value} value={item}>
                      {item.label}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            {headDepartmentInvalid ? (
              <p id="invite-department-error" className="text-xs text-destructive">
                A head of department must be assigned to a department.
              </p>
            ) : role === "head" ? (
              <p className="text-xs text-muted-foreground">Required for a head of department.</p>
            ) : null}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="invite-projects">
            Projects <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <MultiSelect
            id="invite-projects"
            options={projectOptions}
            value={projects}
            onValueChange={setProjects}
            placeholder={projectsQuery.isPending ? "Loading projects…" : "Add to projects…"}
            emptyText="No active projects."
            max={MAX_PROJECTS}
            disabled={pending}
            aria-describedby="invite-projects-hint"
          />
          <p id="invite-projects-hint" className="text-xs text-muted-foreground">
            They join these projects as members when they accept (up to {MAX_PROJECTS}).
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="invite-message">
            Personal message <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="invite-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Welcome to the team! Here's your LPS account."
            rows={3}
            maxLength={MESSAGE_MAX + 50}
            disabled={pending}
            aria-invalid={messageTooLong || undefined}
            aria-describedby="invite-message-count"
          />
          <p
            id="invite-message-count"
            className={cn("text-right text-xs tabular-nums", messageTooLong ? "text-destructive" : "text-muted-foreground")}
          >
            {message.trim().length} / {MESSAGE_MAX}
          </p>
        </div>

        {Boolean(error) && (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>Couldn&apos;t send invites</AlertTitle>
            <AlertDescription>{getErrorMessage(error)}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || messageTooLong}>
            {pending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSend aria-hidden />}
            {pending
              ? "Sending…"
              : validCount > 1
                ? `Send ${validCount} invites`
                : "Send invite"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2: results                                                     */
/* ------------------------------------------------------------------ */

function InviteResults({
  results,
  onInviteMore,
  onDone,
  onViewInvitations,
}: {
  results: InviteResult[];
  onInviteMore: () => void;
  onDone: () => void;
  onViewInvitations?: () => void;
}) {
  const sent = results.filter((result) => result.status === "invited" || result.status === "resent").length;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {sent > 0 ? `${sent} ${sent === 1 ? "invite" : "invites"} sent` : "No invites sent"}
        </DialogTitle>
        <DialogDescription>
          If an email doesn&apos;t arrive, copy the link and share it directly. Each link works once.
        </DialogDescription>
      </DialogHeader>

      <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border" aria-label="Invite results">
        {results.map((result) => {
          const meta = RESULT_META[result.status];
          const Icon = meta.icon;
          return (
            <li key={result.email} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{result.email}</p>
                <Badge variant={meta.variant} className="mt-1">
                  <Icon aria-hidden />
                  {meta.label}
                </Badge>
              </div>
              {result.acceptUrl && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copyInviteLink(result.acceptUrl!)}
                  aria-label={`Copy invite link for ${result.email}`}
                >
                  <LuCopy aria-hidden />
                  Copy link
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <DialogFooter className="gap-2 sm:justify-between">
        <Button type="button" variant="ghost" onClick={onInviteMore}>
          <LuUserPlus aria-hidden />
          Invite more
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          {onViewInvitations && (
            <Button type="button" variant="outline" onClick={onViewInvitations}>
              View invitations
            </Button>
          )}
          <Button type="button" onClick={onDone}>
            <LuCheck aria-hidden />
            Done
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
