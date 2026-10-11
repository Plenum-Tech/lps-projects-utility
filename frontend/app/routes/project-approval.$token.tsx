import { useState } from "react";
import { Link } from "react-router";
import { LuCircleCheck, LuCircleX, LuClock, LuLoaderCircle } from "react-icons/lu";

import { RejectDialog } from "@/components/projects/project-approval";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApprovalLink, useDecideByLink } from "@/hooks/use-project-approval";
import { getErrorMessage } from "@/lib/api";
import { PRODUCT_NAME } from "@/lib/brand";

import type { Route } from "./+types/project-approval.$token";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Project approval | LPS" }, { name: "robots", content: "noindex" }];
}

/**
 * Public page behind the emailed approval link: shows the project and asks the
 * approver to press Approve or Reject (opening the link alone changes nothing).
 */
export default function ProjectApprovalRoute({ params }: Route.ComponentProps) {
  const link = useApprovalLink(params.token);
  const decide = useDecideByLink(params.token);
  const [rejecting, setRejecting] = useState(false);
  const project = link.data?.project;
  const status = project?.approval?.status;

  return (
    <main className="flex min-h-dvh items-start justify-center bg-muted/40 px-4 py-10 sm:py-16">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardDescription>{PRODUCT_NAME}</CardDescription>
          <CardTitle className="text-xl">Project approval</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {link.isPending && <Skeleton className="h-48 w-full" />}
          {link.isError && (
            <Alert variant="destructive">
              <AlertTitle>Can&apos;t open this link</AlertTitle>
              <AlertDescription>{getErrorMessage(link.error)}</AlertDescription>
            </Alert>
          )}
          {project && (
            <>
              <p className="text-sm text-muted-foreground">
                Hi {link.data!.approver.name.split(" ")[0]}. {project.requestedBy ?? "Someone"} needs your approval before the team
                can add tasks to this project.
              </p>
              <div className="rounded-lg border bg-card p-4">
                <p className="font-medium break-words text-foreground">{project.name}</p>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  {(
                    [
                      ["Code", project.code],
                      ["Tag", project.tag],
                      ["Brand", project.brand],
                      ["Type", project.type],
                      ["Month", project.month],
                      ["Manager", project.manager],
                      ["Team", project.team.length ? project.team.join(", ") : null],
                    ] as Array<[string, string | null]>
                  )
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="break-words text-foreground">{v}</dd>
                      </div>
                    ))}
                </dl>
                {project.summary && <p className="mt-3 text-sm whitespace-pre-line text-muted-foreground">{project.summary}</p>}
              </div>

              {status === "pending" && (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => decide.mutate({ decision: "approve" })} disabled={decide.isPending}>
                    {decide.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuCircleCheck aria-hidden />}
                    Approve
                  </Button>
                  <Button variant="outline" onClick={() => setRejecting(true)} disabled={decide.isPending}>
                    <LuCircleX aria-hidden />
                    Reject
                  </Button>
                </div>
              )}
              {decide.isError && (
                <Alert variant="destructive">
                  <AlertDescription>{getErrorMessage(decide.error)}</AlertDescription>
                </Alert>
              )}
              {status === "approved" && (
                <Alert>
                  <LuCircleCheck aria-hidden className="size-4" />
                  <AlertTitle>Approved</AlertTitle>
                  <AlertDescription>The team can add tasks now. They&apos;ve been told by email.</AlertDescription>
                </Alert>
              )}
              {status === "rejected" && (
                <Alert variant="destructive">
                  <LuCircleX aria-hidden className="size-4" />
                  <AlertTitle>Rejected</AlertTitle>
                  <AlertDescription>
                    {project.approval?.reason ? `“${project.approval.reason}” — ` : ""}the creator and manager have been told by email.
                  </AlertDescription>
                </Alert>
              )}
              {status === "pending" && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <LuClock aria-hidden className="size-3.5" />
                  This link works once and expires after 30 days.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                <Link to={`/projects/${project._id}`} className="underline underline-offset-4">
                  Open the project in the app
                </Link>
              </p>
            </>
          )}
        </CardContent>
      </Card>
      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        pending={decide.isPending}
        onConfirm={(reason) => decide.mutate({ decision: "reject", reason }, { onSuccess: () => setRejecting(false) })}
      />
    </main>
  );
}
