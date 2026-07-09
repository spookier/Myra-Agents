"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRouter, useSearchParams } from "next/navigation";

import { CircleStopIcon, FolderIcon, PlayIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { HeaderActions } from "@/app/(main)/_components/header-actions";
import { ConversationView } from "@/components/conversation/conversation-view";
import { ReviewComposer } from "@/components/conversation/review-composer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useKanban } from "@/hooks/use-kanban";
import { useRunStartedToast } from "@/hooks/use-run-started-toast";
import { useSchedules } from "@/hooks/use-schedules";
import { useSettings } from "@/hooks/use-settings";
import { parseGlobalId } from "@/lib/aggregate/global-id";
import { connectionManager } from "@/lib/connections/manager";
import { parseTranscript, threadUserTurn } from "@/lib/conversation/parse";
import { requestChangeNotes } from "@/lib/conversation/request-changes";
import type { TranscriptEntry } from "@/lib/conversation/types";
import { effortOf } from "@/lib/history/past-runs";
import { invokeOn } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useBoardStore } from "@/stores/board-store";
import { useBreadcrumbOverride } from "@/stores/breadcrumb-store";
import type { AgentRun } from "@/types/kanban";
import type { ScheduledTask } from "@/types/schedule";

/**
 * "Agent discussion" view (Figma `agent-session`) — the per-run detail behind a
 * History row (`/history/run?card=&run=`). Modeled on the Logs run detail: the
 * same meta line, "Open working dir", chat-style {@link ConversationView}, and
 * {@link ReviewComposer}. History keeps its own top bar (breadcrumb + a Settings
 * shortcut to the owning schedule + a re-run action).
 */
export default function AgentSessionPage() {
  // useSearchParams() needs a Suspense boundary in the static export.
  return (
    <Suspense fallback={null}>
      <AgentSessionScreen />
    </Suspense>
  );
}

