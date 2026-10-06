import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { LuCircleAlert, LuLoaderCircle, LuPlus, LuSparkles, LuX } from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AssignableUser, GoalStatus, PerformanceReview } from "@/types";
import {
  DEFAULT_REVIEW_CATEGORIES,
  REVIEW_LIMITS,
  averageScore,
} from "./review-meta";
import { StarRatingInput } from "./star-rating";

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

interface RatingRow {
  key: string;
  category: string;
  /** 0 = not rated yet. */
  score: number;
  comment: string;
}

interface GoalRow {
  key: string;
  title: string;
  description: string;
  /** yyyy-MM-dd or "". */
  dueDate: string;
  status?: GoalStatus;
  completedAt?: string;
}

/** Normalized payload the form hands back (trimmed, empty optionals dropped). */
export interface ReviewFormValues {
  employeeId: string;
  period: string;
  ratings: { category: string; score: number; comment?: string }[];
  goals: {
    title: string;
    description?: string;
    dueDate?: string;
    status?: GoalStatus;
    completedAt?: string;
  }[];
  summary: string;
  strengths: string;
  improvements: string;
  aiDraft: boolean;
}

let rowSeq = 0;
const nextKey = () => `row-${++rowSeq}`;

function initialRatings(review?: PerformanceReview): RatingRow[] {
  if (review) {
    return review.ratings.map((r) => ({
      key: nextKey(),
      category: r.category,
      score: r.score,
      comment: r.comment ?? "",
    }));
  }
  return DEFAULT_REVIEW_CATEGORIES.map((category) => ({
    key: nextKey(),
    category,
    score: 0,
    comment: "",
  }));
}

function initialGoals(review?: PerformanceReview): GoalRow[] {
  return (review?.goals ?? []).map((g) => ({
    key: nextKey(),
    title: g.title,
    description: g.description ?? "",
    dueDate: g.dueDate ? g.dueDate.slice(0, 10) : "",
    status: g.status,
    completedAt: g.completedAt,
  }));
}

/** Converts a saved review into the same normalized shape for change detection. */
export function reviewToFormValues(review: PerformanceReview): ReviewFormValues {
  return normalize({
    employeeId: review.employee._id,
    period: review.period,
    ratings: initialRatings(review),
    goals: initialGoals(review),
    summary: review.summary ?? "",
    strengths: review.strengths ?? "",
    improvements: review.improvements ?? "",
    aiDraft: false,
  });
}

function normalize(input: {
  employeeId: string;
  period: string;
  ratings: RatingRow[];
  goals: GoalRow[];
  summary: string;
  strengths: string;
  improvements: string;
  aiDraft: boolean;
}): ReviewFormValues {
  return {
    employeeId: input.employeeId,
    period: input.period.trim(),
    ratings: input.ratings.map((r) => ({
      category: r.category.trim(),
      score: r.score,
      ...(r.comment.trim() ? { comment: r.comment.trim() } : {}),
    })),
    goals: input.goals.map((g) => ({
      title: g.title.trim(),
      ...(g.description.trim() ? { description: g.description.trim() } : {}),
      ...(g.dueDate ? { dueDate: g.dueDate } : {}),
      ...(g.status ? { status: g.status } : {}),
      ...(g.completedAt ? { completedAt: g.completedAt } : {}),
    })),
    summary: input.summary.trim(),
    strengths: input.strengths.trim(),
    improvements: input.improvements.trim(),
    aiDraft: input.aiDraft,
  };
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-destructive">
      {children}
    </p>
  );
}

function FormSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <legend className="text-sm font-medium text-foreground">{title}</legend>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </fieldset>
  );
}

