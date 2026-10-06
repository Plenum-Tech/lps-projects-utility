import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Eye,
  Lightbulb,
  LoaderCircle,
  MessageSquare,
  MessageSquareText,
  RefreshCw,
  Send,
  ThumbsUp,
  type LucideIcon,
} from "lucide-react";

import { formatDate } from "@/lib/format";
import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { DataTableSearch } from "@/components/globals/data-table-search";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useCreateFeedback, useMyFeedback } from "@/hooks/use-feedback";
import { usePagination } from "@/hooks/use-pagination";
import { getErrorMessage } from "@/lib/api";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_STATUS_META,
} from "@/lib/feedback";
import type { Feedback, FeedbackCategory, FeedbackStatusFilter } from "@/types";


const PAGE_SIZE = 10;

const STATUS_FILTERS: { value: FeedbackStatusFilter; label: string }[] = [
  { value: "all", label: "All feedback" },
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
];

const CATEGORY_ICONS: Record<FeedbackCategory, LucideIcon> = {
  suggestion: Lightbulb,
  complaint: AlertTriangle,
  praise: ThumbsUp,
  other: MessageSquare,
};


/**
 * Employee feedback: submit feedback (attributed or anonymous, with a
 * category) and track the status of your submissions plus admin responses.
 */
export function MyFeedbackView({ embedded = false }: { embedded?: boolean }) {
  const [status, setStatus] = useState<FeedbackStatusFilter>("all");
  const [search, setSearch] = useState("");
  const { page, setPage, offset, total, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: search,
  });
  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useMyFeedback({ status, search: search || undefined, limit: PAGE_SIZE, offset });
  const feedback = data?.feedback;
  const [submitOpen, setSubmitOpen] = useState(false);
  const [reading, setReading] = useState<Feedback | null>(null);

  useEffect(() => {
    setTotal(data?.total ?? 0);
  }, [data?.total, setTotal]);

  return (
    <div className={embedded ? undefined : "mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8"}>
      <header className={embedded ? "flex flex-wrap items-end justify-end gap-4" : "flex flex-wrap items-end justify-between gap-4"}>
        {!embedded && (
          <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
            Feedback
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Share suggestions, praise, or concerns — anonymously if you prefer — and
            track how they&apos;re handled.
          </p>
          </div>
        )}
        <Button onClick={() => setSubmitOpen(true)}>
          <Send />
          Submit feedback
        </Button>
      </header>

      <div className={embedded ? "mt-4 space-y-4" : "mt-8 space-y-4"}>
        {(total > 0 || search !== "") && (
          <div className="flex flex-wrap items-center gap-3">
            <DataTableSearch
              value={search}
              onValueChange={setSearch}
              placeholder="Search your feedback…"
              className="flex-1"
            />
            <div className="w-44">
              <Select
                value={status}
                onValueChange={(value) => setStatus(value as FeedbackStatusFilter)}
              >
                <SelectTrigger id="feedback-status-filter" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTERS.map((filter) => (
                    <SelectItem key={filter.value} value={filter.value}>
                      {filter.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {isPending ? (
          <FeedbackListSkeleton />
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t load your feedback</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(error)}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isRefetching}
              >
                {isRefetching ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : total > 0 ? (
          <>
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Message</TableHead>
                        <TableHead>Submitted</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {feedback?.map((item) => {
                        const CategoryIcon = CATEGORY_ICONS[item.category];
                        return (
                          <TableRow key={item._id}>
                            <TableCell className="whitespace-nowrap text-sm font-medium">
                              <span className="inline-flex items-center gap-1.5">
                                <CategoryIcon className="size-3.5 text-muted-foreground" />
                                {FEEDBACK_CATEGORY_LABELS[item.category]}
                              </span>
                            </TableCell>
                            <TableCell>
                              <Badge variant={FEEDBACK_STATUS_META[item.status].variant}>
                                {FEEDBACK_STATUS_META[item.status].label}
                              </Badge>
                            </TableCell>
                            <TableCell className="max-w-xs">
                              <p className="truncate text-sm text-muted-foreground">
                                {item.message}
                              </p>
                              {item.response && (
                                <p className="truncate text-xs text-muted-foreground">
                                  Response: {item.response.body}
                                </p>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                              {formatDate(item.createdAt)}
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setReading(item)}
                                  aria-label="View feedback details"
                                >
                                  <Eye />
                                  View
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
            <DataTablePagination
              page={page}
              limit={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          </>
        ) : search !== "" ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareText />
              </EmptyMedia>
              <EmptyTitle>No matching feedback</EmptyTitle>
              <EmptyDescription>
                Nothing matches &ldquo;{search}&rdquo;. Try a different keyword.
              </EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={() => setSearch("")}>
              Clear search
            </Button>
          </Empty>
        ) : status !== "all" ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareText />
              </EmptyMedia>
              <EmptyTitle>No {status} feedback</EmptyTitle>
              <EmptyDescription>
                You don&apos;t have any {status} submissions right now.
              </EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={() => setStatus("all")}>
              Show all feedback
            </Button>
          </Empty>
        ) : (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareText />
              </EmptyMedia>
              <EmptyTitle>No feedback yet</EmptyTitle>
              <EmptyDescription>
                Share your first piece of feedback — suggestions, praise, or concerns are
                all welcome.
              </EmptyDescription>
            </EmptyHeader>
            <Button onClick={() => setSubmitOpen(true)}>
              <Send />
              Submit feedback
            </Button>
          </Empty>
        )}
      </div>

      <SubmitFeedbackDialog
        open={submitOpen}
        onOpenChange={(open) => {
          if (!open) setSubmitOpen(false);
        }}
      />
      <FeedbackDetailDialog
        feedback={reading}
        onOpenChange={(open) => {
          if (!open) setReading(null);
        }}
      />
    </div>
  );
}

function FeedbackListSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading feedback">
      <CardContent className="space-y-4 p-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Submit feedback dialog                                              */
/* ------------------------------------------------------------------ */

function SubmitFeedbackDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateFeedback();

  const [category, setCategory] = useState<FeedbackCategory>("suggestion");
  const [message, setMessage] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setCategory("suggestion");
      setMessage("");
      setIsAnonymous(false);
      setSubmitted(false);
    }
  }, [open]);

  const messageInvalid = submitted && message.trim() === "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!message.trim()) return;

    create.mutate(
      { message: message.trim(), category, isAnonymous },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit feedback</DialogTitle>
          <DialogDescription>
            Tell us what&apos;s on your mind. Your feedback goes to the admins, who can
            respond and mark it resolved.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="feedback-category">Category</Label>
            <Select
              value={category}
              onValueChange={(value) => setCategory(value as FeedbackCategory)}
            >
              <SelectTrigger id="feedback-category" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEEDBACK_CATEGORIES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {FEEDBACK_CATEGORY_LABELS[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="feedback-message">Your feedback</Label>
            <Textarea
              id="feedback-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Share your suggestion, praise, or concern…"
              rows={5}
              maxLength={2000}
              aria-invalid={messageInvalid}
              aria-describedby={messageInvalid ? "feedback-message-error" : undefined}
            />
            {messageInvalid && (
              <p id="feedback-message-error" className="text-xs text-destructive">
                A message is required.
              </p>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={isAnonymous}
              onCheckedChange={(checked) => setIsAnonymous(checked === true)}
              className="mt-0.5"
            />
            <span className="grid gap-0.5 leading-tight">
              <span className="text-sm font-medium text-foreground">
                Submit anonymously
              </span>
              <span className="text-xs text-muted-foreground">
                Admins won&apos;t see your name — you&apos;ll still be able to track this
                submission&apos;s status and responses.
              </span>
            </span>
          </label>

          {create.isError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Couldn&apos;t submit feedback</AlertTitle>
              <AlertDescription>{getErrorMessage(create.error)}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? <LoaderCircle className="animate-spin" /> : <Send />}
              {create.isPending ? "Submitting…" : "Submit feedback"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Detail dialog                                                       */
/* ------------------------------------------------------------------ */

function FeedbackDetailDialog({
  feedback,
  onOpenChange,
}: {
  feedback: Feedback | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = feedback !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="secondary"
              className="capitalize"
            >
              <MessageSquare data-icon="inline-start" />
              {feedback ? FEEDBACK_CATEGORY_LABELS[feedback.category] : ""}
            </Badge>
            <Badge variant={feedback ? FEEDBACK_STATUS_META[feedback.status].variant : "secondary"}>
              {feedback ? FEEDBACK_STATUS_META[feedback.status].label : ""}
            </Badge>
            {feedback && (
              <span className="text-xs text-muted-foreground">
                Submitted {formatDate(feedback.createdAt)}
                {feedback.isAnonymous ? " · anonymously" : ""}
              </span>
            )}
          </div>
          <DialogTitle>Feedback details</DialogTitle>
        </DialogHeader>

        <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {feedback?.message}
        </div>

        {feedback?.response ? (
          <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Admin response
            </p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {feedback.response.body}
            </p>
            <p className="text-xs text-muted-foreground">
              {feedback.response.respondedBy?.name ?? "Admin"} ·{" "}
              {formatDate(feedback.response.respondedAt)}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No response yet — an admin will get back to you.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
