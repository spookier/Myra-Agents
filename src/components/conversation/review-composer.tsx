"use client";

// Inline reply box shown at the bottom of a run's conversation — mirroring how
// you'd answer Claude. Three modes:
//   awaiting_review  → approve, or send a revision note for rework (relaunches)
//   waiting_feedback → answer the agent's question (relaunches the run)
//   done             → follow-up reply that reopens + relaunches the run
// The relaunch itself is owned by the caller (onRevise/onAnswer/onFollowUp).

import { useState } from "react";

import { CheckCircle2Icon, CheckIcon, LightbulbIcon, RotateCcwIcon, SendIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { GithubPushAction } from "@/components/kanban/github-push-action";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { isTauri } from "@/lib/tauri";
import type { KanbanStatus } from "@/types/kanban";

interface Props {
  status: KanbanStatus;
  question?: string;
  onApprove: () => Promise<void>;
  onRevise: (note: string) => Promise<void>;
  onAnswer: (answer: string) => Promise<void>;
  onReopen: () => Promise<void>;
  /**
   * Shown on a finished (done) run whose card collected "Request changes"
   * feedback — offers to fold that feedback back into the source patrol.
   * Omit to hide (no source patrol, or no change was requested).
   */
  onSuggestPatrol?: () => void;
  /**
   * Card working directory. When set (and running under Tauri), the composer
   * shows a "Push to GitHub" action for awaiting-review and done runs.
   */
  pushWorkingDir?: string;
  pushTitle?: string;
  pushBody?: string;
  /** Reply on a finished (done) run: relaunches the agent with the message. */
  onFollowUp: (note: string) => Promise<void>;
}

export function ReviewComposer({
  status,
  question,
  onApprove,
  onRevise,
  onAnswer,
  onReopen,
  onSuggestPatrol,
  onFollowUp,
  pushWorkingDir,
  pushTitle,
  pushBody,
}: Props) {
  const t = useTranslations("logs.conversation.review");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setText("");
    } finally {
      setBusy(false);
    }
  };

  const canPush = isTauri() && Boolean(pushWorkingDir);
  const pushAction =
    canPush && pushWorkingDir ? (
      <GithubPushAction
        workingDir={pushWorkingDir}
        defaultTitle={pushTitle ?? ""}
        defaultBody={pushBody ?? ""}
        buttonVariant="outline"
        buttonSize="sm"
      />
    ) : null;

  // Approved/done run: keep a permanent way to reverse the decision, plus a
  // follow-up reply box so the conversation can always be picked back up.
  if (status === "done") {
    return (
      <div className="mx-auto w-full max-w-3xl border-t pt-3">
        <div className="mb-2 flex items-center gap-2">
          <CheckCircle2Icon className="size-4 text-green-600 dark:text-green-400" />
          <span className="text-muted-foreground text-sm">{t("approvedState")}</span>
          <div className="ml-auto flex items-center gap-2">
            {pushAction}
            {onSuggestPatrol && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                title={t("suggestPatrolHint")}
                onClick={onSuggestPatrol}
              >
                <LightbulbIcon className="size-4" />
                {t("suggestPatrol")}
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => run(onReopen)}>
              <RotateCcwIcon className="size-4" />
              {t("reopen")}
            </Button>
          </div>
        </div>
        <Textarea
          data-ph-no-capture
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("followUpPlaceholder")}
          rows={3}
          disabled={busy}
        />
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={busy || !text.trim()}
            onClick={() => run(() => onFollowUp(text.trim()))}
          >
            <SendIcon className="size-4" />
            {busy ? t("sending") : t("send")}
          </Button>
        </div>
      </div>
    );
  }

  if (status !== "awaiting_review" && status !== "waiting_feedback") return null;
  const isReview = status === "awaiting_review";

  return (
    <div className="mx-auto w-full max-w-3xl border-t pt-3">
      {isReview ? (
        <p className="mb-1.5 font-medium text-muted-foreground text-xs">{t("awaitingTitle")}</p>
      ) : (
        <>
          <p className="mb-1.5 font-medium text-muted-foreground text-xs">{t("questionTitle")}</p>
          {question && <p className="mb-2 text-foreground text-sm italic">&ldquo;{question}&rdquo;</p>}
        </>
      )}

      <Textarea
        data-ph-no-capture
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={isReview ? t("revisePlaceholder") : t("answerPlaceholder")}
        rows={3}
        disabled={busy}
      />

      <div className="mt-2 flex justify-end gap-2">
        {isReview ? (
          <>
            {pushAction}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !text.trim()}
              onClick={() => run(() => onRevise(text.trim()))}
            >
              {t("requestChanges")}
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => run(onApprove)}>
              <CheckIcon className="size-4" />
              {t("approve")}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={busy || !text.trim()}
            onClick={() => run(() => onAnswer(text.trim()))}
          >
            <SendIcon className="size-4" />
            {busy ? t("sending") : t("send")}
          </Button>
        )}
      </div>
    </div>
  );
}