function CountedTextarea({
  id,
  label,
  value,
  onChange,
  placeholder,
  max,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  max: number;
  disabled?: boolean;
}) {
  const countId = `${id}-count`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <span
          id={countId}
          className={cn(
            "text-xs tabular-nums text-muted-foreground",
            value.length >= max && "text-destructive"
          )}
        >
          {value.length.toLocaleString()}/{max.toLocaleString()}
        </span>
      </div>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={max}
        rows={3}
        aria-describedby={countId}
        disabled={disabled}
        className="max-h-60"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

/**
 * Shared create/edit form for a performance review: employee + period
 * (create only), category star ratings with live average, written feedback
 * and goals. Validates locally and hands back normalized values.
 */
export function ReviewForm({
  mode,
  review,
  employees,
  employeesLoading,
  employeesError,
  aiDraftsEnabled = false,
  pending,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  /** Required in edit mode. */
  review?: PerformanceReview;
  employees?: AssignableUser[];
  employeesLoading?: boolean;
  employeesError?: boolean;
  /** Server says AI drafting is on — shows the opt-in checkbox (create only). */
  aiDraftsEnabled?: boolean;
  pending: boolean;
  error?: ReactNode;
  submitLabel?: string;
  onSubmit: (values: ReviewFormValues) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;

  const [employeeId, setEmployeeId] = useState(review?.employee._id ?? "");
  const [period, setPeriod] = useState(review?.period ?? "");
  const [ratings, setRatings] = useState<RatingRow[]>(() => initialRatings(review));
  const [goals, setGoals] = useState<GoalRow[]>(() => initialGoals(review));
  const [summary, setSummary] = useState(review?.summary ?? "");
  const [strengths, setStrengths] = useState(review?.strengths ?? "");
  const [improvements, setImprovements] = useState(review?.improvements ?? "");
  const [aiDraft, setAiDraft] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const overall = averageScore(ratings.filter((r) => r.score > 0).map((r) => r.score));

  // ---- validation -------------------------------------------------------
  const errors = useMemo(() => {
    const e: {
      employee?: string;
      period?: string;
      ratings?: string;
      rating: Record<string, { category?: string; score?: string }>;
      goal: Record<string, string>;
    } = { rating: {}, goal: {} };
    if (mode === "create" && !employeeId) e.employee = "Select an employee.";
    if (mode === "create" && !period.trim()) e.period = "Enter a review period.";
    if (ratings.length === 0) e.ratings = "Add at least one rating category.";
    const seen = new Set<string>();
    for (const r of ratings) {
      const name = r.category.trim();
      const rowErr: { category?: string; score?: string } = {};
      if (!name) rowErr.category = "Name this category.";
      else if (seen.has(name.toLowerCase())) rowErr.category = "This category is listed twice.";
      seen.add(name.toLowerCase());
      if (r.score < 1) rowErr.score = "Pick a score, or remove this category.";
      if (rowErr.category || rowErr.score) e.rating[r.key] = rowErr;
    }
    for (const g of goals) {
      if (!g.title.trim()) e.goal[g.key] = "Give this goal a title, or remove it.";
    }
    return e;
  }, [mode, employeeId, period, ratings, goals]);

  const errorCount =
    (errors.employee ? 1 : 0) +
    (errors.period ? 1 : 0) +
    (errors.ratings ? 1 : 0) +
    Object.keys(errors.rating).length +
    Object.keys(errors.goal).length;
  const show = submitted;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (errorCount > 0) {
      // Move focus to the first invalid control.
      requestAnimationFrame(() => {
        const first = document.querySelector<HTMLElement>(
          `[data-review-form="${uid}"] [aria-invalid="true"]`
        );
        first?.focus();
      });
      return;
    }
    onSubmit(
      normalize({ employeeId, period, ratings, goals, summary, strengths, improvements, aiDraft })
    );
  }

  // ---- row helpers ------------------------------------------------------
  const updateRating = (key: string, patch: Partial<RatingRow>) =>
    setRatings((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const updateGoal = (key: string, patch: Partial<GoalRow>) =>
    setGoals((rows) => rows.map((g) => (g.key === key ? { ...g, ...patch } : g)));

  const employeeItems: Record<string, string> = {};
  for (const emp of employees ?? []) employeeItems[emp._id] = `${emp.name} (${emp.email})`;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="space-y-5"
      data-review-form={uid}
      aria-busy={pending || undefined}
    >
      {/* ---- Who & when ---------------------------------------------- */}
      {mode === "create" ? (
        <FormSection title="Employee & period">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={fid("employee")}>Employee</Label>
              <Select
                value={employeeId || null}
                onValueChange={(value) => setEmployeeId(value ? String(value) : "")}
                disabled={employeesLoading || pending}
                items={employeeItems}
              >
                <SelectTrigger
                  id={fid("employee")}
                  className="w-full"
                  aria-invalid={show && !!errors.employee}
                  aria-describedby={show && errors.employee ? fid("employee-err") : undefined}
                >
                  <SelectValue
                    placeholder={employeesLoading ? "Loading employees…" : "Select an employee"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {(employees ?? []).map((emp) => (
                    <SelectItem key={emp._id} value={emp._id}>
                      {emp.name} ({emp.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {employeesError ? (
                <FieldError id={fid("employee-load")}>
                  Couldn&apos;t load employees. Close and try again.
                </FieldError>
              ) : !employeesLoading && employees && employees.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  There&apos;s nobody you can review yet.
                </p>
              ) : null}
              {show && errors.employee && (
                <FieldError id={fid("employee-err")}>{errors.employee}</FieldError>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={fid("period")}>Review period</Label>
              <Input
                id={fid("period")}
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                placeholder="e.g. Q3 2026"
                maxLength={REVIEW_LIMITS.period}
                aria-invalid={show && !!errors.period}
                aria-describedby={show && errors.period ? fid("period-err") : undefined}
                disabled={pending}
              />
              {show && errors.period && (
                <FieldError id={fid("period-err")}>{errors.period}</FieldError>
              )}
            </div>
          </div>
        </FormSection>
      ) : null}

      {/* ---- Ratings -------------------------------------------------- */}
      <FormSection
        title="Category ratings"
        description="Score each area from 1 to 5. The overall score is their average."
        action={
          <div
            className="flex items-center gap-2 rounded-md bg-primary/10 px-2.5 py-1 text-sm"
            aria-live="polite"
          >
            <span className="text-muted-foreground">Overall</span>
            <span className="font-semibold tabular-nums text-primary">
              {overall !== undefined ? `${overall.toFixed(1)}/5` : "—"}
            </span>
          </div>
        }
      >
        <ul className="space-y-3">
          {ratings.map((row, index) => {
            const rowErr = show ? errors.rating[row.key] : undefined;
            const name = row.category.trim() || `Category ${index + 1}`;
            return (
              <li key={row.key} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <Label htmlFor={fid(`cat-${row.key}`)} className="sr-only">
                      Category name
                    </Label>
                    <Input
                      id={fid(`cat-${row.key}`)}
                      value={row.category}
                      onChange={(e) => updateRating(row.key, { category: e.target.value })}
                      placeholder="Category name"
                      maxLength={REVIEW_LIMITS.category}
                      aria-invalid={!!rowErr?.category}
                      aria-describedby={rowErr?.category ? fid(`cat-err-${row.key}`) : undefined}
                      disabled={pending}
                      className="font-medium"
                    />
                    {rowErr?.category && (
                      <FieldError id={fid(`cat-err-${row.key}`)}>{rowErr.category}</FieldError>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setRatings((rows) => rows.filter((r) => r.key !== row.key))}
                    aria-label={`Remove ${name}`}
                    disabled={pending}
                  >
                    <LuX />
                  </Button>
                </div>
                <StarRatingInput
                  value={row.score}
                  onChange={(score) => updateRating(row.key, { score })}
                  label={`${name} score`}
                  invalid={!!rowErr?.score}
                  describedBy={rowErr?.score ? fid(`score-err-${row.key}`) : undefined}
                  disabled={pending}
                />
                {rowErr?.score && (
                  <FieldError id={fid(`score-err-${row.key}`)}>{rowErr.score}</FieldError>
                )}
                <Label htmlFor={fid(`comment-${row.key}`)} className="sr-only">
                  {name} comment
                </Label>
                <Input
                  id={fid(`comment-${row.key}`)}
                  value={row.comment}
                  onChange={(e) => updateRating(row.key, { comment: e.target.value })}
                  placeholder="Optional comment"
                  maxLength={REVIEW_LIMITS.ratingComment}
                  disabled={pending}
                />
              </li>
            );
          })}
        </ul>
        {show && errors.ratings && <FieldError id={fid("ratings-err")}>{errors.ratings}</FieldError>}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setRatings((rows) => [...rows, { key: nextKey(), category: "", score: 0, comment: "" }])
          }
          disabled={pending || ratings.length >= REVIEW_LIMITS.ratings}
        >
          <LuPlus />
          Add category
        </Button>
        {ratings.length >= REVIEW_LIMITS.ratings && (
          <p className="text-xs text-muted-foreground">
            A review can have up to {REVIEW_LIMITS.ratings} categories.
          </p>
        )}
      </FormSection>

      {/* ---- Written feedback ---------------------------------------- */}
      <FormSection
        title="Written feedback"
        description={
          aiDraft
            ? "Optional — anything you leave blank will be drafted by AI for you to review."
            : "Optional, but most reviews include a short summary."
        }
      >
        <CountedTextarea
          id={fid("summary")}
          label="Summary"
          value={summary}
          onChange={setSummary}
          placeholder="Overall view of the employee's performance this period"
          max={REVIEW_LIMITS.text}
          disabled={pending}
        />
        <CountedTextarea
          id={fid("strengths")}
          label="Strengths"
          value={strengths}
          onChange={setStrengths}
          placeholder="What went well"
          max={REVIEW_LIMITS.text}
          disabled={pending}
        />
        <CountedTextarea
          id={fid("improvements")}
          label="Areas for improvement"
          value={improvements}
          onChange={setImprovements}
          placeholder="Where they can grow, with specifics"
          max={REVIEW_LIMITS.text}
          disabled={pending}
        />
      </FormSection>

      {/* ---- Goals ----------------------------------------------------- */}
      <FormSection title="Goals" description="Optional goals for the next period.">
        {goals.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
            No goals yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {goals.map((goal, index) => {
              const goalErr = show ? errors.goal[goal.key] : undefined;
              const name = goal.title.trim() || `Goal ${index + 1}`;
              return (
                <li key={goal.key} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <Label htmlFor={fid(`goal-${goal.key}`)}>Goal {index + 1}</Label>
                      <Input
                        id={fid(`goal-${goal.key}`)}
                        value={goal.title}
                        onChange={(e) => updateGoal(goal.key, { title: e.target.value })}
                        placeholder="Goal title"
                        maxLength={REVIEW_LIMITS.goalTitle}
                        aria-invalid={!!goalErr}
                        aria-describedby={goalErr ? fid(`goal-err-${goal.key}`) : undefined}
                        disabled={pending}
                      />
                      {goalErr && <FieldError id={fid(`goal-err-${goal.key}`)}>{goalErr}</FieldError>}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mt-6"
                      onClick={() => setGoals((rows) => rows.filter((g) => g.key !== goal.key))}
                      aria-label={`Remove ${name}`}
                      disabled={pending}
                    >
                      <LuX />
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_11rem]">
                    <div className="space-y-1">
                      <Label htmlFor={fid(`goal-desc-${goal.key}`)} className="sr-only">
                        {name} description
                      </Label>
                      <Textarea
                        id={fid(`goal-desc-${goal.key}`)}
                        value={goal.description}
                        onChange={(e) => updateGoal(goal.key, { description: e.target.value })}
                        placeholder="Description (optional)"
                        maxLength={REVIEW_LIMITS.goalDescription}
                        rows={2}
                        disabled={pending}
                        className="min-h-9"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={fid(`goal-due-${goal.key}`)} className="text-xs text-muted-foreground">
                        Due date
                      </Label>
                      <Input
                        id={fid(`goal-due-${goal.key}`)}
                        type="date"
                        value={goal.dueDate}
                        onChange={(e) => updateGoal(goal.key, { dueDate: e.target.value })}
                        disabled={pending}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setGoals((rows) => [...rows, { key: nextKey(), title: "", description: "", dueDate: "" }])
          }
          disabled={pending || goals.length >= REVIEW_LIMITS.goals}
        >
          <LuPlus />
          Add goal
        </Button>
      </FormSection>

      {/* ---- Optional AI draft (server-enabled only) ------------------ */}
      {mode === "create" && aiDraftsEnabled && (
        <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
          <Checkbox
            id={fid("ai")}
            checked={aiDraft}
            onCheckedChange={(checked) => setAiDraft(checked === true)}
            disabled={pending}
            aria-labelledby={fid("ai-label")}
            aria-describedby={fid("ai-desc")}
            className="mt-0.5"
          />
          <div className="space-y-0.5">
            <Label id={fid("ai-label")} htmlFor={fid("ai")} className="flex items-center gap-1.5">
              <LuSparkles aria-hidden className="size-3.5 text-primary" />
              Draft written feedback with AI
            </Label>
            <p id={fid("ai-desc")} className="text-xs text-muted-foreground">
              Sends the employee&apos;s name, department, period, ratings and past review
              summaries to Google Gemini. The draft stays editable and isn&apos;t shared
              with the employee until you send it.
            </p>
          </div>
        </div>
      )}

      {show && errorCount > 0 && (
        <p role="alert" className="text-sm text-destructive">
          {errorCount === 1 ? "1 thing needs" : `${errorCount} things need`} your attention above.
        </p>
      )}

      {error && (
        <Alert variant="destructive">
          <LuCircleAlert aria-hidden className="size-4" />
          <AlertTitle>{mode === "create" ? "Couldn't create review" : "Couldn't save changes"}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <LuLoaderCircle aria-hidden className="animate-spin" />}
          {pending
            ? "Saving…"
            : submitLabel ??
            (mode === "create"
              ? aiDraft
                ? "Create & draft with AI"
                : "Create review"
              : "Save changes")}
        </Button>
      </div>
    </form>
  );
}