function AgentSessionScreen() {
  const t = useTranslations("agentSession");
  const router = useRouter();
  const params = useSearchParams();
  const cardId = params.get("card") ?? "";

  const { cards, moveCard, addRevisionNote, answerFeedback, launchAgent, cancelAgent } = useKanban();
  // Live updates are global now (the board store self-subscribes to
  // `agent-result-changed` + `agent-log-appended`): the card's status flips the
  // instant a run finishes/asks for feedback, and the run log streams in via the
  // store's `logs` map. We only read the live log tail here.
  const logs = useBoardStore((s) => s.logs);
  const { schedules, triggerNow } = useSchedules();
  const { settings } = useSettings();
  const showRunStarted = useRunStartedToast();

  const card = useMemo(() => cards.find((c) => c.id === cardId), [cards, cardId]);
  // The view renders the card's *entire* conversation — every run in order — so
  // a reply continues the thread in place instead of opening a fresh run
  // screen. The latest run drives the header/status/live-tail; the `?run=`
  // param now only picks which card's conversation to open.
  const runHistory = useMemo(
    () => (card?.runHistory ? [...card.runHistory].sort((a, b) => a.startedAt.localeCompare(b.startedAt)) : []),
    [card?.runHistory],
  );
  const run: AgentRun | undefined = runHistory[runHistory.length - 1];

  // The owning schedule (drives the "Settings" shortcut). Schedule ids are
  // connection-scoped; the card stores the raw task id — match on suffix too.
  const schedule: ScheduledTask | undefined = useMemo(() => {
    const linked = card?.linkedTaskId;
    if (!linked) return undefined;
    return schedules.find((s) => s.id === linked || s.id.endsWith(`:${linked}`) || s.id.endsWith(linked));
  }, [schedules, card?.linkedTaskId]);

  const modelName = settings.agents.find((a) => a.id === (card?.agentPresetId ?? settings.defaultAgentId))?.name ?? "—";
  const effort = effortOf(card?.agentFlags);

  // Fetched log snapshot per run id (`get_run_log`, the same backend command
  // Logs uses). The live tail (below) is layered onto the latest run while it
  // streams; a failed fetch falls back to the run's stored result at parse time.
  const [runLogs, setRunLogs] = useState<Map<string, string>>(new Map());
  const [loadingLog, setLoadingLog] = useState(false);

  // Live log tail. `get_run_log` gives the history once on entry; new lines then
  // arrive via `agent-log-appended` (board store `logs`). To avoid double-rendering
  // the lines that were already in the fetched snapshot, we record how many live
  // lines had accumulated at fetch time and only append the ones after it.
  const liveLines = useMemo(() => (card ? (logs.get(card.id) ?? []) : []), [logs, card]);
  const liveLinesRef = useRef(liveLines);
  liveLinesRef.current = liveLines;
  const liveBaselineRef = useRef(0);

  // Register this card as having a live viewer. `agent-log-appended` is gated on
  // the backend to watched cards only (headless/scheduled runs elsewhere stay
  // quiet), so without this the run log wouldn't stream in. Cleared on unmount.
  useEffect(() => {
    if (!cardId) return;
    void connectionManager.setLogWatch([cardId]);
    return () => {
      void connectionManager.setLogWatch([]);
    };
  }, [cardId]);

  // Optimistic "stopping" flag: flips the badge + button the instant Stop is
  // clicked, before the backend's status push (agent-result-changed) arrives.
  // Cleared automatically once the real run status leaves "running".
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (run && run.status !== "running") setStopping(false);
  }, [run]);
  // Fetch every run's log snapshot when the set of runs changes (a new reply
  // adds a run id). Keyed on the id list, not the card object, so ordinary card
  // mutations (status flips, live-log ticks) don't refetch and reset the tail.
  const runIdsKey = runHistory.map((r) => r.id).join(",");
  useEffect(() => {
    if (!cardId || !runIdsKey) return;
    // Iterate the id digest (not the runHistory array) so the effect only
    // refires when the set of runs changes — ordinary card mutations keep a
    // stable key, so they don't refetch and reset the live-tail baseline.
    const ids = runIdsKey.split(",");
    let cancelled = false;
    setLoadingLog(true);
    const { connId, entityId } = parseGlobalId(cardId);
    void Promise.all(
      ids.map((id) =>
        invokeOn<string>(connId, "get_run_log", { cardId: entityId, runId: id })
          .then((log) => [id, log] as const)
          .catch(() => [id, ""] as const),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      // Snapshots fetched: anything already streamed is part of them — only the
      // live tail past this point layers onto the latest (running) run.
      liveBaselineRef.current = liveLinesRef.current.length;
      setRunLogs(new Map(pairs));
      setLoadingLog(false);
    });
    return () => {
      cancelled = true;
    };
  }, [cardId, runIdsKey]);

  const running = run?.status === "running";

  // The live tail (past the fetch baseline) layers onto the latest run while
  // it streams; finished runs render from their static snapshot.
  const liveTail = liveLines.slice(liveBaselineRef.current).join("\n");

  // One continuous transcript across every run: each run contributes its
  // triggering turn (the original task, or the reply note for a resume) plus
  // its assistant output, in order.
  const transcript = useMemo(() => {
    const entries: TranscriptEntry[] = [];
    runHistory.forEach((r, i) => {
      const isLatest = i === runHistory.length - 1;
      const base = runLogs.get(r.id) ?? null;
      const log = isLatest && running && liveTail ? [base ?? "", liveTail].filter(Boolean).join("\n") : base;
      entries.push(...parseTranscript(log, r, { userTurn: threadUserTurn(r.prompt) }).entries);
    });
    return { entries, structured: true };
  }, [runHistory, runLogs, running, liveTail]);

  // Keep the live view pinned to the latest output while the agent is running.
  // Re-runs as the transcript grows (entryCount) so each new line scrolls in.
  const bottomRef = useRef<HTMLDivElement>(null);
  const entryCount = transcript.entries.length;
  useEffect(() => {
    if (running && entryCount) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [running, entryCount]);

  useBreadcrumbOverride(card ? { label: card.title } : null);

  const openWorkingDir = useCallback(async () => {
    if (!card) return;
    const { connId, entityId } = parseGlobalId(card.id);
    try {
      await invokeOn(connId, "open_card_working_dir", { cardId: entityId });
    } catch (e) {
      toast.error(String(e));
    }
  }, [card]);

  if (!card || !run) {
    return (
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-3">
        <p className="text-sm text-text-secondary">{t("notFound")}</p>
        <button
          type="button"
          onClick={() => router.push("/history")}
          className="text-text-tertiary text-xs underline-offset-2 transition-colors hover:text-text-primary hover:underline"
        >
          {t("backToHistory")}
        </button>
      </div>
    );
  }

  // "Request changes" feedback collected on this card. When the finished run
  // came from a patrol, the review footer offers to fold it back into the
  // patrol's definition (the edit page picks it up via `?suggest=`).
  const requestChanges = requestChangeNotes(card);
  const patrolId = schedule?.id ?? card.linkedTaskId;

  const onRerun = async () => {
    if (!schedule) return;
    try {
      const newRunId = await triggerNow(schedule.id);
      showRunStarted(newRunId);
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <>
      {/* Top-bar actions (Figma Frame 47): Settings shortcut + re-run. */}
      <HeaderActions>
        <div className="flex items-center gap-3">
          {schedule && (
            <button
              type="button"
              onClick={() => router.push(`/schedules/edit/?id=${encodeURIComponent(schedule.id)}`)}
              className="rounded-md bg-[var(--sidebar-item-hover-background,#e4e4e40f)] px-3 py-1 text-text-secondary text-xs transition-colors hover:text-text-primary"
            >
              {t("settings")}
            </button>
          )}
          <button
            type="button"
            onClick={onRerun}
            disabled={!schedule}
            className="text-icon-primary transition-colors hover:text-foreground disabled:opacity-40"
            aria-label={t("rerun")}
          >
            <PlayIcon className="size-[18px]" />
          </button>
        </div>
      </HeaderActions>

      <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4">
        {/* Title + status badge */}
        <div className="flex items-center gap-2">
          <h1 className="truncate font-medium text-base text-text-primary">{card.title}</h1>
          <RunStatusBadge status={run.status} stopping={stopping} />
        </div>

        {/* Meta line (Logs style) */}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-text-tertiary text-xs">
          <span>
            {t("started")}: {new Date(run.startedAt).toLocaleString()}
          </span>
          {run.endedAt && (
            <span>
              {t("ended")}: {new Date(run.endedAt).toLocaleString()}
            </span>
          )}
          {typeof run.exitCode === "number" && (
            <span>
              {t("exitCode")}: {run.exitCode}
            </span>
          )}
          {run.endedAt && (
            <span>
              {t("duration")}: {formatDuration(run.startedAt, run.endedAt)}
            </span>
          )}
          {typeof run.tokens === "number" && (
            <span>
              {t("tokens")}: {run.tokens.toLocaleString()}
            </span>
          )}
          {typeof run.cost === "number" && (
            <span>
              {t("cost")}: ${run.cost.toFixed(2)}
            </span>
          )}
          <span>
            {t("model")} {modelName}
          </span>
          {effort && (
            <span className="capitalize">
              {t("effort")} {effort}
            </span>
          )}
          <span className="inline-flex items-center gap-1" title={card.workingDir}>
            <FolderIcon className="size-3" />
            <span className="max-w-[22ch] truncate font-mono">{card.workingDir}</span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Stop only this run while it's genuinely live. `run.status` is the
              snapshot for this specific run (a finished/failed run in History has
              already exited); the card-status guard avoids stopping a relaunch. */}
          {run.status === "running" && card.status === "in_progress" && (
            <Button
              variant="destructive"
              size="sm"
              disabled={stopping}
              onClick={async () => {
                setStopping(true); // flip the UI now, before the backend confirms
                try {
                  await cancelAgent(card.id);
                  toast.success(t("stopped"));
                } catch (e) {
                  setStopping(false); // revert so the user can retry
                  toast.error(String(e));
                }
              }}
            >
              <CircleStopIcon className="size-3.5" />
              {stopping ? t("stopping") : t("stop")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={openWorkingDir}>
            <FolderIcon className="size-3.5" />
            {t("openWorkingDir")}
          </Button>
        </div>

        {/* Conversation (Logs ConversationView) */}
        <div className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="h-full">
            {loadingLog ? (
              <p className="text-text-tertiary text-sm">{t("loadingLog")}</p>
            ) : (
              <>
                <ConversationView transcript={transcript} thinking={running && !stopping} />
                <div ref={bottomRef} />
              </>
            )}
          </ScrollArea>
        </div>

        {/* Review footer — reply/approve on runs that finished or await the user. */}
        <ReviewComposer
          status={card.status}
          question={card.agentQuestion}
          pushWorkingDir={card.workingDir}
          pushTitle={card.title}
          pushBody={card.agentResult ?? card.description ?? ""}
          onApprove={async () => {
            await moveCard(card.id, "done");
            toast.success(t("approved"));
          }}
          onRevise={async (note) => {
            // Store the note, then relaunch so the reply actually reaches the
            // agent (resume = continue the previous session where supported).
            // No local toast: the global run-start toast (#239) covers it.
            await addRevisionNote(card.id, note);
            await launchAgent(card.id, undefined, { resume: true });
          }}
          onAnswer={async (answer) => {
            await answerFeedback(card.id, answer);
            await launchAgent(card.id, undefined, { resume: true });
          }}
          onReopen={async () => {
            await moveCard(card.id, "awaiting_review");
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
            await addRevisionNote(card.id, note);
            await launchAgent(card.id, undefined, { resume: true });
          }}
        />
      </div>
    </>
  );
}

/** Run status pill, colored like the History "Result" accents. */
function RunStatusBadge({ status, stopping }: { status: AgentRun["status"]; stopping?: boolean }) {
  const t = useTranslations("agentSession");
  const map: Record<
    AgentRun["status"],
    { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
  > = {
    running: { label: t("result.running"), variant: "default" },
    needs_feedback: { label: t("result.needsYou"), variant: "outline" },
    awaiting_review: { label: t("result.needsYou"), variant: "outline" },
    completed: { label: t("result.success"), variant: "default" },
    failed: { label: t("result.failed"), variant: "destructive" },
  };
  // Optimistic override: as soon as Stop is clicked, show "Stopping…" instead of
  // the stale "Running" until the backend confirms the new status.
  const v =
    stopping && status === "running"
      ? { label: t("result.stopping"), variant: "secondary" as const }
      : (map[status] ?? { label: status, variant: "outline" as const });
  return (
    <Badge variant={v.variant} className={cn("text-[10px]", status === "completed" && "bg-task-status-done")}>
      {v.label}
    </Badge>
  );
}

function formatDuration(start: string, end: string): string {
  const ms = Date.parse(end) - Date.parse(start);
  if (Number.isNaN(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
