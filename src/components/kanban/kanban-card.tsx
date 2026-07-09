"use client";

import { useEffect, useState } from "react";

import { useSortable } from "@dnd-kit/sortable";
import { ClipboardCheckIcon, MessageSquareIcon, PencilIcon, ScrollTextIcon, TrashIcon, ZapIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { GithubPushAction } from "@/components/kanban/github-push-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { MyraThinking } from "@/components/ui/myra-thinking";
import { useConnections } from "@/hooks/use-connections";
import { parseGlobalId } from "@/lib/aggregate/global-id";
import { tagClassName } from "@/lib/kanban-tags";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { KanbanCard } from "@/types/kanban";
import { COLUMN_CONFIG } from "@/types/kanban";
import type { ScheduledTask } from "@/types/schedule";

// Statuses whose cards carry an agent run — body click opens the conversation
// rather than the edit modal (the pencil button still edits).
const CONVERSATION_STATUSES = new Set(["in_progress", "waiting_feedback", "awaiting_review", "done"]);

interface KanbanCardProps {
  card: KanbanCard;
  /** Stop was clicked; show an instant "Stopping…" state until the backend confirms. */
  isCancelling?: boolean;
  onEdit: () => void;
  onTrash: () => void;
  onReview: () => void;
  /** Open the agent conversation for this card (active/done columns). */
  onOpenConversation?: () => void;
  onViewLogs?: () => void;
  logLines?: string[];
  schedule?: ScheduledTask;
  isOverlay?: boolean;
  isShaking?: boolean;
  noDrag?: boolean;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
}

export function KanbanCardComponent({
  card,
  isCancelling = false,
  onEdit,
  onTrash,
  onReview,
  onOpenConversation,
  onViewLogs,
  logLines,
  schedule,
  isOverlay = false,
  isShaking = false,
  noDrag = false,
  selected = false,
  onSelectedChange,
}: KanbanCardProps) {
  const t = useTranslations("kanban.card");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { card, type: "card", status: card.status },
    disabled: noDrag ? true : isOverlay,
  });

  const style = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
      : undefined,
    transition,
  };

  const { connections } = useConnections();
  const config = COLUMN_CONFIG[card.status];
  const isTrashed = card.status === "trashed";
  // Only tag cards by origin server once more than one connection is active.
  const originLabel =
    connections.length > 1 ? connections.find((c) => c.id === parseGlobalId(card.id).connId)?.label : undefined;
  const hasFooter = [
    card.tags.length > 0,
    Boolean(card.agentPrompt),
    schedule !== undefined,
    Boolean(originLabel),
  ].some(Boolean);

  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  // Active/done cards open the agent conversation on body click; others edit.
  const handleBodyClick = onOpenConversation && CONVERSATION_STATUSES.has(card.status) ? onOpenConversation : onEdit;

  // Finished-run cards with a local working dir can push their result to GitHub
  // (open/update a PR). Desktop-only (needs the Tauri shell); placement below
  // scopes it to the awaiting_review action block.
  const canPushToGithub = isTauri() && Boolean(card.workingDir);

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      data-kanban-card
      size="sm"
      onClick={isOverlay ? undefined : stop(handleBodyClick)}
      className={cn(
        "group cursor-grab active:cursor-grabbing select-none transition-all duration-200",
        isDragging && !isOverlay && "opacity-30",
        isOverlay && "shadow-lg rotate-1 scale-105",
        isShaking && "animate-pulse border-destructive",
        isTrashed && "opacity-60",
        selected && "ring-2 ring-primary/50",
      )}
    >
      <CardContent className="p-3 space-y-2">
        {/* Status dot + title row */}
        <div className="flex items-start gap-2">
          {!isOverlay && onSelectedChange && (
            <Checkbox
              checked={selected}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onCheckedChange={(checked) => onSelectedChange(checked === true)}
              aria-label={t("selectCard", { title: card.title })}
              className="mt-0.5"
            />
          )}
          <div className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${config.accentBar}`} />
          <div className="flex-1 min-w-0">
            <p className={cn("text-sm font-medium leading-snug", isTrashed && "line-through text-muted-foreground")}>
              {card.title}
            </p>
          </div>

          {/* Hover actions */}
          {!isOverlay && (
            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              {/* Only draft tasks are editable — hide the pencil elsewhere. */}
              {card.status === "draft" && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={stop(onEdit)}
                  title={t("editCard")}
                >
                  <PencilIcon />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={stop(onTrash)}
                title={t("moveToTrash")}
              >
                <TrashIcon />
              </Button>
            </div>
          )}
        </div>

        {/* Description */}
        {card.description && <p className="text-xs text-muted-foreground line-clamp-2 pl-4">{card.description}</p>}

        {/* Queued: waiting for a free concurrency slot */}
        {!isOverlay && card.agentQueued && card.status !== "in_progress" && (
          <div className="flex items-center gap-1.5 pl-4 pt-2 border-t">
            <span
              className={cn("size-2 rounded-full animate-pulse", isCancelling ? "bg-muted-foreground" : "bg-amber-500")}
            />
            <span
              className={cn(
                "text-[10px] font-semibold uppercase tracking-wider",
                isCancelling ? "text-muted-foreground" : "text-amber-600",
              )}
            >
              {isCancelling ? t("stopping") : t("queued")}
            </span>
          </div>
        )}

        {/* In progress: live timer + logs */}
        {!isOverlay && card.status === "in_progress" && (
          <InProgressBlock
            card={card}
            logLines={logLines}
            onViewLogs={onViewLogs}
            stop={stop}
            isCancelling={isCancelling}
          />
        )}

        {/* Waiting feedback */}
        {!isOverlay && card.status === "waiting_feedback" && card.agentQuestion && (
          <div className="pl-4 pt-2 border-t space-y-2">
            <div className="flex items-center gap-1.5">
              <MessageSquareIcon className="size-3 text-purple-500" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-500">
                {t("question")}
              </span>
            </div>
            <p data-ph-no-capture className="text-xs text-muted-foreground italic line-clamp-2">
              &ldquo;{card.agentQuestion}&rdquo;
            </p>
            <Button
              size="xs"
              variant="default"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={stop(onOpenConversation ?? onReview)}
              className="w-full"
            >
              {t("answerFeedback")}
            </Button>
          </div>
        )}

        {/* Awaiting review */}
        {!isOverlay && card.status === "awaiting_review" && (
          <div className="pl-4 pt-2 border-t space-y-2">
            {card.agentResult && (
              <p data-ph-no-capture className="text-xs text-muted-foreground line-clamp-2">
                {card.agentResult}
              </p>
            )}
            <Button
              size="xs"
              variant="secondary"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={stop(onOpenConversation ?? onReview)}
              className="w-full"
            >
              <ClipboardCheckIcon className="size-3" />
              {t("review")}
            </Button>
            {canPushToGithub && card.workingDir && (
              // biome-ignore lint/a11y/noStaticElementInteractions: wrapper only stops drag/body-click bubbling
              // biome-ignore lint/a11y/useKeyWithClickEvents: wrapper is not interactive; it only stops event bubbling
              <div onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                <GithubPushAction
                  workingDir={card.workingDir}
                  defaultTitle={card.title}
                  defaultBody={card.agentResult ?? card.description ?? ""}
                  buttonSize="xs"
                  buttonClassName="w-full"
                />
              </div>
            )}
          </div>
        )}

        {/* Footer: tags + agent badge */}
        {hasFooter && (
          <div className="flex flex-wrap items-center gap-1 pl-4 pt-2 border-t">
            {originLabel && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {originLabel}
              </Badge>
            )}
            {card.tags.map((tag) => (
              <Badge key={tag} variant="outline" className={tagClassName(tag, "px-1.5 py-0 text-[10px]")}>
                {tag}
              </Badge>
            ))}

            {card.revisionNotes && card.revisionNotes.length > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                ↺ v{card.revisionNotes.length + 1}
              </Badge>
            )}

            {card.agentPrompt && (
              <Badge className="text-[10px] px-1.5 py-0 ml-auto bg-orange-500/10 text-orange-600 border-orange-500/20">
                <ZapIcon className="size-2.5" />
                {t("agent")}
              </Badge>
            )}

            {schedule && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                ⏱ {schedule.schedule.type}
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── In-Progress sub-component ──

interface InProgressBlockProps {
  card: KanbanCard;
  logLines?: string[];
  onViewLogs?: () => void;
  stop: (fn: () => void) => (e: React.MouseEvent) => void;
  isCancelling?: boolean;
}

function InProgressBlock({ card, logLines, onViewLogs, stop, isCancelling = false }: InProgressBlockProps) {
  const t = useTranslations("kanban.card");
  const [elapsed, setElapsed] = useState("0s");

  useEffect(() => {
    if (!card.agentRunStartedAt) return;
    const tick = () => {
      const start = Date.parse(card.agentRunStartedAt!);
      const s = Math.max(0, Math.round((Date.now() - start) / 1000));
      setElapsed(
        s < 60
          ? `${s}s`
          : s < 3600
            ? `${Math.floor(s / 60)}m ${s % 60}s`
            : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`,
      );
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [card.agentRunStartedAt]);

  const tail = (logLines ?? []).slice(-4);

  return (
    <div className="pl-4 pt-2 border-t space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            {!isCancelling && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-500 opacity-60" />
            )}
            <span
              className={cn(
                "relative inline-flex rounded-full h-2 w-2",
                isCancelling ? "bg-muted-foreground animate-pulse" : "bg-orange-500",
              )}
            />
          </span>
          <span
            className={cn(
              "text-[10px] font-semibold uppercase tracking-wider",
              isCancelling ? "text-muted-foreground" : "text-orange-600",
            )}
          >
            {isCancelling ? t("stopping") : t("running")}
          </span>
        </div>
        <span className="text-[10px] tabular-nums text-muted-foreground">{elapsed}</span>
      </div>

      {tail.length > 0 ? (
        <div
          data-ph-no-capture
          className="bg-foreground/95 text-background/85 font-mono text-[10px] leading-snug p-2 rounded max-h-20 overflow-hidden"
        >
          {tail.map((line, i) => (
            <div key={i} className={cn("truncate", line.startsWith("[err]") && "text-red-400")}>
              {line || "\u00a0"}
            </div>
          ))}
        </div>
      ) : (
        <MyraThinking messages={t.raw("thinkingMessages") as string[]} />
      )}

      {onViewLogs && (
        <Button
          variant="outline"
          size="xs"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={stop(onViewLogs)}
          className="w-full"
        >
          <ScrollTextIcon className="size-3" />
          {t("viewLogs")}
        </Button>
      )}
    </div>
  );
}
