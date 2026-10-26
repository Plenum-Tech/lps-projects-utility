import { Renderer, type ActionEvent } from "@openuidev/react-lang";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  LuChevronDown,
  LuChevronRight,
  LuCircleAlert,
  LuLayoutDashboard,
  LuLoaderCircle,
  LuMail,
  LuMessagesSquare,
  LuPlus,
  LuRefreshCw,
  LuSend,
  LuSparkles,
  LuSquare,
  LuTrash2,
  LuTriangleAlert,
} from "react-icons/lu";

import { InsightsActionsProvider, type InsightsActions, type PinTarget } from "@/components/insights/actions";
import { DataBlock } from "@/components/insights/data-block";
import { DrillSheet } from "@/components/insights/drill-sheet";
import { INSIGHT_ACTIONS, insightsLibrary } from "@/components/insights/library";
import { ReportDialog } from "@/components/insights/report-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateBoard,
  useDeleteBoard,
  useInsightBoard,
  useInsightBoards,
  useInsightChat,
  useInsightHeadline,
  useRefreshBlocks,
  useUpdateBoard,
  type ChatMessage,
} from "@/hooks/use-insights";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import { SCHEDULE_LABELS, type BlockSpec, type DrillTarget, type InsightBoard, type InsightSchedule } from "@/lib/insights/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Leadership Insights workspace (`/insights?board=<id>`): the conversation on
// the left, the Board (saved, live blocks: tool + params + view) on the right;
// one column with a Chat / Board switch on phones. The chat answers with live
// data blocks and edits the board when asked ("add … to the board", "change
// the rework chart to last 6 months"); every session is a saved board.
// ---------------------------------------------------------------------------

export const SUGGESTIONS = [
  { title: "Over scope", question: "Which brands are over scope this month?" },
  { title: "Rework by team", question: "Rework rate by team, internal vs external, last 3 months" },
  { title: "Manpower plan", question: "Who's overloaded in November's plan?" },
  { title: "Pitch pipeline", question: "Pitch pipeline Q4 by lead" },
  { title: "Late work", question: "Tasks closed late last week and why" },
  { title: "Pearity", question: "On vs off Pearity by brand this month" },
];

const REFRESH_HOURS: Partial<Record<InsightSchedule, number>> = { "1h": 1, "2h": 2, "4h": 4 };
const newId = () => Math.random().toString(16).slice(2, 14);

/** Milliseconds until the next refresh of a schedule (browser clock); null = off. */
function msUntilRefresh(schedule: InsightSchedule): number | null {
  const hours = REFRESH_HOURS[schedule];
  if (hours) return hours * 3_600_000;
  if (schedule !== "daily9" && schedule !== "weeklyMon9") return null;
  const now = new Date();
  for (let add = 0; add <= 8; add++) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add, 9, 0, 0);
    if (schedule === "weeklyMon9" && at.getDay() !== 1) continue;
    if (at > now) return at.getTime() - now.getTime();
  }
  return null;
}

const time = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function StartScreen({ onAsk }: { onAsk: (q: string) => void }) {
  const headline = useInsightHeadline();
  return (
    <div className="space-y-5 py-4">
      <div className="space-y-1.5">
        <h2 className="font-heading text-2xl font-semibold tracking-tight">{headline.data?.greeting ?? "Hello"}</h2>
        <p className="text-sm text-muted-foreground">
          {headline.data ? `${headline.data.parts.join(" · ")}.` : headline.isPending ? "Checking today's numbers…" : "What do you want to look at?"}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.question}
            type="button"
            onClick={() => onAsk(s.question)}
            className="group rounded-xl border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
          >
            <div className="text-xs font-medium text-muted-foreground">{s.title}</div>
            <div className="mt-0.5 text-sm">{s.question}</div>
          </button>
        ))}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LuSparkles className="size-3.5" aria-hidden />
        Prototype — answers can be wrong; the tables and charts are live data.
      </p>
    </div>
  );
}

