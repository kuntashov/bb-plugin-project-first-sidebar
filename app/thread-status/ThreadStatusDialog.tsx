import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getMutationErrorMessage } from "../ui/mutation-errors.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { parseConfiguredSnoozePresets, resolveConfiguredSnoozePreset } from "./snooze-presets.js";
import type { CleanupIssue, CleanupPreview, CleanupResult, SidebarRpc } from "./sidebar-rpc.js";
import type { ThreadStatus } from "./thread-status.js";

export type StatusTarget = { threadId: string } | { cleanIds: string[] };
type ActionResult = { ok: true; reclaim?: { closedTerminals: number; keptTerminals: number; stoppedRuntime: boolean }; undoToken?: string };

function CleanupIssues({ issues }: { issues: CleanupIssue[] }) {
  return issues.length > 0 && <ul className="list-disc pl-5">{issues.map((issue, index) =>
    <li key={index}>{issue.threadId} · {issue.resource} · {issue.message}</li>)}</ul>;
}

function CleanupReport({ result }: { result: CleanupResult }) {
  const ports = (items: CleanupResult["remainingPorts"]) =>
    items.map(item => item.threadId + " / " + item.port).join(", ") || "—";
  return <div role="status" className="space-y-1 text-sm">
    <p>Закрыто терминалов: {result.closedTerminals}</p>
    <p>Отправлен сигнал портам: {ports(result.signalledPorts)}</p>
    <p>Продолжают слушать: {ports(result.remainingPorts)}</p>
    <p>Пропущено: {result.skipped.length}</p><CleanupIssues issues={result.skipped} />
    <p>Ошибки: {result.failed.length}</p><CleanupIssues issues={result.failed} />
  </div>;
}

