import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Eye,
  Lightbulb,
  LoaderCircle,
  MessageSquare,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
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
import { useFeedback, useUpdateFeedback } from "@/hooks/use-feedback";
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

const CATEGORY_FILTERS: { value: FeedbackCategory | "all"; label: string }[] = [
  { value: "all", label: "All categories" },
  ...FEEDBACK_CATEGORIES.map((category) => ({
    value: category,
    label: FEEDBACK_CATEGORY_LABELS[category],
  })),
];

const CATEGORY_ICONS: Record<FeedbackCategory, LucideIcon> = {
  suggestion: Lightbulb,
  complaint: AlertTriangle,
  praise: ThumbsUp,
  other: MessageSquare,
};


/**
 * Admin feedback management: review every submission (anonymous ones shown
 * without an identity), respond to them, and mark them resolved or reopen.
 */
export function ManageFeedbackView({ embedded = false }: { embedded?: boolean }) {
  const [status, setStatus] = useState<FeedbackStatusFilter>("all");
  const [category, setCategory] = useState<FeedbackCategory | "all">("all");
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
  } = useFeedback({
    status,
    category,
    search: search || undefined,
    limit: PAGE_SIZE,
    offset,
  });
  const feedback = data?.feedback;
  const [responding, setResponding] = useState<Feedback | null>(null);

  useEffect(() => {
    setTotal(data?.total ?? 0);
  }, [data?.total, setTotal]);

  return (
    <div className={embedded ? undefined : "mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8"}>
      {!embedded && (
      <header>
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          Feedback
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review employee feedback, respond, and mark submissions resolved.
        </p>
      </header>
      )}

      <div className={embedded ? "mt-4 space-y-4" : "mt-8 space-y-4"}>
        <div className="flex flex-wrap items-center gap-3">
          <DataTableSearch
            value={search}
            onValueChange={setSearch}
            placeholder="Search by message or employee name…"
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
          <div className="w-44">
            <Select
              value={category}
              onValueChange={(value) => setCategory(value as FeedbackCategory | "all")}
            >
              <SelectTrigger id="feedback-category-filter" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_FILTERS.map((filter) => (
                  <SelectItem key={filter.value} value={filter.value}>
                    {filter.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {isPending ? (
          <FeedbackListSkeleton />
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t load feedback</AlertTitle>
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
                        <TableHead>Submitted by</TableHead>
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
                            <TableCell>
                              {item.author ? (
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium">
                                    {item.author.name}
                                  </p>
                                  <p className="truncate text-xs text-muted-foreground">
                                    {item.author.email}
                                  </p>
                                </div>
                              ) : (
                                <p className="text-sm italic text-muted-foreground">
                                  Anonymous
                                </p>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                              <span className="inline-flex items-center gap-1.5">
                                <CategoryIcon className="size-3.5" />
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
                                  onClick={() => setResponding(item)}
                                  aria-label={`Review ${item.author ? item.author.name + "'s" : "anonymous"} feedback`}
                                >
                                  <Eye />
                                  Review
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
                Nothing matches &ldquo;{search}&rdquo;. Try a different message or employee
                name.
              </EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={() => setSearch("")}>
              Clear search
            </Button>
          </Empty>
        ) : (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareText />
              </EmptyMedia>
              <EmptyTitle>
                No {status === "all" ? "" : `${status} `}
                {category === "all" ? "" : `${category} `}feedback
              </EmptyTitle>
              <EmptyDescription>
                {status === "all" && category === "all"
                  ? "Employee feedback submissions will show up here."
                  : "No submissions match these filters."}
              </EmptyDescription>
            </EmptyHeader>
            {(status !== "all" || category !== "all") && (
              <Button
                variant="outline"
                onClick={() => {
                  setStatus("all");
                  setCategory("all");
                }}
              >
                Clear filters
              </Button>
            )}
          </Empty>
        )}
      </div>

      <RespondDialog
        feedback={responding}
        onOpenChange={(open) => {
          if (!open) setResponding(null);
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
            <Skeleton className="h-4 w-32" />
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
/* Respond dialog                                                      */
/* ------------------------------------------------------------------ */

function RespondDialog({
  feedback,
  onOpenChange,
}: {
  feedback: Feedback | null;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateFeedback();
  const open = feedback !== null;
  const isResolved = feedback?.status === "resolved";

  const [response, setResponse] = useState("");

  useEffect(() => {
    if (open) {
      setResponse(feedback?.response?.body ?? "");
    }
  }, [open, feedback]);

  function handleRespond(event: FormEvent) {
    event.preventDefault();
    if (!feedback || response.trim() === "") return;
    // Respond and resolve in one call when the admin also flips the status.
    update.mutate(
      { id: feedback._id, input: { response: response.trim() } },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  function handleToggleStatus() {
    if (!feedback) return;
    const nextStatus = feedback.status === "resolved" ? "open" : "resolved";
    update.mutate(
      {
        id: feedback._id,
        input: {
          ...(response.trim() !== "" ? { response: response.trim() } : {}),
          status: nextStatus,
        },
      },
      { onSuccess: () => onOpenChange(false) }
    );
  }

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
                {feedback.author ? feedback.author.name : "Anonymous"} ·{" "}
                {formatDate(feedback.createdAt)}
              </span>
            )}
          </div>
          <DialogTitle>Review feedback</DialogTitle>
          <DialogDescription>
            {feedback?.isAnonymous
              ? "This submission was sent anonymously — the submitter's identity is hidden."
              : "Respond to this submission; the employee will see your reply."}
          </DialogDescription>
        </DialogHeader>

        <div className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed text-foreground">
          {feedback?.message}
        </div>

        <form onSubmit={handleRespond} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="feedback-response">
              Response <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="feedback-response"
              value={response}
              onChange={(event) => setResponse(event.target.value)}
              placeholder={
                isResolved
                  ? "Update the response shown to the employee…"
                  : "Acknowledge the feedback or share how it will be handled…"
              }
              rows={4}
            />
          </div>

          {update.isError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Couldn&apos;t update feedback</AlertTitle>
              <AlertDescription>{getErrorMessage(update.error)}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={update.isPending}
            >
              Close
            </Button>
            {isResolved ? (
              <Button
                type="button"
                variant="outline"
                onClick={handleToggleStatus}
                disabled={update.isPending}
              >
                {update.isPending ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
                Reopen
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={handleToggleStatus}
                disabled={update.isPending}
              >
                {update.isPending ? <LoaderCircle className="animate-spin" /> : <CheckCircle2 />}
                Mark resolved
              </Button>
            )}
            <Button type="submit" disabled={update.isPending || response.trim() === ""}>
              {update.isPending ? <LoaderCircle className="animate-spin" /> : <Send />}
              {update.isPending ? "Saving…" : "Save response"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
