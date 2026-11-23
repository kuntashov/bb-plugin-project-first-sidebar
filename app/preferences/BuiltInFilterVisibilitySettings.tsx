import { useAtom } from "jotai";
import { usePreferencesReady, usePreferencesSync } from "./PreferencesSync.js";
import {
  sidebarShowProjectlessFilterAtom,
  sidebarShowUnreadFilterAtom,
  sidebarShowWaitingForActionFilterAtom,
} from "./atoms.js";

export function BuiltInFilterVisibilitySettings() {
  usePreferencesSync();
  const ready = usePreferencesReady();
  const [showProjectless, setShowProjectless] = useAtom(sidebarShowProjectlessFilterAtom);
  const [showUnread, setShowUnread] = useAtom(sidebarShowUnreadFilterAtom);
  const [showWaitingForAction, setShowWaitingForAction] = useAtom(sidebarShowWaitingForActionFilterAtom);

  const controls = [
    ["Без проектов", showProjectless, setShowProjectless],
    ["Непрочитанные", showUnread, setShowUnread],
    ["Ждут действия", showWaitingForAction, setShowWaitingForAction],
  ] as const;

  return (
    <fieldset disabled={!ready} className="flex flex-col gap-2">
      {controls.map(([label, checked, setChecked]) => (
        <label key={label} className="flex min-h-6 items-center gap-2 text-sm">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          Показывать фильтр «{label}»
        </label>
      ))}
    </fieldset>
  );
}
