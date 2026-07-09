"use client";

import { type ComponentProps, useState } from "react";

import { GitBranchIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useGithub } from "@/hooks/use-github";
import { openExternal } from "@/lib/tauri";

interface GithubPushActionProps {
  /** Resolved working directory for the card's run (card or preset). */
  workingDir: string;
  defaultTitle: string;
  defaultBody: string;
  disabled?: boolean;
  /** Trigger button variant. Defaults to "secondary". */
  buttonVariant?: ComponentProps<typeof Button>["variant"];
  /** Trigger button size. Defaults to the button's own default. */
  buttonSize?: ComponentProps<typeof Button>["size"];
  /** Extra classes for the trigger button (e.g. "w-full" on a card). */
  buttonClassName?: string;
}

/**
 * "Push to GitHub" card action: ensures the user is signed in via the `gh` CLI
 * (opening the browser login when needed), then commits + pushes a branch and
 * opens/reuses a PR with the agent result as the body. v1 targets the card's
 * **local** working directory.
 */
export function GithubPushAction({
  workingDir,
  defaultTitle,
  defaultBody,
  disabled,
  buttonVariant = "secondary",
  buttonSize,
  buttonClassName,
}: GithubPushActionProps) {
  const t = useTranslations("kanban.cardModal.github");
  const { status, connect, startConnect, cancelConnect, pushCard } = useGithub();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState(defaultBody);
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [draft, setDraft] = useState(false);
  const [pushing, setPushing] = useState(false);

  const openDialog = () => {
    setTitle(defaultTitle);
    setBody(defaultBody);
    setBranch("");
    setBaseBranch("");
    setDraft(false);
    setOpen(true);
  };

  const close = () => {
    cancelConnect();
    setOpen(false);
  };

  const handleConnect = () => {
    void startConnect();
  };

  const handlePush = async () => {
    setPushing(true);
    try {
      const res = await pushCard({
        workingDir,
        title: title.trim(),
        body,
        branch: branch.trim() || undefined,
        baseBranch: baseBranch.trim() || undefined,
        draft,
      });
      toast.success(res.reused ? t("reused", { number: res.prNumber }) : t("opened", { number: res.prNumber }), {
        action: { label: t("viewPr"), onClick: () => void openExternal(res.prUrl) },
      });
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPushing(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant={buttonVariant}
        size={buttonSize}
        className={buttonClassName}
        onClick={openDialog}
        disabled={disabled}
      >
        <GitBranchIcon className="size-3.5" />
        {t("push")}
      </Button>

      <Dialog open={open} onOpenChange={(o) => (o ? undefined : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>

          {!status.connected ? (
            <div className="space-y-3">
              {connect.needsGh ? (
                <>
                  <p className="text-destructive text-sm">{t("needsGh")}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => void openExternal("https://cli.github.com/")}
                  >
                    {t("installGh")}
                  </Button>
                </>
              ) : connect.phase === "awaiting" ? (
                <>
                  <p className="text-muted-foreground text-sm">{t("browserInstructions")}</p>
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2Icon className="size-4 animate-spin" />
                    {t("waiting")}
                  </div>
                </>
              ) : connect.phase === "error" ? (
                <p className="text-destructive text-sm">{connect.error}</p>
              ) : connect.phase === "starting" ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2Icon className="size-4 animate-spin" />
                  {t("connecting")}
                </div>
              ) : (
                <>
                  <p className="text-muted-foreground text-sm">{t("connectFirst")}</p>
                  <Button size="sm" onClick={handleConnect}>
                    <GitBranchIcon className="size-3.5" />
                    {t("connect")}
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="gh-title">{t("titleLabel")}</Label>
                <Input id="gh-title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="gh-branch">{t("branchLabel")}</Label>
                  <Input
                    id="gh-branch"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder={t("branchPlaceholder")}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="gh-base">{t("baseLabel")}</Label>
                  <Input
                    id="gh-base"
                    value={baseBranch}
                    onChange={(e) => setBaseBranch(e.target.value)}
                    placeholder={t("basePlaceholder")}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gh-body">{t("bodyLabel")}</Label>
                <Textarea id="gh-body" value={body} onChange={(e) => setBody(e.target.value)} rows={5} />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="gh-draft" checked={draft} onCheckedChange={(c) => setDraft(c === true)} />
                <Label htmlFor="gh-draft" className="text-sm">
                  {t("draftLabel")}
                </Label>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t("cancel")}
            </Button>
            {status.connected && (
              <Button onClick={() => void handlePush()} disabled={pushing || !title.trim()}>
                {pushing ? <Loader2Icon className="size-3.5 animate-spin" /> : <GitBranchIcon className="size-3.5" />}
                {pushing ? t("pushing") : t("push")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
