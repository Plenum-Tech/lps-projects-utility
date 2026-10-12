import { Link } from "react-router";
import {
  AlertCircle,
  CheckCircle2,
  GraduationCap,
  RefreshCw,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyTrainings } from "@/hooks/use-trainings";
import { getErrorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { formatDateOnly } from "@/lib/tasks";
import type { MyTraining, TrainingStatus } from "@/types";

const STATUS_LABEL: Record<TrainingStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
};

/** Cards for the trainings assigned to the current user. */
export function MyTrainings() {
  const query = useMyTrainings();

  if (query.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
        {Array.from({ length: 2 }).map((_, index) => (
          <Skeleton key={index} className="h-40" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Couldn&apos;t load trainings</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          {getErrorMessage(query.error)}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            <RefreshCw />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (query.data.length === 0) {
    return (
      <Empty className="py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GraduationCap />
          </EmptyMedia>
          <EmptyTitle>No trainings yet</EmptyTitle>
          <EmptyDescription>
            Trainings assigned to you will appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const pending = query.data.filter((t) => t.progress.status !== "completed");
  const done = query.data.filter((t) => t.progress.status === "completed");

  return (
    <div className="space-y-8">
      <Section
        title="To complete"
        trainings={pending}
        emptyText="Nothing pending — well done."
      />
      {done.length > 0 && <Section title="Completed" trainings={done} />}
    </div>
  );
}

function Section({
  title,
  trainings,
  emptyText,
}: {
  title: string;
  trainings: MyTraining[];
  emptyText?: string;
}) {
  return (
    <section>
      <h2 className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {trainings.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {trainings.map((training) => (
            <TrainingCard key={training._id} training={training} />
          ))}
        </div>
      )}
    </section>
  );
}

function TrainingCard({ training }: { training: MyTraining }) {
  const { progress } = training;
  const percent =
    training.slideCount === 0
      ? 0
      : Math.round((progress.viewedCount / training.slideCount) * 100);
  const overdue =
    progress.status !== "completed" &&
    training.dueDate &&
    new Date(training.dueDate) < new Date();
  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium text-foreground">{training.title}</h3>
          <Badge
            variant={progress.status === "completed" ? "default" : "secondary"}
            className="shrink-0 gap-1"
          >
            {progress.status === "completed" && (
              <CheckCircle2 className="size-3" />
            )}
            {STATUS_LABEL[progress.status]}
          </Badge>
        </div>
        {training.description && (
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {training.description}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {training.slideCount} slides
          {training.dueDate && (
            <>
              {" · "}
              <span
                className={overdue ? "font-medium text-destructive" : undefined}
              >
                due {formatDateOnly(training.dueDate, true)}
              </span>
            </>
          )}
          {progress.completedAt &&
            ` · completed ${formatDate(progress.completedAt)}`}
        </p>
        {progress.status === "in_progress" && (
          <div className="space-y-1">
            <Progress
              value={percent}
              aria-label={`${progress.viewedCount} of ${training.slideCount} slides read`}
            />
            <p className="text-xs text-muted-foreground">
              {progress.viewedCount} of {training.slideCount} slides read
            </p>
            {(progress.missing?.length ?? 0) > 0 && (
              <p className="text-xs text-warn">
                Not read yet: slide{progress.missing!.length === 1 ? "" : "s"}{" "}
                {progress.missing!.length > 15
                  ? `${progress.missing!.slice(0, 15).join(", ")}…`
                  : progress.missing!.join(", ")}
              </p>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter>
        <Button
          size="sm"
          variant={progress.status === "completed" ? "outline" : "default"}
          render={<Link to={`/training/${training._id}`} />}
          nativeButton={false}
        >
          {progress.status === "completed"
            ? "Open"
            : progress.status === "in_progress"
              ? "Continue"
              : "Start"}
        </Button>
      </CardFooter>
    </Card>
  );
}
