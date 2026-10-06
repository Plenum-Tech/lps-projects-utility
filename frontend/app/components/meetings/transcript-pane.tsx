import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  LuChevronDown,
  LuChevronUp,
  LuClipboardCheck,
  LuLightbulb,
  LuPlus,
  LuSearch,
  LuX,
} from "react-icons/lu";

import { VirtualList, type VirtualListHandle } from "@/components/meetings/virtual-list";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  NEUTRAL_TONE,
  formatTimestamp,
  selectionTitle,
  speakerTones,
  taskRefLabel,
  type SpeakerTone,
} from "@/lib/meetings";
import { initials } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { ActionItemTaskRef, TranscriptSegment } from "@/types";

const MAX_SELECTION = 50;

export interface TranscriptJump {
  idx: number;
  /** Changes on every request so the same line can be flashed twice. */
  nonce: number;
}

interface Match {
  /** Position in `segments`. */
  row: number;
  /** Occurrence within that segment's text. */
  occurrence: number;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Left pane of the meeting workspace: searchable, windowed transcript with
 * speaker colours, smart-hint highlights, task link chips, multi-select
 * checkboxes and a floating "+ Action item" button for text selections.
 */
export function TranscriptPane({
  segments,
  hintIdxs,
  tasksBySeg,
  jump,
  selectable,
  actionLabel,
  onAction,
  className,
}: {
  segments: TranscriptSegment[];
  hintIdxs: Set<number>;
  tasksBySeg: Map<number, ActionItemTaskRef[]>;
  /** Scroll to + flash this segment. */
  jump: TranscriptJump | null;
  /** Show checkboxes / the selection button. */
  selectable: boolean;
  /** "Action item" (editors) or "Task" (viewers who can only create tasks). */
  actionLabel: string;
  onAction: (segmentIdxs: number[], title?: string) => void;
  className?: string;
}) {
  const listRef = useRef<VirtualListHandle>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const tones = useMemo(() => speakerTones(segments.map((segment) => segment.speaker)), [segments]);
  const rowOf = useMemo(() => {
    const map = new Map<number, number>();
    segments.forEach((segment, row) => map.set(segment.idx, row));
    return map;
  }, [segments]);

  /* ---------------- search ---------------- */
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 200);
  const matches = useMemo<Match[]>(() => {
    if (debounced.length < 2) return [];
    const pattern = new RegExp(escapeRegExp(debounced), "gi");
    const out: Match[] = [];
    segments.forEach((segment, row) => {
      const found = segment.text.match(pattern);
      found?.forEach((_, occurrence) => out.push({ row, occurrence }));
    });
    return out;
  }, [debounced, segments]);
  const [current, setCurrent] = useState(0);
  useEffect(() => setCurrent(0), [matches]);
  const active = matches[current] ?? null;

  useEffect(() => {
    if (active) listRef.current?.scrollToIndex(active.row);
  }, [active]);

  function step(delta: number) {
    if (matches.length === 0) return;
    setCurrent((value) => (value + delta + matches.length) % matches.length);
  }

  /* ---------------- jump + flash ---------------- */
  const [flash, setFlash] = useState<number | null>(null);
  useEffect(() => {
    if (!jump) return;
    const row = rowOf.get(jump.idx);
    if (row === undefined) return;
    listRef.current?.scrollToIndex(row);
    setFlash(jump.idx);
    const timer = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(timer);
  }, [jump, rowOf]);

  /* ---------------- checkbox selection ---------------- */
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const toggle = useCallback((idx: number, on: boolean) => {
    setChecked((currentSet) => {
      const next = new Set(currentSet);
      if (on) next.add(idx);
      else next.delete(idx);
      return next;
    });
  }, []);
  const checkedList = useMemo(() => [...checked].sort((a, b) => a - b), [checked]);
  const tooMany = checkedList.length > MAX_SELECTION;

