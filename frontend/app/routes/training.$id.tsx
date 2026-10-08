import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Circle,
  Download,
  GraduationCap,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  trainingSlideUrl,
  trainingSourceUrl,
  useCompleteTraining,
  useRecordTrainingProgress,
  useTraining,
} from "@/hooks/use-trainings";
import { getErrorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { formatDateOnly } from "@/lib/tasks";

import type { Route } from "./+types/training.$id";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Training | LPS" }];
}

/** A slide counts as read once at least half of it has been on screen this long. */
const READ_AFTER_MS = 1500;
/** Seen slides are sent to the server in small batches. */
const FLUSH_MS = 1200;

/**
 * Terms-style training reader: every slide one under another; each is marked
 * read once it has been on screen. The acknowledgement and "Complete training"
 * unlock only when all slides are read.
 */
export default function TrainingReader() {
  const { id = "" } = useParams();
  const query = useTraining(id);
  const record = useRecordTrainingProgress(id);
  const complete = useCompleteTraining(id);
  const [acknowledged, setAcknowledged] = useState(false);

  const data = query.data;
  const training = data?.training;
  const tracking = Boolean(data?.assigned && !data.progress.completedAt);

  // Slides read: server state + slides seen in this session (optimistic).
  const [seen, setSeen] = useState<Set<number>>(new Set());
  const pending = useRef<Set<number>>(new Set());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const read = new Set([...(data?.progress.viewed ?? []), ...seen]);
  const total = training?.slideCount ?? 0;
  const readCount = Math.min(read.size, total);
  const left = total - readCount;
  const allRead = total > 0 && left === 0;

  const recordRef = useRef(record.mutate);
  recordRef.current = record.mutate;

  function markRead(slide: number) {
    setSeen((current) =>
      current.has(slide) ? current : new Set(current).add(slide),
    );
    pending.current.add(slide);
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      const slides = [...pending.current];
      pending.current.clear();
      if (slides.length > 0) recordRef.current(slides);
    }, FLUSH_MS);
  }
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;

  // Watch the slides; a slide that stays at least half visible for READ_AFTER_MS is read.
  const slideRefs = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    if (!tracking || total === 0) return;
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const slide = Number((entry.target as HTMLElement).dataset.slide);
          if (entry.isIntersecting) {
            if (!timers.has(slide)) {
              timers.set(
                slide,
                setTimeout(() => {
                  timers.delete(slide);
                  markReadRef.current(slide);
                }, READ_AFTER_MS),
              );
            }
          } else {
            clearTimeout(timers.get(slide));
            timers.delete(slide);
          }
        }
      },
      { threshold: [0.5] },
    );
    for (const element of slideRefs.current)
      if (element) observer.observe(element);
    return () => {
      observer.disconnect();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [tracking, total]);

  // Send anything still queued when leaving the page.
  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      const slides = [...pending.current];
      if (slides.length > 0) recordRef.current(slides);
    },
    [],
  );

  if (query.isPending) {
    return (
      <div
        className="mx-auto w-full max-w-5xl space-y-4 px-4 py-8 sm:px-6 lg:px-8"
        aria-busy="true"
      >
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="aspect-video w-full" />
      </div>
    );
  }

  if (query.isError || !data || !training) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Couldn&apos;t open this training</AlertTitle>
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
      </div>
    );
  }

  const completedAt = data.progress.completedAt;
  const percent = total === 0 ? 0 : Math.round((readCount / total) * 100);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-12 sm:px-6 lg:px-8">
      {/* Sticky header with reading progress */}
      <header className="sticky top-0 z-10 -mx-4 border-b bg-background/95 px-4 pt-6 pb-4 backdrop-blur supports-backdrop-filter:bg-background/80 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <Link
          to="/training"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Training
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {training.title}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {total} slides
              {training.dueDate &&
                ` · due ${formatDateOnly(training.dueDate, true)}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {completedAt ? (
              <Badge className="gap-1">
                <CheckCircle2 className="size-3.5" />
                Completed {formatDate(completedAt)}
              </Badge>
            ) : data.assigned ? (
              <Badge variant="secondary">
                {readCount} of {total} read
              </Badge>
            ) : (
              <Badge variant="outline">Preview · not assigned to you</Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              render={<a href={trainingSourceUrl(training._id)} download />}
              nativeButton={false}
            >
              <Download />
              <span className="hidden sm:inline">Download</span>
            </Button>
          </div>
        </div>
        {data.assigned && !completedAt && (
          <Progress
            value={percent}
            className="mt-3"
            aria-label={`${readCount} of ${total} slides read`}
          />
        )}
      </header>

      {training.description && (
        <p className="mt-6 text-sm whitespace-pre-wrap text-foreground">
          {training.description}
        </p>
      )}
      {tracking && (
        <p className="mt-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Read every slide; each one is ticked as you scroll past it. When all
          slides are read, confirm at the bottom to complete the training.
        </p>
      )}

      {/* Slides */}
      <ol className="mt-6 space-y-6">
        {Array.from({ length: total }, (_, index) => {
          const slide = index + 1;
          const isRead = read.has(slide) || Boolean(completedAt);
          return (
            <li key={slide}>
              <figure
                ref={(element) => {
                  slideRefs.current[index] = element;
                }}
                data-slide={slide}
                className="overflow-hidden rounded-xl border bg-card shadow-xs"
              >
                <img
                  src={trainingSlideUrl(training._id, slide, training.version)}
                  alt={`Slide ${slide} of ${total}`}
                  loading={slide <= 2 ? "eager" : "lazy"}
                  className="block aspect-video w-full bg-muted object-contain"
                />
                <figcaption className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
                  <span>
                    Slide {slide} of {total}
                  </span>
                  {data.assigned && (
                    <span
                      className={`inline-flex items-center gap-1 ${isRead ? "text-primary" : ""}`}
                    >
                      {isRead ? (
                        <CheckCircle2 className="size-3.5" />
                      ) : (
                        <Circle className="size-3.5" />
                      )}
                      {isRead ? "Read" : "Not read yet"}
                    </span>
                  )}
                </figcaption>
              </figure>
            </li>
          );
        })}
      </ol>

      {/* Acknowledgement */}
      {data.assigned && (
        <section
          className="mt-8 rounded-xl border bg-card p-4 shadow-xs sm:p-6"
          aria-labelledby="ack-heading"
        >
          <h2
            id="ack-heading"
            className="flex items-center gap-2 text-lg font-medium"
          >
            <GraduationCap className="size-5 text-primary" />
            Complete the training
          </h2>
          {completedAt ? (
            <p className="mt-2 text-sm text-muted-foreground">
              You completed this training on {formatDate(completedAt)}. Thank
              you!
            </p>
          ) : (
            <>
              <label
                className={`mt-4 flex items-start gap-2.5 ${allRead ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
              >
                <Checkbox
                  checked={acknowledged}
                  disabled={!allRead}
                  onCheckedChange={(checked) =>
                    setAcknowledged(checked === true)
                  }
                  className="mt-0.5"
                />
                <span className="text-sm text-foreground">
                  I have read and understood all {total} slides of &ldquo;
                  {training.title}&rdquo;.
                </span>
              </label>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  disabled={!allRead || !acknowledged || complete.isPending}
                  onClick={() => complete.mutate()}
                >
                  {complete.isPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <CheckCircle2 />
                  )}
                  Complete training
                </Button>
                {!allRead && (
                  <span className="text-sm text-muted-foreground">
                    Read all slides to continue ({left} left).
                  </span>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