export function ThreadStatusDialog({ target, thread, status, presets, available, rpc, refresh, close }: {
  target: StatusTarget;
  thread?: SidebarThread;
  status?: ThreadStatus;
  presets?: string;
  available: boolean;
  rpc: SidebarRpc;
  refresh: () => Promise<void>;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [undoToken, setUndoToken] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState("");
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const cleanIds = "cleanIds" in target ? target.cleanIds : thread ? [thread.id] : [];

  async function perform(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setFeedback("");
    try { await work(); }
    catch (error) { setError(getMutationErrorMessage({ error, fallbackMessage: "Не удалось выполнить действие в BB Sidebar." })); }
    finally { running.current = false; setBusy(false); }
  }

  function change(label: string, action: () => Promise<ActionResult>) {
    void perform(async () => {
      const response = await action();
      setUndoToken(response.undoToken);
      setPreview(null);
      setResult(null);
      setPicking(false);
      const reclaim = response.reclaim;
      setFeedback(reclaim ? label + ". Закрыто терминалов: " + reclaim.closedTerminals
        + ", сохранено: " + reclaim.keptTerminals + ". Среда выполнения " + (reclaim.stoppedRuntime ? "остановлена." : "сохранена.") : label);
      await refresh();
    });
  }

  function snooze(until: number | null) {
    const now = Date.now();
    if (!thread || until === null || !Number.isFinite(until) || until <= now || until > now + 365 * 86_400_000) {
      setError("Выберите время в будущем в пределах года.");
      return;
    }
    change("Snoozed до " + new Date(until).toLocaleString(), () => rpc.snooze(thread.id, until));
  }

  function requestPreview() {
    void perform(async () => {
      setResult(null);
      setPreview(null);
      setPreview(await rpc.preview(cleanIds));
    });
  }
  function confirmClean() {
    if (!preview) return;
    void perform(async () => {
      // The server consumes and revalidates this preview. A retry needs a fresh token.
      setPreview(null);
      setResult(await rpc.clean(preview.token));
      await refresh();
    });
  }
  const hasResources = preview?.threads.some(t => t.terminalCount > 0 || t.ports.length > 0);
  const cleanAllowed = "cleanIds" in target || status?.group === "Settled";
  const unknownThread = "threadId" in target && !status;
  return <Dialog open onOpenChange={open => { if (!open && !running.current) close(); }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{"threadId" in target ? "Статус треда" : "Clean · Settled"}</DialogTitle>
        <DialogDescription>{thread?.displayTitle ?? ("cleanIds" in target ? "Выбрано тредов: " + cleanIds.length : "Тред недоступен")}</DialogDescription>
      </DialogHeader>
      {status && <p>{status.label}{status.group !== status.label ? " · " + status.group : ""}
        {status.woke ? " · Woke" : ""}{status.group === "Snoozed" && status.until ? " · " + new Date(status.until).toLocaleString() : ""}</p>}
      {!available && <p role="alert">Для действий нужен включённый BB Sidebar. <button className="underline" onClick={() => void refresh()}>Проверить связь</button></p>}
      <fieldset disabled={busy || !available || unknownThread} className="min-w-0 space-y-3">
        {thread && status && <div className="flex flex-wrap gap-2">
          {status.group === "Parked" && <Button size="sm" onClick={() => change("Тред возобновлён", () => rpc.resume(thread.id))}>Resume</Button>}
          {status.group === "Snoozed" && <Button size="sm" onClick={() => change("Snooze снят", () => rpc.unsnooze(thread.id))}>Unsnooze</Button>}
          {status.group === "Settled" && <Button size="sm" onClick={() => change("Settled снят", () => rpc.unsettle(thread.id, undoToken))}>Unsettle</Button>}
          {status.woke && <Button size="sm" onClick={() => change("Пробуждение отмечено", () => rpc.acknowledgeWake(thread.id))}>Отметить Woke</Button>}
          {status.group !== "Parked" && <Button size="sm" variant="outline" disabled={!status.canPark} onClick={() => change("Parked", () => rpc.park(thread.id))}>Park</Button>}
          {status.group !== "Settled" && <Button size="sm" variant="outline" disabled={!status.canPark} onClick={() => change("Settled", () => rpc.settle(thread.id))}>Settle</Button>}
          <Button size="sm" variant="outline" disabled={!status.canPark} aria-expanded={picking} onClick={() => setPicking(!picking)}>Snooze</Button>
        </div>}
        {thread && picking && status?.canPark && <div className="space-y-2">
          <div className="flex flex-wrap gap-1">{parseConfiguredSnoozePresets(presets ?? "").map(p =>
            <Button key={p.id} size="sm" variant="secondary" disabled={resolveConfiguredSnoozePreset(p) === null}
              onClick={() => snooze(resolveConfiguredSnoozePreset(p))}>{p.label}</Button>)}</div>
          <label className="block text-sm">Дата и время<Input type="datetime-local" value={picked} onChange={e => setPicked(e.target.value)} /></label>
          <Button size="sm" variant="outline" disabled={!picked} onClick={() => snooze(new Date(picked).getTime())}>Отложить до выбранного времени</Button>
        </div>}
        {cleanAllowed && !preview && <Button size="sm" variant="outline" onClick={requestPreview}>Clean · предпросмотр</Button>}
        {preview && <div className="space-y-2 text-sm">
          <p>Clean закроет перечисленные терминалы и отправит сигнал процессам на указанных портах.</p>
          <ul>{preview.threads.map(t => <li key={t.threadId}>{t.title} · терминалов: {t.terminalCount} · порты: {t.ports.join(", ") || "—"}</li>)}</ul>
          {preview.skipped.length > 0 && <><p>Пропущено: {preview.skipped.length}</p><CleanupIssues issues={preview.skipped} /></>}
          {hasResources ? <Button size="sm" variant="destructive" disabled={!cleanAllowed} onClick={confirmClean}>Подтвердить Clean</Button> : <p>Нет ресурсов для очистки.</p>}
          <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Отменить предпросмотр</Button>
        </div>}
      </fieldset>
      {busy && <p role="status">Выполняется…</p>}
      {feedback && <p role="status" className="text-sm">{feedback}</p>}
      {result && <CleanupReport result={result} />}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </DialogContent>
  </Dialog>;
}