function MessageView({ message, onAction, question, onAsk }: { message: ChatMessage; onAction: (e: ActionEvent) => void; question?: string; onAsk?: (q: string) => void }) {
  if (message.role === "user") {
    return <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">{message.text}</div>;
  }
  const streaming = message.status === "streaming";
  const unmatched = [...(message.check?.unmatchedNumbers ?? []), ...(message.check?.unmatchedTexts ?? []).map((t) => `“${t}”`)];
  return (
    <div className="space-y-2 rounded-2xl rounded-bl-sm border bg-card p-3">
      {streaming && !message.text && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LuLoaderCircle className="size-4 animate-spin" aria-hidden />
          {message.tools.length ? `Reading ${[...new Set(message.tools.map((t) => t.name))].join(", ")}…` : "Thinking…"}
        </p>
      )}
      {message.text && <Renderer response={message.text} library={insightsLibrary} isStreaming={streaming} onAction={onAction} />}
      {message.boardResults?.length ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {message.boardResults.map((r, i) => (
            <li key={i} className="flex gap-1.5">
              <LuLayoutDashboard className="mt-0.5 size-3 shrink-0" aria-hidden />
              Board: {r}
            </li>
          ))}
        </ul>
      ) : null}
      {message.status === "error" && (
        <p className="flex items-center gap-2 text-sm text-critical">
          <LuCircleAlert className="size-4" aria-hidden />
          {message.error}
        </p>
      )}
      {message.inherited?.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs">
          <span>Still filtered to {message.inherited.join(", ")} from earlier.</span>
          {question && onAsk && (
            <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={() => onAsk(`${question} (no ${message.inherited!.map((f) => f.split(":")[0]).join(" / ")} filter)`)}>
              Ask again without it
            </Button>
          )}
        </div>
      ) : null}
      {unmatched.length > 0 && (
        <p className="flex gap-2 rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-xs">
          <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
          <span>Not found in the data, check before using: {unmatched.join(" · ")}</span>
        </p>
      )}
      {message.status === "done" && message.tools.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground">
            <LuChevronRight className="size-3 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
            How this was calculated
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="mt-1.5 space-y-1 rounded-lg bg-muted/40 p-2 text-[11px] text-muted-foreground">
              {message.tools.map((t, i) => (
                <li key={i} className="break-words">
                  <span className="font-medium text-foreground">{t.name}</span> ({Object.entries(t.params).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ") || "defaults"}) →{" "}
                  {t.ok ? `${t.rows} rows` : t.error}, {t.ms} ms
                </li>
              ))}
              <li>
                {message.model} · {message.usage?.total.toLocaleString("en-US")} tokens · {((message.ms ?? 0) / 1000).toFixed(1)} s
              </li>
            </ol>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function BoardsMenu({ currentId, onOpen, onNew }: { currentId: string | null; onOpen: (id: string) => void; onNew: () => void }) {
  const boards = useInsightBoards();
  const remove = useDeleteBoard();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        Boards
        <LuChevronDown className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => {
            onNew();
            setOpen(false);
          }}
        >
          <LuPlus className="size-3.5" aria-hidden /> New board
        </Button>
        <div className="my-1 border-t" />
        <div className="max-h-80 overflow-y-auto">
          {(boards.data ?? []).length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No saved boards yet.</p>}
          {(boards.data ?? []).map((b) => (
            <div key={b._id} className={cn("group flex items-center gap-1 rounded-md hover:bg-muted", b._id === currentId && "bg-muted")}>
              <button
                type="button"
                className="min-w-0 flex-1 px-2 py-1.5 text-left"
                onClick={() => {
                  onOpen(b._id);
                  setOpen(false);
                }}
              >
                <div className="truncate text-sm">{b.title}</div>
                <div className="text-[11px] text-muted-foreground">
                  {b.blocks} block{b.blocks === 1 ? "" : "s"} · {new Date(b.updatedAt).toLocaleDateString()}
                  {b.report !== "off" && ` · report ${SCHEDULE_LABELS[b.report].toLowerCase()}`}
                </div>
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                title="Delete board"
                aria-label={`Delete ${b.title}`}
                onClick={() => {
                  if (window.confirm(`Delete the board “${b.title}”?`)) {
                    remove.mutate(b._id, { onSuccess: () => b._id === currentId && onNew() });
                  }
                }}
              >
                <LuTrash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Leadership Insights: chat + live board, saved per user. */
export function InsightsWorkspace() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const boardId = searchParams.get("board");
  const savedBoard = useInsightBoard(boardId);
  const boards = useInsightBoards();
  const createBoard = useCreateBoard();
  const updateBoard = useUpdateBoard();
  const refreshBlocks = useRefreshBlocks();

  const [blocks, setBlocks] = useState<BlockSpec[]>([]);
  const [title, setTitle] = useState("New board");
  const [pane, setPane] = useState<"chat" | "board">("chat");
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [reportFor, setReportFor] = useState<string | null>(null);
  const [pinned, setPinned] = useState<{ id: string; title: string } | null>(null);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const [question, setQuestion] = useState("");
  const loadedId = useRef<string | null>(null);
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;

  const openBoard = useCallback((id: string | null) => setSearchParams(id ? { board: id } : {}, { replace: false }), [setSearchParams]);

  /** Saves the board (creating it on the first change of a new session). */
  const persist = useCallback(
    async (patch: { blocks?: BlockSpec[]; messages?: ChatMessage[]; title?: string }) => {
      const body = {
        ...(patch.blocks ? { blocks: patch.blocks } : {}),
        ...(patch.title ? { title: patch.title } : {}),
        ...(patch.messages ? { messages: patch.messages.filter((m) => m.status === "done" && m.text).map((m) => ({ role: m.role, text: m.text })) } : {}),
      };
      try {
        if (boardIdRef.current) {
          await updateBoard.mutateAsync({ id: boardIdRef.current, ...body });
        } else {
          const board = await createBoard.mutateAsync({ title: patch.title ?? title, ...body });
          loadedId.current = board._id;
          boardIdRef.current = board._id;
          openBoard(board._id);
        }
      } catch (err) {
        toast.error(`Couldn't save the board: ${getErrorMessage(err)}`);
      }
    },
    [createBoard, openBoard, title, toast, updateBoard],
  );

  const pendingSettings = useRef<{ refresh?: InsightSchedule; report?: InsightSchedule } | null>(null);
  const latestBlocks = useRef(blocks);
  latestBlocks.current = blocks;

  const chat = useInsightChat({
    blocks,
    boardId,
    onBoard: (next, settings) => {
      latestBlocks.current = next;
      setBlocks(next);
      if (settings.refresh || settings.report) pendingSettings.current = { ...pendingSettings.current, ...settings };
    },
    onDone: async (messages) => {
      const firstQuestion = messages.find((m) => m.role === "user")?.text;
      await persist({ messages, blocks: latestBlocks.current, ...(!boardIdRef.current && firstQuestion ? { title: firstQuestion.slice(0, 80) } : {}) });
      // "Refresh / email me every 2 hours" asked in the chat: applied once the board is saved.
      const settings = pendingSettings.current;
      pendingSettings.current = null;
      if (settings && boardIdRef.current) {
        updateBoard.mutate(
          { id: boardIdRef.current, ...(settings.refresh ? { refresh: settings.refresh } : {}), ...(settings.report ? { report: { schedule: settings.report } } : {}) },
          { onSuccess: () => toast.success(`Board scheduled: ${[settings.refresh && `refresh ${SCHEDULE_LABELS[settings.refresh].toLowerCase()}`, settings.report && `report ${SCHEDULE_LABELS[settings.report].toLowerCase()}`].filter(Boolean).join(", ")}`) },
        );
      }
    },
  });
  // Open a saved board: its blocks, title and conversation.
  useEffect(() => {
    if (!boardId) {
      if (loadedId.current !== null) {
        loadedId.current = null;
        setBlocks([]);
        setTitle("New board");
        chat.load([]);
      }
      return;
    }
    const board = savedBoard.data;
    if (!board || loadedId.current === board._id) return;
    loadedId.current = board._id;
    setBlocks(board.blocks);
    setTitle(board.title);
    chat.load(board.messages);
    setUpdatedAt(new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, savedBoard.data]);

  // Auto-refresh while open (no AI call: the blocks re-run their tools).
  const refreshSchedule: InsightSchedule = (boardId && savedBoard.data?.refresh) || "off";
  useEffect(() => {
    const ms = msUntilRefresh(refreshSchedule);
    if (ms === null) return;
    const timer = setTimeout(() => {
      void refreshBlocks();
      setUpdatedAt(new Date());
    }, ms);
    return () => clearTimeout(timer);
  }, [refreshSchedule, refreshBlocks, updatedAt]);

  const setBoardBlocks = (next: BlockSpec[]) => {
    setBlocks(next);
    void persist({ blocks: next });
  };

  const pin = useCallback(
    async (spec: Omit<BlockSpec, "id">, target: PinTarget) => {
      const block = { ...spec, id: newId() } as BlockSpec;
      try {
        if (target.kind === "current" || (target.kind === "board" && target.id === boardIdRef.current)) {
          const next = [...latestBlocks.current, block];
          setBlocks(next);
          await persist({ blocks: next });
          setPinned({ id: boardIdRef.current ?? "", title: "this board" });
        } else if (target.kind === "board") {
          const { data } = await api.get<{ board: InsightBoard }>(`/insights/boards/${target.id}`);
          await updateBoard.mutateAsync({ id: target.id, blocks: [...data.board.blocks, block] });
          setPinned({ id: target.id, title: data.board.title });
        } else {
          const name = window.prompt("Name of the new board", spec.title);
          if (!name) return;
          const board = await createBoard.mutateAsync({ title: name, blocks: [block] });
          setPinned({ id: board._id, title: board.title });
        }
      } catch (err) {
        toast.error(`Couldn't pin: ${getErrorMessage(err)}`);
      }
    },
    [createBoard, persist, toast, updateBoard],
  );

  const ask = useCallback(
    (q: string) => {
      if (!q.trim() || chat.busy) return;
      setPane("chat");
      setPinned(null);
      void chat.ask(q);
    },
    [chat],
  );

  const actions: InsightsActions = useMemo(
    () => ({
      ask,
      pin: (spec, target) => void pin(spec, target),
      drill: (target) => (target.kind === "task" ? navigate(`/tasks?task=${target.value}`) : setDrill(target)),
      boards: boards.data ?? [],
      currentBoardId: boardId,
      question: [...chat.messages].reverse().find((m) => m.role === "user")?.text ?? "",
    }),
    [ask, pin, navigate, boards.data, boardId, chat.messages],
  );

  // Actions from inside the OpenUI answers (react-lang useTriggerAction → onAction).
  const onAction = useCallback(
    (e: ActionEvent) => {
      if (e.type === INSIGHT_ACTIONS.ask) ask(String(e.params.question ?? e.humanFriendlyMessage));
      else if (e.type === INSIGHT_ACTIONS.pin) void pin(e.params.block as Omit<BlockSpec, "id">, e.params.target as PinTarget);
      else if (e.type === INSIGHT_ACTIONS.drill) actions.drill(e.params.target as DrillTarget);
    },
    [ask, pin, actions],
  );

  function submit() {
    if (!question.trim()) return;
    ask(question);
    setQuestion("");
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  const scroller = useRef<HTMLDivElement>(null);
  const lastText = chat.messages.at(-1)?.text.length ?? 0;
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages.length, lastText]);

  return (
    <InsightsActionsProvider value={actions}>
      <div className="flex min-w-0 flex-col lg:h-[calc(100dvh-3.5rem)]">
        {/* Header: board title, boards, refresh, report */}
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5 sm:px-6">
          <h1 className="sr-only">Insights</h1>
          <LuSparkles className="size-4 shrink-0 text-primary" aria-hidden />
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => boardId && title.trim() && title !== savedBoard.data?.title && void persist({ title: title.trim() })}
            aria-label="Board title"
            className="h-8 w-auto min-w-[9rem] flex-1 border-transparent px-1.5 font-heading text-base font-semibold shadow-none hover:border-input sm:max-w-sm"
          />
          <BoardsMenu currentId={boardId} onOpen={(id) => openBoard(id)} onNew={() => openBoard(null)} />
          <Button variant="outline" size="sm" onClick={() => openBoard(null)} title="New board">
            <LuPlus className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">New</span>
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Updated {time(updatedAt)}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Refresh the data"
              aria-label="Refresh the data"
              onClick={() => {
                void refreshBlocks();
                setUpdatedAt(new Date());
              }}
            >
              <LuRefreshCw className="size-3.5" />
            </Button>
            {boardId && (
              <>
                <NativeSelect
                  size="sm"
                  aria-label="Auto-refresh"
                  value={savedBoard.data?.refresh ?? "off"}
                  onChange={(e) => updateBoard.mutate({ id: boardId, refresh: e.target.value as InsightSchedule })}
                >
                  {(Object.keys(SCHEDULE_LABELS) as InsightSchedule[]).map((s) => (
                    <NativeSelectOption key={s} value={s}>
                      {s === "off" ? "Auto-refresh off" : `Refresh: ${SCHEDULE_LABELS[s].toLowerCase()}`}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <Button variant="outline" size="sm" onClick={() => setReportFor(boardId)}>
                  <LuMail className="size-3.5" aria-hidden />
                  {savedBoard.data?.report.schedule && savedBoard.data.report.schedule !== "off" ? SCHEDULE_LABELS[savedBoard.data.report.schedule] : "Send me a report"}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Phone: Chat / Board switch */}
        <div className="flex gap-1 border-b p-1.5 lg:hidden" role="tablist" aria-label="Insights view">
          {(["chat", "board"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={pane === p}
              onClick={() => setPane(p)}
              className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm", pane === p ? "bg-muted font-medium" : "text-muted-foreground")}
            >
              {p === "chat" ? <LuMessagesSquare className="size-4" aria-hidden /> : <LuLayoutDashboard className="size-4" aria-hidden />}
              {p === "chat" ? "Chat" : `Board${blocks.length ? ` (${blocks.length})` : ""}`}
            </button>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          {/* Conversation */}
          <section className={cn("flex min-h-0 flex-col border-r", pane !== "chat" && "hidden lg:flex")} aria-label="Conversation">
            <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-6">
              {chat.messages.length === 0 ? <StartScreen onAsk={ask} /> : chat.messages.map((m, i) => <MessageView key={m.id} message={m} onAction={onAction} question={chat.messages[i - 1]?.text} onAsk={ask} />)}
              {pinned && (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                  Pinned to {pinned.title}.
                  {pinned.id && pinned.id !== boardId && (
                    <Button variant="link" size="xs" className="h-auto p-0" onClick={() => openBoard(pinned.id)}>
                      Open board
                    </Button>
                  )}
                  {pinned.id && (
                    <Button variant="link" size="xs" className="h-auto p-0" onClick={() => setReportFor(pinned.id)}>
                      Schedule updates
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="sticky bottom-0 border-t bg-background p-3 sm:px-6">
              <div className="relative">
                <Textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={onKeyDown}
                  maxLength={500}
                  rows={2}
                  placeholder="Ask, or tell the board what to change… (Enter to send)"
                  aria-label="Question"
                  className="min-h-14 resize-none pr-12"
                />
                <Button
                  type="button"
                  size="icon-sm"
                  className="absolute right-2 bottom-2"
                  onClick={() => (chat.busy ? chat.stop() : submit())}
                  disabled={!chat.busy && !question.trim()}
                  aria-label={chat.busy ? "Stop" : "Ask"}
                  title={chat.busy ? "Stop" : "Ask"}
                >
                  {chat.busy ? <LuSquare className="size-3.5" /> : <LuSend className="size-3.5" />}
                </Button>
              </div>
            </div>
          </section>

          {/* Board */}
          <section className={cn("min-h-0 overflow-y-auto bg-muted/20 px-4 py-4 sm:px-6", pane !== "board" && "hidden lg:block")} aria-label="Board">
            {blocks.length === 0 ? (
              <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                <LuLayoutDashboard className="size-6" aria-hidden />
                <p>Your board is empty.</p>
                <p className="max-w-sm text-xs">Pin answers from the chat, or say “add Pearity by brand to the board”. Boards keep the query, not the numbers — they show live data whenever you open them.</p>
              </div>
            ) : (
              <div className="grid gap-3 2xl:grid-cols-2">
                {blocks.map((b, i) => (
                  <DataBlock
                    key={b.id}
                    spec={b}
                    mode="board"
                    onChange={(spec) => setBoardBlocks(blocks.map((x, j) => (j === i ? { ...spec, id: b.id } : x)))}
                    onRemove={() => setBoardBlocks(blocks.filter((x) => x.id !== b.id))}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
      <DrillSheet target={drill} onClose={() => setDrill(null)} />
      <ReportDialog boardId={reportFor} onClose={() => setReportFor(null)} />
    </InsightsActionsProvider>
  );
}
