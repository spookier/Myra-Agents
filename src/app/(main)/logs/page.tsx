"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRouter, useSearchParams } from "next/navigation";

import {
  CircleStopIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderIcon,
  ListFilterIcon,
  SearchIcon,
  SquarePenIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { ConversationView } from "@/components/conversation/conversation-view";
import { ReviewComposer } from "@/components/conversation/review-composer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useKanban } from "@/hooks/use-kanban";
import { parseGlobalId } from "@/lib/aggregate/global-id";
import { connectionManager } from "@/lib/connections/manager";
import { parseTranscript } from "@/lib/conversation/parse";
import { requestChangeNotes } from "@/lib/conversation/request-changes";
import { invokeOn } from "@/lib/tauri";
import { useBoardStore } from "@/stores/board-store";
import { useBreadcrumbOverride } from "@/stores/breadcrumb-store";
import type { AgentRun, KanbanCard, KanbanStatus } from "@/types/kanban";

interface RunArtifact {
  name: string;
  path: string;
  size: number;
  modified?: string;
}

function LogsPageInner() {
  const t = useTranslations("logs");
  const router = useRouter();
  const { cards, loading, moveCard, addRevisionNote, answerFeedback, launchAgent, cancelAgent, cancellingIds } =
    useKanban();
  const searchParams = useSearchParams();
  const deepLinkCardId = searchParams.get("card");
  const [selectedRun, setSelectedRun] = useState<{ card: KanbanCard; run: AgentRun } | null>(null);
  const [logContent, setLogContent] = useState<string | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [query, setQuery] = useState("");
  // `needs_you` is a virtual filter covering both human-attention run states
  // (needs_feedback + awaiting_review), shown as a single "Needs you" option.
  const [statusFilter, setStatusFilter] = useState<AgentRun["status"] | "needs_you" | "all">("all");
  const [automationFilter, setAutomationFilter] = useState<string>("all");

  // The run detail is reached from the Operations list — surface it as
  // "Operations › {run title}" in the top bar (the path is `/logs`).
  useBreadcrumbOverride(
    selectedRun ? { label: selectedRun.card.title, parent: { label: "Operations", href: "/runs" } } : null,
  );

  const allRuns = useMemo(
    () =>
      cards
        .filter((c) => c.runHistory && c.runHistory.length > 0)
        .flatMap((c) => (c.runHistory ?? []).map((run) => ({ card: c, run })))
        .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt)),
    [cards],
  );

  // The card's live status only applies to its most recent run; older runs in
  // the history keep their own snapshot. allRuns is sorted desc, so the first
  // entry per card is the latest run.
  const latestRunIds = useMemo(() => {
    const seenCards = new Set<string>();
    const ids = new Set<string>();
    for (const { card, run } of allRuns) {
      if (!seenCards.has(card.id)) {
        seenCards.add(card.id);
        ids.add(run.id);
      }
    }
    return ids;
  }, [allRuns]);

  // ── Live log streaming for the open run ──────────────────────────────────
  // The detail fetches the log once on open; new lines then arrive via
  // `agent-log-appended` (board store `logs`) and are appended past the fetch
  // baseline so the conversation grows live without a manual reload.
  const liveLogs = useBoardStore((s) => s.logs);
  const liveLogsRef = useRef(liveLogs);
  liveLogsRef.current = liveLogs;
  const logBaselineRef = useRef(0);
  const selCardId = selectedRun?.card.id;

  // Tell the backend to stream this card's run log while the detail is open —
  // `agent-log-appended` is gated to watched cards. Cleared on close/unmount.
  useEffect(() => {
    if (!selCardId) return;
    void connectionManager.setLogWatch([selCardId]);
    return () => {
      void connectionManager.setLogWatch([]);
    };
  }, [selCardId]);

  // Is the open run still executing? (the card's live status is the truth.)
  const selRunning = useMemo(() => {
    if (!selectedRun) return false;
    const liveCard = cards.find((c) => c.id === selectedRun.card.id) ?? selectedRun.card;
    return displayRunStatus(liveCard, selectedRun.run, latestRunIds.has(selectedRun.run.id)) === "running";
  }, [selectedRun, cards, latestRunIds]);

  // Always keep the streamed tail merged onto the snapshot (not just while
  // running) — otherwise the live lines would vanish the instant the run ends,
  // falling back to the partial open-time snapshot. By construction the tail is
  // the lines *after* the fetch baseline, so there's no overlap with logContent.
  const liveLines = selCardId ? (liveLogs.get(selCardId) ?? []) : [];
  const liveTail = liveLines.slice(logBaselineRef.current).join("\n");
  const effectiveLog = useMemo(() => {
    if (!liveTail) return logContent;
    return [logContent ?? "", liveTail].filter(Boolean).join("\n");
  }, [logContent, liveTail]);

  const transcript = useMemo(
    () => (selectedRun ? parseTranscript(effectiveLog, selectedRun.run) : { entries: [], structured: false }),
    [effectiveLog, selectedRun],
  );

  // When the open run finishes, re-fetch the authoritative complete log: the
  // live tail is capped (500 lines) and the final result footer lands in the
  // file, so this both repairs long runs and yields the canonical transcript.
  const wasRunning = useRef(false);
  useEffect(() => {
    const ended = wasRunning.current && !selRunning;
    wasRunning.current = selRunning;
    if (!ended || !selectedRun) return;
    const { connId, entityId } = parseGlobalId(selectedRun.card.id);
    const cardId = selectedRun.card.id;
    void invokeOn<string>(connId, "get_run_log", { cardId: entityId, runId: selectedRun.run.id })
      .then((log) => {
        logBaselineRef.current = (liveLogsRef.current.get(cardId) ?? []).length;
        setLogContent(log);
      })
      .catch(() => undefined);
  }, [selRunning, selectedRun]);

  // Keep the live view pinned to the latest output while the run is executing.
  const bottomRef = useRef<HTMLDivElement>(null);
  const selEntryCount = transcript.entries.length;
  useEffect(() => {
    if (selRunning && selEntryCount) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [selRunning, selEntryCount]);

  // Success/failure counts over the last 24h and 7d, for the summary cards.
  const stats = useMemo(() => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const acc = { ok24h: 0, fail24h: 0, ok7d: 0, fail7d: 0 };
    for (const { card, run } of allRuns) {
      const age = now - Date.parse(run.startedAt);
      if (Number.isNaN(age)) continue;
      const status = displayRunStatus(card, run, latestRunIds.has(run.id));
      const ok = status === "completed";
      const fail = status === "failed";
      if (age <= day) {
        if (ok) acc.ok24h++;
        if (fail) acc.fail24h++;
      }
      if (age <= 7 * day) {
        if (ok) acc.ok7d++;
        if (fail) acc.fail7d++;
      }
    }
    return acc;
  }, [allRuns, latestRunIds]);

  // Distinct job names present in the history — populates the Automation submenu.
  const automations = useMemo(() => {
    const names = new Set<string>();
    for (const { card } of allRuns) names.add(card.title);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [allRuns]);

  const filteredRuns = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRuns.filter(({ card, run }) => {
      const ds = displayRunStatus(card, run, latestRunIds.has(run.id));
      const statusMatch =
        statusFilter === "all" ||
        ds === statusFilter ||
        (statusFilter === "needs_you" && (ds === "needs_feedback" || ds === "awaiting_review"));
      return (
        statusMatch &&
        (automationFilter === "all" || card.title === automationFilter) &&
        (q === "" || card.title.toLowerCase().includes(q))
      );
    });
  }, [allRuns, query, statusFilter, automationFilter, latestRunIds]);

  const activeFilters = (statusFilter !== "all" ? 1 : 0) + (automationFilter !== "all" ? 1 : 0);

  const handleViewLog = useCallback(
    async (card: KanbanCard, run: AgentRun) => {
      setSelectedRun({ card, run });
      setLoadingLog(true);
      setArtifacts([]);
      const { connId, entityId } = parseGlobalId(card.id);
      try {
        const log = await invokeOn<string>(connId, "get_run_log", { cardId: entityId, runId: run.id });
        // Snapshot fetched: only append live lines streamed from here on.
        logBaselineRef.current = (liveLogsRef.current.get(card.id) ?? []).length;
        setLogContent(log);
      } catch (e) {
        setLogContent(t("details.errorLoading", { error: String(e) }));
      } finally {
        setLoadingLog(false);
      }
      try {
        const list = await invokeOn<RunArtifact[]>(connId, "list_run_artifacts", { cardId: entityId });
        setArtifacts(list);
      } catch {
        setArtifacts([]);
      }
    },
    [t],
  );

  // Deep-link from the Kanban board (?card=<id>): auto-open that card's most
  // recent run as a conversation. Runs once per distinct card id.
  const openedDeepLink = useRef<string | null>(null);
  useEffect(() => {
    if (loading || !deepLinkCardId || openedDeepLink.current === deepLinkCardId) return;
    const card = cards.find((c) => c.id === deepLinkCardId);
    const run = (card?.runHistory ?? []).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!card || !run) return;
    openedDeepLink.current = deepLinkCardId;
    void handleViewLog(card, run);
  }, [loading, deepLinkCardId, cards, handleViewLog]);

  const openPath = useCallback(
    async (path: string) => {
      // Artifact paths live on the run's owning server — route open there.
      const connId = selectedRun ? parseGlobalId(selectedRun.card.id).connId : connectionManager.primaryId();
      try {
        await invokeOn(connId, "open_path", { path });
      } catch (e) {
        toast.error(String(e));
      }
    },
    [selectedRun],
  );

  const openWorkingDir = useCallback(async (cardId: string) => {
    const { connId, entityId } = parseGlobalId(cardId);
    try {
      await invokeOn(connId, "open_card_working_dir", { cardId: entityId });
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">{t("loading")}</p>
      </div>
    );
  }

  if (selectedRun) {
    // The run's status is a snapshot; the card may still be waiting on the user.
    const liveCard = cards.find((c) => c.id === selectedRun.card.id) ?? selectedRun.card;
    // The run status is a snapshot taken when the agent stopped; the card's live
    // status is the source of truth for post-run transitions (e.g. approved → done).
    const displayStatus = displayRunStatus(liveCard, selectedRun.run, latestRunIds.has(selectedRun.run.id));
    const logArtifact = artifacts.find((a) => a.name.endsWith(".log")) ?? artifacts[0];
    // "Request changes" feedback collected on this card. When the finished run
    // came from a patrol, the review footer offers to fold it back into the
    // patrol's definition (the edit page picks it up via `?suggest=`).
    const requestChanges = requestChangeNotes(liveCard);
    const patrolId = liveCard.linkedTaskId;
    return (
      <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <h2 className="truncate font-semibold text-sm">{selectedRun.card.title}</h2>
          <RunStatusBadge status={displayStatus} />
        </div>

        <div className="space-x-3 text-muted-foreground text-xs">
          <span>
            {t("details.startedAt")}: {new Date(selectedRun.run.startedAt).toLocaleString()}
          </span>
          {selectedRun.run.endedAt && (
            <span>
              {t("details.endedAt")}: {new Date(selectedRun.run.endedAt).toLocaleString()}
            </span>
          )}
          {typeof selectedRun.run.exitCode === "number" && (
            <span>
              {t("details.exitCode")}: {selectedRun.run.exitCode}
            </span>
          )}
          {selectedRun.run.endedAt && (
            <span>
              {t("details.duration")}: {formatDuration(selectedRun.run.startedAt, selectedRun.run.endedAt)}
            </span>
          )}
          {typeof selectedRun.run.tokens === "number" && (
            <span>
              {t("details.tokens")}: {selectedRun.run.tokens.toLocaleString()}
            </span>
          )}
          {typeof selectedRun.run.cost === "number" && (
            <span>
              {t("details.cost")}: ${selectedRun.run.cost.toFixed(2)}
            </span>
          )}
          {selectedRun.card.workingDir && (
            <span className="inline-flex items-center gap-1" title={selectedRun.card.workingDir}>
              <FolderIcon className="size-3" />
              <span className="max-w-[22ch] truncate font-mono align-bottom">{selectedRun.card.workingDir}</span>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Stop the live run (only while it's actually running). */}
          {(displayStatus === "running" || cancellingIds.has(liveCard.id)) && (
            <Button
              variant="destructive"
              size="sm"
              disabled={cancellingIds.has(liveCard.id)}
              onClick={async () => {
                try {
                  await cancelAgent(liveCard.id);
                  toast.success(t("details.stopped"));
                } catch (e) {
                  toast.error(String(e));
                }
              }}
            >
              <CircleStopIcon className="size-3.5" />
              {cancellingIds.has(liveCard.id) ? t("details.stopping") : t("details.stop")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => openWorkingDir(selectedRun.card.id)}>
            <FolderIcon className="size-3.5" />
            {t("details.openWorkingDir")}
          </Button>
          {selectedRun.card.linkedTaskId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => router.push(`/schedules/edit/?id=${encodeURIComponent(selectedRun.card.linkedTaskId!)}`)}
            >
              <SquarePenIcon className="size-3" />
              {t("details.editPatrol")}
            </Button>
          )}
          {logArtifact && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => openPath(logArtifact.path)}
              title={logArtifact.path}
            >
              <FileIcon className="size-3" />
              {t("details.logs")}
              <ExternalLinkIcon className="size-3 opacity-60" />
            </Button>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="h-full">
            {loadingLog ? (
              <p className="text-muted-foreground text-sm">{t("details.loadingLog")}</p>
            ) : (
              <>
                <ConversationView transcript={transcript} thinking={selRunning} />
                <div ref={bottomRef} />
              </>
            )}
          </ScrollArea>
        </div>

        <ReviewComposer
          status={liveCard.status}
          question={liveCard.agentQuestion}
          pushWorkingDir={liveCard.workingDir}
          pushTitle={liveCard.title}
          pushBody={liveCard.agentResult ?? liveCard.description ?? ""}
          onApprove={async () => {
            await moveCard(liveCard.id, "done");
            toast.success(t("conversation.review.approved"));
          }}
          onRevise={async (note) => {
            // Store the note, then relaunch so the reply actually reaches the
            // agent (resume = continue the previous session where supported).
            // No local toast: the global run-start toast (#239) covers it.
            await addRevisionNote(liveCard.id, note);
            await launchAgent(liveCard.id, undefined, { resume: true });
          }}
          onAnswer={async (answer) => {
            await answerFeedback(liveCard.id, answer);
            await launchAgent(liveCard.id, undefined, { resume: true });
          }}
          onReopen={async () => {
            await moveCard(liveCard.id, "awaiting_review");
          }}
          onSuggestPatrol={
            patrolId && requestChanges.length > 0
              ? () =>
                  router.push(
                    `/schedules/edit/?id=${encodeURIComponent(patrolId)}&suggest=${encodeURIComponent(
                      requestChanges.join("\n\n"),
                    )}`,
                  )
              : undefined
          }
          onFollowUp={async (note) => {
            await addRevisionNote(liveCard.id, note);
            await launchAgent(liveCard.id, undefined, { resume: true });
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-5 p-6">
      <div>
        <h1 className="font-semibold text-xl tracking-tight">{t("title")}</h1>
        <p className="mt-0.5 text-muted-foreground text-sm">{t("description")}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t("stats.successful24h")} value={stats.ok24h} tone="success" />
        <StatCard label={t("stats.failed24h")} value={stats.fail24h} tone="danger" />
        <StatCard label={t("stats.successful7d")} value={stats.ok7d} tone="success" />
        <StatCard label={t("stats.failed7d")} value={stats.fail7d} tone="danger" />
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2.5 size-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="relative h-8 gap-1.5">
              <ListFilterIcon className="size-3.5" />
              {t("filter.button")}
              {activeFilters > 0 && (
                <span className="ml-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground tabular-nums">
                  {activeFilters}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-muted-foreground text-xs">{t("filter.filterBy")}</DropdownMenuLabel>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t("filter.automation")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                <DropdownMenuRadioGroup value={automationFilter} onValueChange={setAutomationFilter}>
                  <DropdownMenuRadioItem value="all">{t("filter.allAutomations")}</DropdownMenuRadioItem>
                  {automations.map((name) => (
                    <DropdownMenuRadioItem key={name} value={name}>
                      <span className="truncate">{name}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t("filter.status")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup
                  value={statusFilter}
                  onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
                >
                  <DropdownMenuRadioItem value="all">{t("filter.allStatuses")}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="running">{t("status.running")}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="completed">{t("status.completed")}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="failed">{t("status.failed")}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="needs_you">{t("status.needsYou")}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {activeFilters > 0 && (
              <>
                <DropdownMenuSeparator />
                <button
                  type="button"
                  className="w-full rounded-sm px-2 py-1.5 text-left text-muted-foreground text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    setStatusFilter("all");
                    setAutomationFilter("all");
                  }}
                >
                  {t("filter.clear")}
                </button>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {allRuns.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed">
          <p className="text-muted-foreground text-sm">{t("noLogs")}</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
          <ScrollArea className="h-full">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-9 w-[280px]">{t("columns.jobName")}</TableHead>
                  <TableHead className="h-9 w-[170px]">{t("columns.triggered")}</TableHead>
                  <TableHead className="h-9">{t("columns.status")}</TableHead>
                  <TableHead className="h-9 w-[100px] text-right">{t("columns.duration")}</TableHead>
                  <TableHead className="h-9 w-[110px] text-right">{t("columns.usage")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRuns.map(({ card, run }) => (
                  <TableRow
                    key={`${card.id}-${run.id}`}
                    className="h-11 cursor-pointer"
                    onClick={() => handleViewLog(card, run)}
                  >
                    <TableCell className="max-w-[280px] truncate font-medium text-sm">{card.title}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                      {formatTriggered(run.startedAt)}
                    </TableCell>
                    <TableCell>
                      <StatusDot status={displayRunStatus(card, run, latestRunIds.has(run.id))} />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                      {run.endedAt ? formatDuration(run.startedAt, run.endedAt) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                      {typeof run.cost === "number"
                        ? `$${run.cost.toFixed(2)}`
                        : typeof run.tokens === "number"
                          ? `${(run.tokens / 1000).toFixed(1)}k`
                          : "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {filteredRuns.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground text-sm">
                      {t("noMatches")}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: "success" | "danger" }) {
  return (
    <div className="rounded-lg border bg-card px-3.5 py-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={`mt-0.5 font-semibold text-2xl tabular-nums ${
          value === 0 ? "text-muted-foreground" : tone === "success" ? "text-emerald-500" : "text-destructive"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

const STATUS_DOT: Record<AgentRun["status"], string> = {
  running: "bg-blue-500",
  // Both human-attention states share one "Needs you" identity (label + color),
  // matching the Operations page.
  needs_feedback: "bg-task-status-needs-you",
  awaiting_review: "bg-task-status-needs-you",
  completed: "bg-emerald-500",
  failed: "bg-destructive",
};

function StatusDot({ status }: { status: AgentRun["status"] }) {
  const t = useTranslations("logs");
  const labels: Record<AgentRun["status"], string> = {
    running: t("status.running"),
    needs_feedback: t("status.needsYou"),
    awaiting_review: t("status.needsYou"),
    completed: t("status.completed"),
    failed: t("status.failed"),
  };
  return (
    <span className="flex items-center gap-2 text-xs">
      <span className={`size-1.5 rounded-full ${STATUS_DOT[status] ?? "bg-muted-foreground"}`} />
      {labels[status] ?? status}
    </span>
  );
}

function formatTriggered(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Map a card's live Kanban status onto the equivalent run status so the run
// badge/dot reflects post-run transitions. Returns null for statuses that don't
// correspond to a run state (draft/todo/trashed) — caller falls back to the run snapshot.
function runStatusFromCard(status: KanbanStatus): AgentRun["status"] | null {
  switch (status) {
    case "in_progress":
      return "running";
    case "waiting_feedback":
      return "needs_feedback";
    case "awaiting_review":
      return "awaiting_review";
    case "done":
      return "completed";
    default:
      return null;
  }
}

// A run's status is a snapshot from when the agent stopped. For the card's most
// recent run, the card's live status is the source of truth (e.g. approved →
// done); failures always stay visible. Older runs keep their snapshot.
function displayRunStatus(card: KanbanCard, run: AgentRun, isLatest: boolean): AgentRun["status"] {
  if (run.status === "failed") return "failed";
  if (isLatest) return runStatusFromCard(card.status) ?? run.status;
  return run.status;
}

function RunStatusBadge({ status }: { status: AgentRun["status"] }) {
  const t = useTranslations("logs");
  const variants: Record<
    AgentRun["status"],
    { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
  > = {
    running: { label: t("status.running"), variant: "default" },
    needs_feedback: { label: t("status.needsYou"), variant: "outline" },
    awaiting_review: { label: t("status.needsYou"), variant: "outline" },
    completed: { label: t("status.completed"), variant: "default" },
    failed: { label: t("status.failed"), variant: "destructive" },
  };
  const v = variants[status] ?? { label: status, variant: "outline" as const };
  return (
    <Badge variant={v.variant} className="text-[10px]">
      {v.label}
    </Badge>
  );
}

function formatDuration(start: string, end: string): string {
  const ms = Date.parse(end) - Date.parse(start);
  if (Number.isNaN(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function LogsPage() {
  // useSearchParams() requires a Suspense boundary for the static export
  // (next build) to prerender this route.
  return (
    <Suspense fallback={null}>
      <LogsPageInner />
    </Suspense>
  );
}
