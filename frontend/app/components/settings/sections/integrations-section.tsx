import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { LuCheck, LuCopy, LuKeyRound, LuLoaderCircle, LuPlus, LuShieldOff, LuTriangleAlert } from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { QueryError } from "@/components/globals/query-states";
import { FieldMessage, SettingsFormCard, SettingsFormSkeleton } from "@/components/settings/settings-form-card";
import { errorField, errorMessage, useSettingsForm } from "@/components/settings/use-settings-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { writeClipboard } from "@/hooks/use-password-setup";
import {
  fillPearityTemplate,
  useCreatePearityKey,
  usePearityApiKeys,
  usePearitySettings,
  useRevokePearityKey,
  useUpdatePearitySettings,
} from "@/hooks/use-pearity";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { PearityApiKey, PearityApiScope, PearityPlaceholder } from "@/types";

type PearityForm = { enabled: string; engineUrlTemplate: string; tagUrlTemplate: string; allowedIps: string };

const PLACEHOLDERS: PearityPlaceholder[] = [
  "tagNo",
  "tagId",
  "tagName",
  "taskId",
  "taskCode",
  "taskNo",
  "brand",
  "category",
  "project",
];

/** Sample values for the live preview. */
const EXAMPLE: Record<PearityPlaceholder, string> = {
  tagNo: "12",
  tagId: "pt_7k3m9q2x",
  tagName: "Ajmal_Design_GenAI-Hub-65",
  taskId: "66f1c0ffee0000000000abcd",
  taskCode: "GenAI Hub-65",
  taskNo: "GenAI Hub-65",
  brand: "Ajmal",
  category: "Design",
  project: "Ajmal | Retainer | Oct 2026 | GenAI Hub",
};

const SUGGESTED_TEMPLATE =
  "https://app.pearity.ai/production/new?tagNo={tagNo}&tag={tagName}&taskNo={taskNo}&taskId={taskId}&brand={brand}&category={category}&project={project}";

const SUGGESTED_TAG_URL_TEMPLATE = "https://app.pearity.ai/tags/{tagNo}";

/** Mirrors the server's validation (https only, known placeholders). */
function templateProblem(template: string): string | null {
  const value = template.trim();
  if (!value) return null;
  if (/\s/.test(value)) return "The URL template can't contain spaces.";
  for (const match of value.matchAll(/\{([^{}]*)\}/g)) {
    if (!(PLACEHOLDERS as string[]).includes(match[1] ?? "")) return `Unknown placeholder {${match[1]}}.`;
  }
  try {
    const url = new URL(value.replace(/\{[A-Za-z]+\}/g, "x"));
    if (url.protocol !== "https:") return "The URL template must start with https://";
  } catch {
    return "Enter a full URL starting with https://";
  }
  return null;
}

function parseIps(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((ip) => ip.trim())
    .filter(Boolean);
}

/** Settings → Integrations: Pearity (enable, engine URL template, allowed IPs, API keys). */
export function IntegrationsSection() {
  return (
    <div className="space-y-6">
      <PearitySettingsCard />
      <PearityKeysCard />
    </div>
  );
}

