import { createContext, useContext, type ReactNode } from "react";

import type { BlockSpec, DrillTarget, InsightBoardSummary } from "@/lib/insights/types";

/** Where "Pin to board" puts a block: the open board, another saved board, or a new one. */
export type PinTarget = { kind: "current" } | { kind: "board"; id: string } | { kind: "new" };

/** What Insights blocks can do on the page (provided by the workspace). */
export interface InsightsActions {
  ask: (question: string) => void;
  pin: (spec: Omit<BlockSpec, "id">, target: PinTarget) => void;
  drill: (target: DrillTarget) => void;
  boards: InsightBoardSummary[];
  currentBoardId: string | null;
  /** The last question asked (drives the tables' default sort). */
  question: string;
}

const noop = () => undefined;
const Ctx = createContext<InsightsActions>({ ask: noop, pin: noop, drill: noop, boards: [], currentBoardId: null, question: "" });

export function InsightsActionsProvider({ value, children }: { value: InsightsActions; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useInsightsActions = () => useContext(Ctx);
