"use client";

import { useState } from "react";

import { CheckCircle2Icon, GitBranchIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGithub } from "@/hooks/use-github";
import { openExternal } from "@/lib/tauri";

/**
 * Settings → GitHub. Shows connection status and drives sign-in via the `gh`
 * CLI (opening the browser login when needed) plus sign-out.
 */
export function GithubPanel() {
  const t = useTranslations("settings.github");
  const { status, loading, connect, startConnect, cancelConnect, logout } = useGithub();
  const [dialogOpen, setDialogOpen] = useState(false);

  const openConnect = () => {
    setDialogOpen(true);
    void startConnect().then((ok) => {
      if (ok) {
        setDialogOpen(false);
        toast.success(t("connected"));
      }
    });
  };

  const closeConnect = () => {
    cancelConnect();
    setDialogOpen(false);
  };

  const handleLogout = async () => {
    try {
      await logout();
      toast.success(t("disconnected"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitBranchIcon className="size-4" />
          {t("title")}
        </CardTitle>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            {t("checking")}
          </div>
        ) : status.connected ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2Icon className="size-4 text-green-500" />
              <span>{t("signedInAs", { login: status.login ?? "" })}</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => void handleLogout()}>
              {t("disconnect")}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground text-sm">{t("notConnected")}</span>
            <Button size="sm" onClick={openConnect}>
              <GitBranchIcon className="size-3.5" />
              {t("connect")}
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={(o) => (o ? undefined : closeConnect())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialog.title")}</DialogTitle>
            <DialogDescription>{t("dialog.description")}</DialogDescription>
          </DialogHeader>

          {connect.needsGh ? (
            <div className="space-y-2">
              <p className="text-destructive text-sm">{t("dialog.needsGh")}</p>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => void openExternal("https://cli.github.com/")}
              >
                {t("dialog.installGh")}
              </Button>
            </div>
          ) : connect.phase === "error" ? (
            <p className="text-destructive text-sm">{t("dialog.error", { error: connect.error ?? "" })}</p>
          ) : connect.phase === "awaiting" ? (
            <div className="space-y-3">
              <p className="text-muted-foreground text-sm">{t("dialog.browserInstructions")}</p>
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2Icon className="size-4 animate-spin" />
                {t("dialog.waiting")}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2Icon className="size-4 animate-spin" />
              {t("dialog.starting")}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeConnect}>
              {t("dialog.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
