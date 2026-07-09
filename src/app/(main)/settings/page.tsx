"use client";

import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";

import { buildAgentCommand } from "@myra/shared";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import {
  CheckCircle2Icon,
  CopyIcon,
  DownloadIcon,
  FlaskConicalIcon,
  Loader2Icon,
  PlusIcon,
  SaveIcon,
  SettingsIcon,
  Trash2Icon,
  TrashIcon,
  UploadIcon,
  XCircleIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { AgentOptions } from "@/components/agents/agent-options";
import { AgentInstallGate, AgentStatusBadge, useBinaryStatus } from "@/components/agents/binary-status";
import { WorkingDirField } from "@/components/agents/working-dir-field";
import { AppUpdatePanel } from "@/components/settings/app-update-panel";
import { GithubPanel } from "@/components/settings/github-panel";
import { LocalModelsPanel } from "@/components/settings/local-models-panel";
// User connection disabled — hub status, remote access and cloud sync are off.
// import { HubStatusCard } from "@/components/settings/hub-status-card";
// Integrations, Plugins and Sync are parked for now — restore the imports with their tabs below.
// import { IntegrationsPanel } from "@/components/settings/integrations/integrations-panel";
// import { LocalServerPanel } from "@/components/settings/local-server-panel";
// import { PluginsPanel } from "@/components/settings/plugins-panel";
// import { RemoteAccessPanel } from "@/components/settings/remote-access-panel";
// import { SyncPanel } from "@/components/settings/sync-panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MyraLoader, type MyraLoaderVariant } from "@/components/ui/myra-loader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
// import { useEntitlement } from "@/hooks/use-entitlement"; // user connection disabled
import { useSettings } from "@/hooks/use-settings";
import { useTheme } from "@/hooks/use-theme";
import { setAppLocale } from "@/i18n/provider";
import { loadTestResult, persistTestResult, type StoredTestResult } from "@/lib/agent-test-store";
import {
  DEFAULT_PAGE,
  type DefaultPage,
  getDefaultPageSetting,
  setDefaultPageSetting,
} from "@/lib/default-page.client";
import { getHomeFolderSetting, osHomeDir, setHomeFolderSetting } from "@/lib/home-folder.client";
import { persistPreference } from "@/lib/preferences/preferences-storage";
import { invoke, isTauri } from "@/lib/tauri";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import type { AgentPreset, AppSettings } from "@/types/settings";
import { DEFAULT_AGENT_PRESETS } from "@/types/settings";

type DataAction = "export" | "import" | "clear" | "clearHistory";

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const EXEC_FIELDS = new Set<keyof AgentPreset>([
  "binary",
  "argsTemplate",
  "flags",
  "launchVia",
  "ollamaModel",
  "useWorktree",
]);

/**
 * Every IANA timezone the runtime knows, for the preferences picker (drives the
 * nightly archive's "midnight"). Falls back to a small common set on the rare
 * runtime without `Intl.supportedValuesOf`.
 */
const TIMEZONES: string[] = (() => {
  try {
    const fn = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const zones = fn?.("timeZone");
    if (zones?.length) return zones;
  } catch {
    // fall through to the static fallback
  }
  return ["UTC", "Europe/Paris", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];
})();

interface AgentPresetCardProps {
  preset: AgentPreset;
  idx: number;
  isDefault: boolean;
  t: ReturnType<typeof useTranslations>;
  onUpdate: (idx: number, patch: Partial<AgentPreset>) => void;
  onRemove: (idx: number) => void;
  onDuplicate: (idx: number) => void;
  isDirty: boolean;
  needsTest: boolean;
  saving: boolean;
  onSave: () => Promise<void>;
}

/**
 * One agent preset row. Calls `useBinaryStatus` once so the header badge and the
 * install gate share a single `check_binary`. While the binary is a known,
 * installable CLI that isn't present, the config fields are replaced by an
 * install gate (auto / manual) — unless the user opts to configure anyway.
 */
type TestState = "idle" | "testing" | "passed" | "failed";

function AgentPresetCard({
  preset,
  idx,
  isDefault,
  t,
  onUpdate,
  onRemove,
  onDuplicate,
  isDirty,
  needsTest,
  saving,
  onSave,
}: AgentPresetCardProps) {
  const bin = useBinaryStatus(preset.binary);
  const [configureAnyway, setConfigureAnyway] = useState(false);
  const [showAdvancedArgs, setShowAdvancedArgs] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [storedResult, setStoredResult] = useState<StoredTestResult | null>(() => loadTestResult(preset.id));

  const handleTestAndSave = useCallback(async () => {
    setTestState("testing");
    try {
      await invoke("test_agent", {
        binary: preset.binary,
        argsTemplate: preset.argsTemplate,
        flags: preset.flags ?? [],
        launchVia: preset.launchVia ?? "direct",
        ollamaModel: preset.ollamaModel ?? "",
        workingDir: null,
      });
      const result: StoredTestResult = { status: "passed", ts: Date.now() };
      persistTestResult(preset.id, "passed");
      setStoredResult(result);
      setTestState("passed");
      await onSave();
    } catch (err) {
      const reason = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
      const result: StoredTestResult = { status: "failed", ts: Date.now(), reason };
      persistTestResult(preset.id, "failed", reason);
      setStoredResult(result);
      setTestState("failed");
    }
    setTimeout(() => setTestState("idle"), 3000);
  }, [preset.id, preset.binary, preset.argsTemplate, preset.flags, preset.launchVia, preset.ollamaModel, onSave]);
  // Gate only when we *can* install it (known binary) and a check confirmed it's missing.
  const gated = !configureAnyway && bin.missing && Boolean(bin.installInfo);
  // Until the first check resolves we don't know fields-or-gate — show a loading
  // row instead of flashing the config fields and swapping them out.
  const pendingCheck = !bin.resolved && Boolean(bin.installInfo);

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Label className="font-semibold text-sm">{preset.name}</Label>
          <AgentStatusBadge {...bin} />
          {storedResult && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium text-[10px] ${
                storedResult.status === "passed"
                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                  : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
              }`}
            >
              {storedResult.status === "passed" ? (
                <CheckCircle2Icon className="size-2.5" />
              ) : (
                <XCircleIcon className="size-2.5" />
              )}
              {storedResult.status === "passed" ? t("agents.testedBadge") : t("agents.testFailedBadge")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon-xs" onClick={() => onDuplicate(idx)} title={t("agents.duplicate")}>
            <CopyIcon />
          </Button>
          {!isDefault && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon-xs">
                  <TrashIcon />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("agents.removeConfirmTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("agents.removeConfirmDescription")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("agents.removeCancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => onRemove(idx)}>{t("agents.removeConfirm")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
      {pendingCheck ? (
        <div className="flex items-center justify-center gap-2 rounded-md border border-dashed px-4 py-6 text-muted-foreground text-xs">
          <Loader2Icon className="size-3.5 animate-spin" />
          {t("agents.checkingInstall")}
        </div>
      ) : gated ? (
        <AgentInstallGate state={bin} onConfigureAnyway={() => setConfigureAnyway(true)} />
      ) : (
        <>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">{t("agents.name")}</Label>
              <Input
                value={preset.name}
                onChange={(event) => onUpdate(idx, { name: event.target.value })}
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("agents.binary")}</Label>
              <Input
                value={preset.binary}
                onChange={(event) => onUpdate(idx, { binary: event.target.value })}
                className="h-7 font-mono text-xs"
              />
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-muted-foreground text-xs">{t("agents.advancedArgs")}</Label>
              <Switch checked={showAdvancedArgs} onCheckedChange={setShowAdvancedArgs} className="scale-75" />
            </div>
            {showAdvancedArgs && (
              <div className="space-y-1 pt-1">
                <Label className="text-xs">{t("agents.argsTemplate")}</Label>
                <Input
                  value={preset.argsTemplate}
                  onChange={(event) => onUpdate(idx, { argsTemplate: event.target.value })}
                  placeholder="{prompt}"
                  className="h-7 font-mono text-xs"
                />
                <p className="text-muted-foreground text-xs">{t("agents.advancedArgsHint")}</p>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("agents.options")}</Label>
            <AgentOptions
              binary={preset.binary}
              flags={preset.flags ?? []}
              useWorktree={preset.useWorktree ?? false}
              launchVia={preset.launchVia ?? "direct"}
              ollamaModel={preset.ollamaModel ?? ""}
              onFlagsChange={(flags) => onUpdate(idx, { flags })}
              onWorktreeChange={(useWorktree) => onUpdate(idx, { useWorktree })}
              onLaunchViaChange={(launchVia) => onUpdate(idx, { launchVia })}
              onOllamaModelChange={(ollamaModel) => onUpdate(idx, { ollamaModel })}
            />
          </div>
          <details className="group">
            <summary className="cursor-pointer list-none text-[11px] text-muted-foreground hover:text-foreground">
              <span className="inline-flex items-center gap-1">
                <FlaskConicalIcon className="size-3" />
                {t("agents.testCommand")}
              </span>
            </summary>
            <p className="mt-1 break-all rounded-md bg-muted px-2 py-1.5 font-mono text-[11px]">
              {(() => {
                // Mirror exactly what `test_agent` runs: flags appended + the
                // `ollama launch` wrapping for local presets. Falls back to a
                // best-effort string if the template is mid-edit (no {prompt}).
                try {
                  const { binary, args } = buildAgentCommand(
                    preset.binary,
                    preset.argsTemplate ?? "{prompt}",
                    "hello",
                    {
                      flags: preset.flags ?? [],
                      launchVia: preset.launchVia ?? "direct",
                      ollamaModel: preset.ollamaModel ?? "",
                    },
                  );
                  return [binary, ...args].filter(Boolean).join(" ");
                } catch {
                  return [
                    preset.binary,
                    (preset.argsTemplate ?? "{prompt}").replace("{prompt}", "hello"),
                    ...(preset.flags ?? []),
                  ]
                    .filter(Boolean)
                    .join(" ");
                }
              })()}
            </p>
          </details>
          {storedResult?.status === "failed" && storedResult.reason && testState === "idle" && (
            <p className="rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-[11px] text-destructive">
              {storedResult.reason}
            </p>
          )}
          {isDirty && (
            <div className="flex flex-col gap-1.5 pt-1">
              <div className="flex justify-end">
                {needsTest ? (
                  <Button
                    size="sm"
                    onClick={() => void handleTestAndSave()}
                    disabled={testState === "testing" || saving}
                    title={t("agents.testAndSaveTooltip")}
                  >
                    {testState === "testing" ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : testState === "passed" ? (
                      <CheckCircle2Icon className="size-3.5 text-green-500" />
                    ) : testState === "failed" ? (
                      <XCircleIcon className="size-3.5 text-destructive" />
                    ) : (
                      <FlaskConicalIcon className="size-3.5" />
                    )}
                    {testState === "testing"
                      ? t("agents.testing")
                      : testState === "passed"
                        ? t("agents.testPassed")
                        : testState === "failed"
                          ? t("agents.testFailed")
                          : t("agents.testAndSave")}
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void onSave()} disabled={saving}>
                    <SaveIcon className="size-3.5" />
                    {saving ? t("actions.saving") : t("actions.save")}
                  </Button>
                )}
              </div>
              {testState === "failed" && storedResult?.reason && (
                <p className="rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-[11px] text-destructive">
                  {storedResult.reason}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const t = useTranslations("settings");
  // const { isPro } = useEntitlement(); // user connection disabled
  const { settings, loading, error, save } = useSettings();
  const { setTheme } = useTheme();
  const setThemeMode = usePreferencesStore((state) => state.setThemeMode);
  const loaderVariant = usePreferencesStore((state) => state.loaderVariant);
  const setLoaderVariant = usePreferencesStore((state) => state.setLoaderVariant);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirtyPresetFields, setDirtyPresetFields] = useState<Map<number, Set<keyof AgentPreset>>>(new Map());
  const [dataAction, setDataAction] = useState<DataAction | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // Home folder is stored app-locally (not in server-persisted AppSettings) and
  // saved immediately on change. Empty = the OS home directory.
  const [homeFolder, setHomeFolderState] = useState("");
  const [osHome, setOsHome] = useState("");
  useEffect(() => {
    setHomeFolderState(getHomeFolderSetting());
    void osHomeDir().then(setOsHome);
  }, []);
  const updateHomeFolder = useCallback((v: string) => {
    setHomeFolderState(v);
    setHomeFolderSetting(v);
  }, []);

  // Default landing page is stored app-locally too (pure client navigation
  // preference; the sidecar AppSettings round-trip would drop/reject it).
  const [defaultPage, setDefaultPageState] = useState<DefaultPage>(DEFAULT_PAGE);
  useEffect(() => {
    setDefaultPageState(getDefaultPageSetting());
  }, []);
  const updateDefaultPage = useCallback((v: DefaultPage) => {
    setDefaultPageState(v);
    setDefaultPageSetting(v);
  }, []);

  // Launch-at-login lives in the OS (LaunchAgent / registry / desktop entry),
  // not in AppSettings — the autostart plugin's isEnabled() is the source of
  // truth, and toggling applies immediately. Desktop only (Tauri).
  const [openAtLogin, setOpenAtLogin] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    void isAutostartEnabled()
      .then(setOpenAtLogin)
      .catch(() => {
        // Leave the toggle off if the OS state can't be read.
      });
  }, []);
  const toggleOpenAtLogin = useCallback(
    async (checked: boolean) => {
      setOpenAtLogin(checked);
      try {
        if (checked) {
          await enableAutostart();
        } else {
          await disableAutostart();
        }
        setOpenAtLogin(await isAutostartEnabled());
      } catch (toggleError) {
        setOpenAtLogin(!checked);
        toast.error(getErrorMessage(toggleError, t("feedback.saveFailed")));
      }
    },
    [t],
  );

  const current = draft ?? settings;

  const update = useCallback(
    (patch: Partial<AppSettings>) => {
      setDraft((prev) => ({ ...(prev ?? settings), ...patch }));
    },
    [settings],
  );

  const handleSave = useCallback(async () => {
    if (!draft) return;

    setSaving(true);
    try {
      await save(draft);
      setDraft(null);
      setDirtyPresetFields(new Map());
      toast.success(t("feedback.saved"));
    } catch (saveError) {
      toast.error(getErrorMessage(saveError, t("feedback.saveFailed")));
    } finally {
      setSaving(false);
    }
  }, [draft, save, t]);

  const handleLocaleChange = (locale: string) => {
    update({ locale: locale as AppSettings["locale"] });
    setAppLocale(locale);
  };

  // Plugins tab is parked for now — restore these callbacks with it.
  // const togglePlugin = useCallback(
  //   (name: string, enabled: boolean) => {
  //     const disabled = new Set(current.disabledPlugins ?? []);
  //     if (enabled) {
  //       disabled.delete(name);
  //     } else {
  //       disabled.add(name);
  //     }
  //     update({ disabledPlugins: [...disabled] });
  //   },
  //   [current.disabledPlugins, update],
  // );

  // const updatePluginConfig = useCallback(
  //   (plugin: string, key: string, value: string | number | boolean) => {
  //     const next = { ...(current.pluginConfig ?? {}) };
  //     next[plugin] = { ...(next[plugin] ?? {}), [key]: value };
  //     update({ pluginConfig: next });
  //   },
  //   [current.pluginConfig, update],
  // );

  const handleThemeChange = (theme: string) => {
    const nextTheme = theme as AppSettings["theme"];
    update({ theme: nextTheme });
    setTheme(nextTheme);
    setThemeMode(nextTheme);
    void persistPreference("theme_mode", nextTheme);
  };

  const handleTimezoneChange = (timezone: string) => {
    update({ timezone });
  };

  const handleLoaderVariantChange = (variant: string) => {
    const next = variant as MyraLoaderVariant;
    setLoaderVariant(next);
    void persistPreference("loader_variant", next);
  };

  const handleExportBoard = useCallback(async () => {
    setDataAction("export");

    try {
      const data = await invoke<unknown>("get_cards");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `myra-agents-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t("feedback.exported"));
    } catch (exportError) {
      console.error("Failed to export board:", exportError);
      toast.error(getErrorMessage(exportError, t("feedback.exportFailed")));
    } finally {
      setDataAction(null);
    }
  }, [t]);

  const handleImportBoard = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setDataAction("import");

      try {
        const content = await file.text();
        const cards = JSON.parse(content);
        await invoke("import_cards", { cards });
        toast.success(t("feedback.imported"));
      } catch (importError) {
        console.error("Failed to import board:", importError);
        toast.error(getErrorMessage(importError, t("feedback.importFailed")));
      } finally {
        event.target.value = "";
        setDataAction(null);
      }
    },
    [t],
  );

  const handleClearRunHistory = useCallback(async () => {
    setDataAction("clearHistory");

    try {
      await invoke("clear_run_history");
      toast.success(t("feedback.historyCleared"));
    } catch (clearError) {
      console.error("Failed to clear run history:", clearError);
      toast.error(getErrorMessage(clearError, t("feedback.clearFailed")));
    } finally {
      setDataAction(null);
    }
  }, [t]);

  const handleClearLogs = useCallback(async () => {
    if (!window.confirm(t("data.clearLogsConfirm"))) {
      return;
    }

    setDataAction("clear");

    try {
      await invoke("clear_logs");
      toast.success(t("feedback.logsCleared"));
    } catch (clearError) {
      console.error("Failed to clear logs:", clearError);
      toast.error(getErrorMessage(clearError, t("feedback.clearFailed")));
    } finally {
      setDataAction(null);
    }
  }, [t]);

  const addCustomPreset = () => {
    const preset: AgentPreset = {
      id: `custom-${Date.now()}`,
      name: t("agents.customAgent"),
      binary: "",
      argsTemplate: "{prompt}",
    };
    update({ agents: [...current.agents, preset] });
  };

  const updatePreset = (idx: number, patch: Partial<AgentPreset>) => {
    // Functional update: a single interaction can patch several fields in one
    // tick (e.g. the model picker sets flags + launchVia + ollamaModel together);
    // composing on `prev` keeps every patch instead of the last write winning.
    setDraft((prev) => {
      const base = prev ?? settings;
      const agents = base.agents.map((preset, index) => (index === idx ? { ...preset, ...patch } : preset));
      return { ...base, agents };
    });
    setDirtyPresetFields((prev) => {
      const next = new Map(prev);
      const fields = new Set(next.get(idx));
      for (const k of Object.keys(patch) as (keyof AgentPreset)[]) fields.add(k);
      next.set(idx, fields);
      return next;
    });
  };

  const duplicatePreset = (idx: number) => {
    const source = current.agents[idx];
    const newId = `custom-${Date.now()}`;
    const copy: AgentPreset = { ...source, id: newId, name: `${source.name} (copy)` };
    const agents = [...current.agents];
    agents.splice(idx + 1, 0, copy);
    update({ agents });
    const existing = loadTestResult(source.id);
    if (existing) persistTestResult(newId, existing.status, existing.reason);
    setDirtyPresetFields((prev) => {
      const next = new Map<number, Set<keyof AgentPreset>>();
      for (const [k, v] of prev) {
        next.set(k <= idx ? k : k + 1, v);
      }
      return next;
    });
  };

  const removePreset = (idx: number) => {
    update({ agents: current.agents.filter((_, index) => index !== idx) });
    setDirtyPresetFields((prev) => {
      const next = new Map<number, Set<keyof AgentPreset>>();
      for (const [k, v] of prev) {
        if (k < idx) next.set(k, v);
        else if (k > idx) next.set(k - 1, v);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4">
      <div className="flex items-center gap-3">
        <SettingsIcon className="size-5 text-muted-foreground" />
        <h1 className="font-semibold text-xl tracking-tight">{t("title")}</h1>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <Tabs defaultValue="preferences" className="w-full">
        <TabsList variant="line">
          {/* Hub tab hidden — no remote enabled for now.
          <TabsTrigger value="hub">{t("tabs.hub")}</TabsTrigger>
          */}
          <TabsTrigger value="preferences">{t("tabs.preferences")}</TabsTrigger>
          <TabsTrigger value="agents">{t("tabs.agents")}</TabsTrigger>
          <TabsTrigger value="localModels">{t("tabs.localModels")}</TabsTrigger>
          <TabsTrigger value="github">{t("tabs.github")}</TabsTrigger>
          {/* Integrations, Sync and Plugins are parked for now.
          <TabsTrigger value="integrations">{t("tabs.integrations")}</TabsTrigger>
          <TabsTrigger value="sync">{t("tabs.sync")}</TabsTrigger>
          <TabsTrigger value="plugins">{t("tabs.plugins")}</TabsTrigger>
          */}
          <TabsTrigger value="data">{t("tabs.data")}</TabsTrigger>
        </TabsList>

        {/* Hub tab hidden — no remote enabled for now.
        <TabsContent value="hub" className="space-y-6">
          <ConnectionsPanel />
        </TabsContent>
        */}

        <TabsContent value="preferences" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("preferences.title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-2">
                  <Label>{t("preferences.language")}</Label>
                  <Select value={current.locale} onValueChange={handleLocaleChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t("preferences.languageOptions.autoDetect")}</SelectItem>
                      <SelectItem value="en">{t("preferences.languageOptions.english")}</SelectItem>
                      <SelectItem value="fr">{t("preferences.languageOptions.french")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>{t("preferences.defaultPage")}</Label>
                  <Select value={defaultPage} onValueChange={(value) => updateDefaultPage(value as DefaultPage)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="operations">{t("preferences.pageOptions.operations")}</SelectItem>
                      <SelectItem value="patrols">{t("preferences.pageOptions.patrols")}</SelectItem>
                      <SelectItem value="history">{t("preferences.pageOptions.history")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>{t("preferences.theme")}</Label>
                  <Select value={current.theme} onValueChange={handleThemeChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">{t("preferences.themeOptions.light")}</SelectItem>
                      <SelectItem value="dark">{t("preferences.themeOptions.dark")}</SelectItem>
                      <SelectItem value="system">{t("preferences.themeOptions.system")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    {t("preferences.loaderAnimation")}
                    <MyraLoader size={16} variant={loaderVariant} className="text-primary" />
                  </Label>
                  <Select value={loaderVariant} onValueChange={handleLoaderVariantChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="shimmer">{t("preferences.loaderOptions.shimmer")}</SelectItem>
                      <SelectItem value="assemble">{t("preferences.loaderOptions.assemble")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">{t("preferences.loaderAnimationHint")}</p>
                </div>

                <div className="space-y-2">
                  <Label>{t("preferences.timezone")}</Label>
                  <Select value={current.timezone ?? "Europe/Paris"} onValueChange={handleTimezoneChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz} value={tz}>
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">{t("preferences.timezoneHint")}</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t("preferences.homeFolder")}</Label>
                <WorkingDirField value={homeFolder} onChange={updateHomeFolder} placeholder={osHome || "~"} />
                <p className="text-muted-foreground text-xs">{t("preferences.homeFolderHint")}</p>
              </div>

              {isTauri() && (
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label>{t("preferences.openAtLogin")}</Label>
                    <p className="text-muted-foreground text-xs">{t("preferences.openAtLoginHint")}</p>
                  </div>
                  <Switch checked={openAtLogin} onCheckedChange={(checked) => void toggleOpenAtLogin(checked)} />
                </div>
              )}
            </CardContent>
          </Card>

          <AppUpdatePanel />
        </TabsContent>

        <TabsContent value="agents" className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">{t("agents.title")}</CardTitle>
              <Button variant="outline" size="sm" onClick={addCustomPreset}>
                <PlusIcon className="size-3" />
                {t("agents.add")}
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>{t("agents.defaultAgent")}</Label>
                <Select value={current.defaultAgentId} onValueChange={(value) => update({ defaultAgentId: value })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {current.agents.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>{t("agents.maxConcurrent")}</Label>
                <Input
                  type="number"
                  min={0}
                  value={current.maxConcurrentAgents}
                  onChange={(event) => update({ maxConcurrentAgents: Math.max(0, Number(event.target.value) || 0) })}
                  className="h-8 w-28"
                />
                <p className="text-muted-foreground text-xs">{t("agents.maxConcurrentHint")}</p>
              </div>

              <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <Label>{t("agents.keepAwake")}</Label>
                  <p className="text-muted-foreground text-xs">{t("agents.keepAwakeHint")}</p>
                </div>
                <Switch
                  checked={current.keepAwakeWhileRunning !== false}
                  onCheckedChange={(checked) => update({ keepAwakeWhileRunning: checked })}
                />
              </div>

              <Separator />

              {current.agents.map((preset, idx) => (
                <AgentPresetCard
                  key={preset.id}
                  preset={preset}
                  idx={idx}
                  isDefault={DEFAULT_AGENT_PRESETS.some((defaultPreset) => defaultPreset.id === preset.id)}
                  t={t}
                  onUpdate={updatePreset}
                  onRemove={removePreset}
                  onDuplicate={duplicatePreset}
                  isDirty={(dirtyPresetFields.get(idx)?.size ?? 0) > 0}
                  needsTest={[...(dirtyPresetFields.get(idx) ?? [])].some((f) => EXEC_FIELDS.has(f))}
                  saving={saving}
                  onSave={handleSave}
                />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="localModels" className="space-y-6">
          <LocalModelsPanel />
        </TabsContent>

        <TabsContent value="github" className="space-y-6">
          <GithubPanel />
        </TabsContent>

        {/* Integrations, Sync and Plugins are parked for now.
        <TabsContent value="integrations" className="space-y-6">
          <IntegrationsPanel />
        </TabsContent>

        <TabsContent value="sync" className="space-y-6">
          <SyncPanel />
        </TabsContent>

        <TabsContent value="plugins" className="space-y-6">
          <PluginsPanel
            disabledPlugins={current.disabledPlugins ?? []}
            pluginConfig={current.pluginConfig ?? {}}
            onToggle={togglePlugin}
            onConfigChange={updatePluginConfig}
          />
        </TabsContent>
        */}

        <TabsContent value="data" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("data.title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleImportBoard}
              />

              <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="font-medium">{t("data.exportBoard")}</p>
                  <p className="text-muted-foreground text-sm">{t("data.exportDescription")}</p>
                </div>
                <Button variant="outline" onClick={handleExportBoard} disabled={dataAction !== null}>
                  <DownloadIcon className="size-4" />
                  {dataAction === "export" ? t("actions.exporting") : t("data.exportBoard")}
                </Button>
              </div>

              <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="font-medium">{t("data.importBoard")}</p>
                  <p className="text-muted-foreground text-sm">{t("data.importDescription")}</p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => importInputRef.current?.click()}
                  disabled={dataAction !== null}
                >
                  <UploadIcon className="size-4" />
                  {dataAction === "import" ? t("actions.importing") : t("data.importBoard")}
                </Button>
              </div>

              <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="font-medium">{t("data.clearHistory")}</p>
                  <p className="text-muted-foreground text-sm">{t("data.clearHistoryDescription")}</p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" disabled={dataAction !== null}>
                      <Trash2Icon className="size-4" />
                      {dataAction === "clearHistory" ? t("actions.clearing") : t("data.clearHistory")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("data.clearHistoryConfirmTitle")}</AlertDialogTitle>
                      <AlertDialogDescription>{t("data.clearHistoryConfirmDescription")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("data.clearHistoryCancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void handleClearRunHistory()}>
                        {t("data.clearHistoryConfirm")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="font-medium">{t("data.clearLogs")}</p>
                  <p className="text-muted-foreground text-sm">{t("data.clearLogsDescription")}</p>
                </div>
                <Button variant="destructive" onClick={handleClearLogs} disabled={dataAction !== null}>
                  <Trash2Icon className="size-4" />
                  {dataAction === "clear" ? t("actions.clearing") : t("data.clearLogs")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