function PearitySettingsCard() {
  const query = usePearitySettings();
  const update = useUpdatePearitySettings();
  const source = useMemo<PearityForm | undefined>(
    () =>
      query.data && {
        enabled: query.data.settings.enabled ? "on" : "off",
        engineUrlTemplate: query.data.settings.engineUrlTemplate,
        tagUrlTemplate: query.data.settings.tagUrlTemplate ?? "",
        allowedIps: query.data.settings.allowedIps.join("\n"),
      },
    [query.data]
  );
  const form = useSettingsForm(source);

  if (query.isPending) return <SettingsFormSkeleton rows={3} />;
  if (query.isError || !form.values || !query.data) {
    return (
      <QueryError
        title="Couldn't load the Pearity settings"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isRefetching}
      />
    );
  }
  const values = form.values;
  const enabled = values.enabled === "on";
  const template = values.engineUrlTemplate.trim();
  const tagTemplate = values.tagUrlTemplate.trim();

  const errors: Partial<Record<keyof PearityForm, string>> = {};
  const problem = templateProblem(template);
  if (problem) errors.engineUrlTemplate = problem;
  else if (enabled && !template) errors.engineUrlTemplate = "Set the URL template before turning the integration on.";
  const tagProblem = templateProblem(tagTemplate);
  if (tagProblem) errors.tagUrlTemplate = tagProblem;
  const serverField = update.isError ? errorField(update.error) : null;
  const fieldError = (key: keyof PearityForm) =>
    errors[key] ?? (serverField === key ? errorMessage(update.error) : null);

  const preview = template && !problem ? fillPearityTemplate(template, EXAMPLE) : null;
  const tagLinkSource = tagTemplate || template;
  const tagPreview =
    tagLinkSource && !tagProblem && !(tagTemplate ? null : problem)
      ? fillPearityTemplate(tagLinkSource, EXAMPLE)
      : null;

  function save() {
    if (Object.keys(errors).length > 0) return;
    const input: Parameters<typeof update.mutate>[0] = {};
    for (const key of form.changed) {
      if (key === "enabled") input.enabled = enabled;
      if (key === "engineUrlTemplate") input.engineUrlTemplate = template;
      if (key === "tagUrlTemplate") input.tagUrlTemplate = tagTemplate;
      if (key === "allowedIps") input.allowedIps = parseIps(values.allowedIps);
    }
    update.mutate(input);
  }

  return (
    <SettingsFormCard
      title="Pearity"
      description="Generate content in Pearity's production engine straight from a task. Each task gets one stable Pearity tag."
      dirty={form.dirty}
      pending={update.isPending}
      onSubmit={save}
      onReset={form.reset}
    >
      <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="pearity-enabled">Enable the Pearity integration</Label>
          <p className="text-xs text-muted-foreground">
            Shows the Generate button on tasks and turns on the server-to-server API. When off, the API answers 503.
          </p>
        </div>
        <Switch
          id="pearity-enabled"
          checked={enabled}
          onCheckedChange={(checked) => form.set("enabled", checked ? "on" : "off")}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pearity-template">Production engine URL template</Label>
        <Textarea
          id="pearity-template"
          value={values.engineUrlTemplate}
          onChange={(event) => form.set("engineUrlTemplate", event.target.value)}
          placeholder={SUGGESTED_TEMPLATE}
          rows={3}
          spellCheck={false}
          className="font-mono text-xs"
          aria-invalid={Boolean(fieldError("engineUrlTemplate"))}
          aria-describedby="pearity-template-message"
        />
        <FieldMessage
          id="pearity-template-message"
          error={fieldError("engineUrlTemplate")}
          hint={
            <>
              https:// only. Placeholders (values are URL-encoded):{" "}
              {PLACEHOLDERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => form.set("engineUrlTemplate", `${values.engineUrlTemplate}{${p}}`)}
                  className="mr-1 rounded bg-muted px-1 font-mono text-[0.7rem] text-foreground outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
                  title={`Append {${p}}`}
                >
                  {`{${p}}`}
                </button>
              ))}
              <span className="block">
                {"{tagNo}"} is the tag number (1, 2, 3, …) — use it to identify tags. {"{taskNo}"} is the task number
                users see, e.g. GenAI Hub-65 (or #56 for tasks without a code). {"{tagId}"} still works for older links.
              </span>
            </>
          }
        />
        {!values.engineUrlTemplate && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => form.set("engineUrlTemplate", SUGGESTED_TEMPLATE)}
          >
            Use the suggested template
          </Button>
        )}
        {preview && (
          <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
            <p className="text-xs font-medium text-muted-foreground">Example for tag #12 on task GenAI Hub-65</p>
            <p className="font-mono text-xs break-all text-foreground">{preview}</p>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pearity-tag-url">Tag link URL (optional)</Label>
        <Textarea
          id="pearity-tag-url"
          value={values.tagUrlTemplate}
          onChange={(event) => form.set("tagUrlTemplate", event.target.value)}
          placeholder={SUGGESTED_TAG_URL_TEMPLATE}
          rows={2}
          spellCheck={false}
          className="font-mono text-xs"
          aria-invalid={Boolean(fieldError("tagUrlTemplate"))}
          aria-describedby="pearity-tag-url-message"
        />
        <FieldMessage
          id="pearity-tag-url-message"
          error={fieldError("tagUrlTemplate")}
          hint={
            <>
              Where a tag opens in Pearity. If empty, tags open the production engine URL. Same placeholders, e.g.{" "}
              <span className="font-mono">{SUGGESTED_TAG_URL_TEMPLATE}</span>
            </>
          }
        />
        {!values.tagUrlTemplate && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => form.set("tagUrlTemplate", SUGGESTED_TAG_URL_TEMPLATE)}
          >
            Use the suggested tag link
          </Button>
        )}
        {tagPreview && (
          <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
            <p className="text-xs font-medium text-muted-foreground">
              Tag #12 opens{tagTemplate ? "" : " (production engine URL)"}
            </p>
            <p className="font-mono text-xs break-all text-foreground">{tagPreview}</p>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pearity-ips">Allowed IPs for API calls (optional)</Label>
        <Textarea
          id="pearity-ips"
          value={values.allowedIps}
          onChange={(event) => form.set("allowedIps", event.target.value)}
          placeholder={"203.0.113.7\n198.51.100.0/24"}
          rows={3}
          spellCheck={false}
          className="font-mono text-xs"
          aria-invalid={Boolean(fieldError("allowedIps"))}
          aria-describedby="pearity-ips-message"
        />
        <FieldMessage
          id="pearity-ips-message"
          error={fieldError("allowedIps")}
          hint="One IP or CIDR range per line. Leave empty to accept API calls from any IP (the API key is still required)."
        />
      </div>
    </SettingsFormCard>
  );
}

