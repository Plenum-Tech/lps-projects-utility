import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export interface VirtualListHandle {
  /** Scrolls so the item sits a little below the top of the viewport. */
  scrollToIndex: (index: number) => void;
  element: HTMLDivElement | null;
}

const OVERSCAN_PX = 600;

// SSR-safe layout effect.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function lowerBound(offsets: number[], value: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Windowed list for variable-height rows (no dependency): only the rows in
 * (and around) the viewport are mounted. Rows are measured as they render, so
 * estimates converge while scrolling. Rows render in normal flow between two
 * spacers, which keeps text selection and focus order natural.
 */
export const VirtualList = forwardRef<
  VirtualListHandle,
  {
    count: number;
    estimate?: number;
    renderItem: (index: number) => ReactNode;
    getKey: (index: number) => string | number;
    className?: string;
    "aria-label"?: string;
    onScroll?: () => void;
  }
>(function VirtualList(
  { count, estimate = 76, renderItem, getKey, className, onScroll, "aria-label": ariaLabel },
  ref
) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef<Map<string | number, number>>(new Map());
  const [version, setVersion] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });

  const offsets = useMemo(() => {
    const out = new Array<number>(count + 1);
    out[0] = 0;
    for (let index = 0; index < count; index += 1) {
      out[index + 1] = out[index] + (heights.current.get(getKey(index)) ?? estimate);
    }
    return out;
    // `version` bumps whenever a measured height changes.
  }, [count, estimate, getKey, version]);
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;

  const total = offsets[count] ?? 0;
  const relativeTop = viewport.top;
  const start = count === 0 ? 0 : Math.min(count - 1, lowerBound(offsets, Math.max(0, relativeTop - OVERSCAN_PX)));
  const endTarget = relativeTop + viewport.height + OVERSCAN_PX;
  let end = start;
  while (end < count && offsets[end] < endTarget) end += 1;

  const syncViewport = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    setViewport((current) =>
      current.top === node.scrollTop && current.height === node.clientHeight
        ? current
        : { top: node.scrollTop, height: node.clientHeight }
    );
  }, []);

  useIsoLayoutEffect(() => {
    syncViewport();
    const node = scrollerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncViewport());
    observer.observe(node);
    return () => observer.disconnect();
  }, [syncViewport]);

  // Measure mounted rows after every render; bump the version when any changed.
  const rowObserver = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    rowObserver.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const key = element.dataset.vkey;
        if (key === undefined) continue;
        const parsed: string | number = element.dataset.vnum === "1" ? Number(key) : key;
        const height = element.offsetHeight;
        if (height > 0 && heights.current.get(parsed) !== height) {
          heights.current.set(parsed, height);
          changed = true;
        }
      }
      if (changed) setVersion((value) => value + 1);
    });
    return () => rowObserver.current?.disconnect();
  }, []);

  const measureRef = useCallback((element: HTMLDivElement | null) => {
    if (element) rowObserver.current?.observe(element);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      element: scrollerRef.current,
      scrollToIndex: (index) => {
        const node = scrollerRef.current;
        if (!node || index < 0 || index >= count) return;
        const jumpTo = (top: number) => {
          node.scrollTop = Math.max(0, top);
          // Don't wait for the (frame-throttled) scroll event to render the new window.
          syncViewport();
        };
        jumpTo(offsetsRef.current[index] - 48);
        // Rows near the target get measured after they mount — correct a few times as estimates settle.
        let attempts = 0;
        const settle = () => {
          attempts += 1;
          const row = node.querySelector<HTMLElement>(`[data-vindex="${index}"]`);
          if (row) {
            const delta = row.getBoundingClientRect().top - node.getBoundingClientRect().top - 48;
            if (Math.abs(delta) > 4) jumpTo(node.scrollTop + delta);
            else return;
          } else {
            jumpTo(offsetsRef.current[index] - 48);
          }
          if (attempts < 4) window.setTimeout(settle, 50);
        };
        window.setTimeout(settle, 30);
      },
    }),
    [count, syncViewport]
  );

  const rows: ReactNode[] = [];
  for (let index = start; index < end; index += 1) {
    const key = getKey(index);
    rows.push(
      <div
        key={key}
        ref={measureRef}
        data-vkey={String(key)}
        data-vnum={typeof key === "number" ? "1" : "0"}
        data-vindex={index}
        role="listitem"
      >
        {renderItem(index)}
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={() => {
        syncViewport();
        onScroll?.();
      }}
      className={cn("relative overflow-y-auto overscroll-contain", className)}
      role="list"
      aria-label={ariaLabel}
    >
      <div style={{ height: offsets[start] ?? 0 }} aria-hidden />
      {rows}
      <div style={{ height: Math.max(0, total - (offsets[end] ?? total)) }} aria-hidden />
    </div>
  );
});