  /* ---------------- text selection → floating button ---------------- */
  const [floating, setFloating] = useState<{
    top: number;
    left: number;
    idxs: number[];
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!selectable) return;
    let frame = 0;
    function read() {
      const selection = window.getSelection();
      const scroller = listRef.current?.element;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !scroller) {
        setFloating(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!scroller.contains(range.commonAncestorContainer)) {
        setFloating(null);
        return;
      }
      const text = selection.toString();
      if (!text.trim()) {
        setFloating(null);
        return;
      }
      const segOf = (node: Node | null) => {
        const element = node instanceof Element ? node : node?.parentElement;
        const holder = element?.closest<HTMLElement>("[data-seg]");
        return holder ? Number(holder.dataset.seg) : null;
      };
      const first = segOf(range.startContainer);
      const last = segOf(range.endContainer);
      const known = [first, last].filter((value): value is number => value !== null);
      if (known.length === 0) {
        setFloating(null);
        return;
      }
      const lo = Math.min(...known);
      const hi = Math.max(...known);
      const idxs = segments
        .filter((segment) => segment.idx >= lo && segment.idx <= hi)
        .map((segment) => segment.idx)
        .slice(0, MAX_SELECTION);
      const rect = range.getBoundingClientRect();
      const paneRect = paneRef.current?.getBoundingClientRect();
      if (!paneRect) return;
      setFloating({
        top: Math.max(rect.top - paneRect.top - 40, 52),
        left: Math.min(Math.max(rect.left - paneRect.left + rect.width / 2 - 64, 8), paneRect.width - 140),
        idxs,
        text: idxs.length === 1 ? selectionTitle(text) : "",
      });
    }
    function onChange() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    }
    document.addEventListener("selectionchange", onChange);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [selectable, segments]);

  function runAction(idxs: number[], title?: string) {
    onAction(idxs, title || undefined);
    setChecked(new Set());
    setFloating(null);
    window.getSelection()?.removeAllRanges();
  }

  const searchLabel =
    debounced.length < 2
      ? null
      : matches.length === 0
        ? "No matches"
        : `${current + 1} of ${matches.length}`;

  const renderItem = useCallback(
    (row: number) => {
      const segment = segments[row];
      return (
        <SegmentRow
          segment={segment}
          tone={segment.speaker ? (tones.get(segment.speaker) ?? NEUTRAL_TONE) : NEUTRAL_TONE}
          hint={hintIdxs.has(segment.idx)}
          tasks={tasksBySeg.get(segment.idx)}
          flash={flash === segment.idx}
          selectable={selectable}
          checked={checked.has(segment.idx)}
          onCheck={toggle}
          query={debounced.length >= 2 ? debounced : ""}
          activeOccurrence={active && active.row === row ? active.occurrence : -1}
        />
      );
    },
    [segments, tones, hintIdxs, tasksBySeg, flash, selectable, checked, toggle, debounced, active]
  );
  const getKey = useCallback((row: number) => segments[row].idx, [segments]);

  return (
    <div ref={paneRef} className={cn("relative flex min-h-0 flex-col", className)}>
      {/* Search */}
      <div className="flex items-center gap-2 border-b p-2.5">
        <div className="relative min-w-0 flex-1">
          <LuSearch
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              }
              if (event.key === "Escape") setQuery("");
            }}
            placeholder="Search the transcript…"
            aria-label="Search the transcript"
            className="h-8 pl-8"
          />
        </div>
        <span aria-live="polite" className="min-w-16 text-right text-xs text-muted-foreground tabular-nums">
          {searchLabel}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => step(-1)}
          disabled={matches.length === 0}
          aria-label="Previous match"
        >
          <LuChevronUp aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => step(1)}
          disabled={matches.length === 0}
          aria-label="Next match"
        >
          <LuChevronDown aria-hidden />
        </Button>
      </div>

      {/* Checkbox selection bar */}
      {selectable && checkedList.length > 0 && (
        <div
          role="region"
          aria-label="Selected lines"
          className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-3 py-2 duration-150 animate-in fade-in-0"
        >
          <p aria-live="polite" className="text-sm font-medium text-foreground">
            <span className="tabular-nums">{checkedList.length}</span> line
            {checkedList.length === 1 ? "" : "s"} selected
          </p>
          {tooMany && (
            <span className="text-xs text-destructive">Select at most {MAX_SELECTION} lines.</span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" onClick={() => runAction(checkedList)} disabled={tooMany}>
              <LuPlus aria-hidden />
              {actionLabel}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setChecked(new Set())}>
              <LuX aria-hidden />
              Clear
            </Button>
          </div>
        </div>
      )}

      <VirtualList
        ref={listRef}
        count={segments.length}
        getKey={getKey}
        renderItem={renderItem}
        aria-label="Transcript"
        className="min-h-0 flex-1"
        onScroll={() => floating && setFloating(null)}
      />

      {floating && (
        <div
          className="absolute z-20 duration-150 animate-in fade-in-0 zoom-in-95"
          style={{ top: floating.top, left: floating.left }}
        >
          <Button
            size="sm"
            className="shadow-md"
            // Keep the text selection while clicking.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runAction(floating.idxs, floating.text)}
          >
            <LuPlus aria-hidden />
            {actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

const SegmentRow = memo(function SegmentRow({
  segment,
  tone,
  hint,
  tasks,
  flash,
  selectable,
  checked,
  onCheck,
  query,
  activeOccurrence,
}: {
  segment: TranscriptSegment;
  tone: SpeakerTone | typeof NEUTRAL_TONE;
  hint: boolean;
  tasks: ActionItemTaskRef[] | undefined;
  flash: boolean;
  selectable: boolean;
  checked: boolean;
  onCheck: (idx: number, on: boolean) => void;
  query: string;
  activeOccurrence: number;
}) {
  const time = formatTimestamp(segment.start);
  return (
    <div
      data-seg={segment.idx}
      id={`seg-${segment.idx}`}
      className={cn(
        "group flex gap-3 border-l-2 border-transparent px-3 py-2.5 transition-colors duration-700 ease-out",
        hint && "border-chart-4 bg-chart-4/5",
        checked && "bg-primary/5",
        flash && "border-primary bg-primary/15 duration-150"
      )}
    >
      {selectable && (
        <Checkbox
          className="mt-0.5"
          checked={checked}
          onCheckedChange={(value) => onCheck(segment.idx, Boolean(value))}
          aria-label={`Select line ${segment.idx + 1}${segment.speaker ? ` by ${segment.speaker}` : ""}`}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {time && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground tabular-nums">
              {time}
            </span>
          )}
          {segment.speaker && (
            <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
              <span
                aria-hidden
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-semibold text-background",
                  tone.dot
                )}
              >
                {initials(segment.speaker)}
              </span>
              <span className="truncate">{segment.speaker}</span>
            </span>
          )}
          {hint && (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-chart-4/15 px-1.5 py-0.5 text-[0.7rem] font-medium text-foreground"
              title="Smart hint: this line looks like an action item"
            >
              <LuLightbulb aria-hidden className="size-3" />
              Hint
            </span>
          )}
          {tasks?.map((task) => (
            <Link
              key={task._id}
              to={`/tasks?task=${task._id}`}
              className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[0.7rem] font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
              title={task.title}
            >
              <LuClipboardCheck aria-hidden className="size-3" />
              {taskRefLabel(task)}
            </Link>
          ))}
        </div>
        <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground">
          {highlight(segment.text, query, activeOccurrence)}
        </p>
      </div>
    </div>
  );
});

/** Wraps search matches in <mark>; the active one is emphasised. Text stays escaped. */
function highlight(text: string, query: string, activeOccurrence: number): ReactNode {
  if (!query) return text;
  const pattern = new RegExp(`(${escapeRegExp(query)})`, "gi");
  const parts = text.split(pattern);
  let occurrence = -1;
  return parts.map((part, index) => {
    if (index % 2 === 0) return part;
    occurrence += 1;
    const isActive = occurrence === activeOccurrence;
    return (
      <mark
        key={index}
        className={cn(
          "rounded-sm px-0.5 text-foreground",
          isActive ? "bg-primary text-primary-foreground" : "bg-chart-4/30"
        )}
        aria-current={isActive ? "true" : undefined}
      >
        {part}
      </mark>
    );
  });
}