const SCOPE_INFO: Record<PearityApiScope, string> = {
  "pearity:read": "Read users' tasks and tags",
  "pearity:tags": "Create tags (POST /tasks/:taskId/tag)",
};

function PearityKeysCard() {
  const keys = usePearityApiKeys();
  const revoke = useRevokePearityKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<PearityApiKey | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Keys for Pearity&apos;s server to call <code className="font-mono text-xs">/api/integrations/pearity/v1</code>.
            Only a hash is stored: a new key is shown once.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <LuPlus aria-hidden />
          Create key
        </Button>
      </CardHeader>
      <CardContent>
        {keys.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading API keys">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : keys.isError ? (
          <QueryError
            title="Couldn't load API keys"
            error={keys.error}
            onRetry={() => void keys.refetch()}
            retrying={keys.isRefetching}
          />
        ) : keys.data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
            <LuKeyRound aria-hidden className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No API keys yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Create a key and share it with the Pearity team over a secure channel.
            </p>
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {keys.data.map((key) => (
              <li key={key._id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {key.name}
                    {key.revokedAt ? (
                      <Badge variant="destructive">Revoked</Badge>
                    ) : (
                      <Badge variant="secondary">Active</Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <code className="font-mono">{key.prefix}…</code> · {key.scopes.join(", ")} · created{" "}
                    {formatDistanceToNow(new Date(key.createdAt), { addSuffix: true })}
                    {key.createdBy && ` by ${key.createdBy.name}`} ·{" "}
                    {key.lastUsedAt ? (
                      <span title={formatDateTime(key.lastUsedAt)}>
                        last used {formatDistanceToNow(new Date(key.lastUsedAt), { addSuffix: true })}
                      </span>
                    ) : (
                      "never used"
                    )}
                    {key.revokedAt && ` · revoked ${formatDistanceToNow(new Date(key.revokedAt), { addSuffix: true })}`}
                  </p>
                </div>
                {!key.revokedAt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setRevoking(key)}
                  >
                    <LuShieldOff aria-hidden />
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "this key"}?`}
        description="Pearity calls using this key stop working immediately. This can't be undone; create a new key to restore access."
        confirmLabel="Revoke key"
        destructive
        icon={<LuShieldOff aria-hidden />}
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking._id, { onSettled: () => setRevoking(null) })}
      />
    </Card>
  );
}

function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const create = useCreatePearityKey();
  const toast = useToast();
  const [name, setName] = useState("Pearity production");
  const [scopes, setScopes] = useState<PearityApiScope[]>(["pearity:read", "pearity:tags"]);
  const [copied, setCopied] = useState(false);
  const created = create.data;

  function close(next: boolean) {
    if (next) return onOpenChange(true);
    onOpenChange(false);
    // Forget the plaintext key as soon as the dialog closes.
    window.setTimeout(() => {
      create.reset();
      setCopied(false);
      setName("Pearity production");
      setScopes(["pearity:read", "pearity:tags"]);
    }, 200);
  }

  const nameError = name.trim().length === 0 ? "Give the key a name." : name.trim().length > 80 ? "At most 80 characters." : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && close(next)}>
      <DialogContent className="sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Copy your new API key</DialogTitle>
              <DialogDescription>
                This is the only time the key is shown. Store it in Pearity&apos;s secret manager.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2">
                <code className="min-w-0 flex-1 font-mono text-xs break-all" aria-label="New API key">
                  {created.key}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    if (await writeClipboard(created.key)) {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 2000);
                    } else toast.error("Couldn't copy — your browser blocked clipboard access.");
                  }}
                >
                  {copied ? <LuCheck aria-hidden /> : <LuCopy aria-hidden />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <Alert>
                <LuTriangleAlert aria-hidden className="size-4" />
                <AlertTitle>Treat it like a password</AlertTitle>
                <AlertDescription>
                  Send it as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>. Never put it in a URL.
                </AlertDescription>
              </Alert>
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (nameError || scopes.length === 0) return;
              create.mutate({ name: name.trim(), scopes });
            }}
            className="contents"
          >
            <DialogHeader>
              <DialogTitle>Create a Pearity API key</DialogTitle>
              <DialogDescription>Name it after where it will be used, e.g. &ldquo;Pearity production&rdquo;.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pearity-key-name">Name</Label>
                <Input
                  id="pearity-key-name"
                  value={name}
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                  aria-invalid={Boolean(nameError)}
                  aria-describedby="pearity-key-name-message"
                />
                <FieldMessage id="pearity-key-name-message" error={nameError} />
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Scopes</legend>
                {(Object.keys(SCOPE_INFO) as PearityApiScope[]).map((scope) => (
                  <label key={scope} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={scopes.includes(scope)}
                      onCheckedChange={(checked) =>
                        setScopes((current) =>
                          checked ? [...new Set([...current, scope])] : current.filter((s) => s !== scope)
                        )
                      }
                      className="mt-0.5"
                    />
                    <span>
                      <code className="font-mono text-xs">{scope}</code>
                      <span className="block text-xs text-muted-foreground">{SCOPE_INFO[scope]}</span>
                    </span>
                  </label>
                ))}
                {scopes.length === 0 && <p className="text-xs text-destructive">Pick at least one scope.</p>}
              </fieldset>
              {create.isError && (
                <p className="text-sm text-destructive" role="alert">
                  {getErrorMessage(create.error)}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)} disabled={create.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || Boolean(nameError) || scopes.length === 0}>
                {create.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuKeyRound aria-hidden />}
                Create key
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
