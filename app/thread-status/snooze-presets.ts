// Adapted from bb-sidebar v0.3.7. See UPSTREAM.md and LICENSE.
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export const DEFAULT_SNOOZE_PRESET_CONFIG =
  "1h, Wait refresh (5 hours)=5h, evening@18:00, tomorrow@09:00, next-week@09:00";

type CalendarSnoozeDay = "evening" | "tomorrow" | "next-week";

export type ConfiguredSnoozePreset = {
  id: string;
  label: string;
} & ({ durationMs: number } | { calendar: CalendarSnoozeDay; hour: number; minute: number });

const DURATION_UNIT_MS = {
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
  w: WEEK_MS,
} as const;

const DURATION_UNIT_LABEL = {
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
} as const;

/**
 * Parse durations and local calendar times, with optional custom labels.
 *
 * At most eight presets are shown. Durations range from one minute to one
 * year. A wholly invalid setting falls back to the defaults, so a typo cannot
 * remove Snooze from every context menu.
 */
function parseSnoozePresetEntries(source: string): ConfiguredSnoozePreset[] {
  return source
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8)
    .flatMap<ConfiguredSnoozePreset>((part, index) => {
      const separator = part.indexOf("=");
      const customLabel = separator >= 0 ? part.slice(0, separator).trim() : "";
      const value = (separator >= 0 ? part.slice(separator + 1) : part).trim().toLowerCase();
      const calendar = /^(evening|tomorrow|next-week)(?:@(\d{1,2}):(\d{2}))?$/.exec(value);
      if (calendar) {
        const day = calendar[1] as CalendarSnoozeDay;
        const defaultHour = day === "evening" ? 18 : 9;
        const hour = Number(calendar[2] ?? defaultHour);
        const minute = Number(calendar[3] ?? 0);
        if (hour > 23 || minute > 59) return [];
        const labels: Record<CalendarSnoozeDay, string> = {
          evening: "This evening",
          tomorrow: "Tomorrow morning",
          "next-week": "Next week",
        };
        return [
          {
            id: `preset-${index}`,
            label: customLabel.slice(0, 40) || labels[day],
            calendar: day,
            hour,
            minute,
          },
        ];
      }
      const match = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(value);
      if (!match) return [];

      const amount = Number(match[1]);
      const unit = match[2] as keyof typeof DURATION_UNIT_MS;
      const durationMs = amount * DURATION_UNIT_MS[unit];
      if (!Number.isFinite(durationMs) || durationMs < MINUTE_MS || durationMs > 365 * DAY_MS) {
        return [];
      }

      const displayedAmount = Number.isInteger(amount) ? String(amount) : String(Number(amount.toFixed(2)));
      const generatedLabel = `${displayedAmount} ${DURATION_UNIT_LABEL[unit]}${amount === 1 ? "" : "s"}`;
      return [
        {
          id: `preset-${index}`,
          label: customLabel.slice(0, 40) || generatedLabel,
          durationMs,
        },
      ];
    });
}

export function parseConfiguredSnoozePresets(configured: string): ConfiguredSnoozePreset[] {
  const parsed = parseSnoozePresetEntries(configured);
  return parsed.length > 0 ? parsed : parseSnoozePresetEntries(DEFAULT_SNOOZE_PRESET_CONFIG);
}

/**
 * Resolve at selection time so a menu opened before midnight never uses a
 * stale date. Calendar times follow the selecting device's local timezone.
 * An evening that has passed is unavailable, rather than silently tomorrow.
 */
export function resolveConfiguredSnoozePreset(preset: ConfiguredSnoozePreset, now = new Date()): number | null {
  if ("durationMs" in preset) return now.getTime() + preset.durationMs;

  const addDays =
    preset.calendar === "next-week" ? (1 - now.getDay() + 7) % 7 || 7 : preset.calendar === "tomorrow" ? 1 : 0;
  const wake = new Date(now);
  // Use calendar-day arithmetic to preserve the local hour across DST.
  wake.setDate(wake.getDate() + addDays);
  wake.setHours(preset.hour, preset.minute, 0, 0);
  return wake.getTime() > now.getTime() ? wake.getTime() : null;
}
