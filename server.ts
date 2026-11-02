import { filterIconSchema, displayModeSchema, type FilterIcon, type FilterDisplayMode } from "./shared/filter-icons.js";
import {
  cliCommand,
  defineCli,
  defineRpcContract,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FILTER_DOCUMENT_KV_KEY,
  FILTERS_CHANGED_CHANNEL,
  defaultFilterDocument,
  filterMutationResultSchema,
  filterReadResultSchema,
  filterNameKey,
  normalizeFilterDefinition,
  parseFilterDocument,
  projectFilterRuleSchema,
  validateFilterDocumentSize,
  type FilterDocumentV1,
  type FilterMutationResult,
  type FilterReadResult,
  type PinnedMode,
  type ProjectFilterRule,
} from "./shared/filters.js";
import {
  defaultPreferences,
  describePreference,
  getPreferenceDefault,
  isPreferenceKey,
  parsePreferenceValue,
  parseStoredPreferenceValue,
  PREFERENCE_KEYS,
  PREFERENCES_CHANGED_CHANNEL,
  preferenceDefinitions,
  type PreferenceKey,
  type PreferenceValue,
  type PreferenceValues,
} from "./shared/preferences.js";

const PREFERENCE_KV_PREFIX = "project-first-sidebar:preference:";
const IMPORT_KV_KEY = "project-first-sidebar:import:thread-list:v1";

const preferenceKeySchema = z.enum(
  PREFERENCE_KEYS as [PreferenceKey, ...PreferenceKey[]],
);

const preferenceValuesSchema = z.object(
  Object.fromEntries(
    PREFERENCE_KEYS.map((key) => [key, preferenceDefinitions[key].schema]),
  ) as { [Key in PreferenceKey]: (typeof preferenceDefinitions)[Key]["schema"] },
);

const importResultSchema = z.object({
  state: z.enum(["imported", "absent", "failed"]),
  imported: z.array(preferenceKeySchema),
  message: z.string(),
}).strict();

export type ImportResult = z.infer<typeof importResultSchema>;

export const projectFirstSidebarRpcContract = defineRpcContract({
  getImportStatus: { input: z.null(), output: importResultSchema },
  importPreferences: { input: z.null(), output: importResultSchema },
  listPreferences: {
    input: z.null(),
    output: z.object({ preferences: preferenceValuesSchema }).strict(),
  },
  setPreference: {
    input: z.object({ key: preferenceKeySchema, value: z.unknown() }).strict(),
    output: z
      .object({ key: preferenceKeySchema, value: z.unknown() })
      .strict(),
  },
  resetPreference: {
    input: z.object({ key: preferenceKeySchema }).strict(),
    output: z
      .object({ key: preferenceKeySchema, value: z.unknown() })
      .strict(),
  },
  listFilters: { input: z.null(), output: filterReadResultSchema },
  createFilter: {
    input: z.object({
      expectedRevision: z.number().int().nonnegative().safe(),
      name: z.string(),
      rule: projectFilterRuleSchema,
      icon: filterIconSchema.optional(),
    }).strict(),
    output: filterMutationResultSchema,
  },
  updateFilter: {
    input: z.object({
      expectedRevision: z.number().int().nonnegative().safe(),
      filterId: z.string().min(1),
      name: z.string(),
      rule: projectFilterRuleSchema,
      icon: filterIconSchema.optional(),
    }).strict(),
    output: filterMutationResultSchema,
  },
  deleteFilter: {
    input: z.object({
      expectedRevision: z.number().int().nonnegative().safe(),
      filterId: z.string().min(1),
    }).strict(),
    output: filterMutationResultSchema,
  },
  reorderFilters: {
    input: z.object({
      expectedRevision: z.number().int().nonnegative().safe(),
      filterIds: z.array(z.string().min(1)),
    }).strict(),
    output: filterMutationResultSchema,
  },
  setDisplayMode: {
    input: z.object({ expectedRevision: z.number().int().nonnegative().safe(), displayMode: displayModeSchema }).strict(),
    output: filterMutationResultSchema,
  },
  setPinnedMode: {
    input: z.object({
      expectedRevision: z.number().int().nonnegative().safe(),
      pinnedMode: z.enum(["filter", "always-show"]),
    }).strict(),
    output: filterMutationResultSchema,
  },
});

function kvKey(key: PreferenceKey): string {
  return `${PREFERENCE_KV_PREFIX}${key}`;
}

export function createPreferenceStore(bb: BbPluginApi) {
  async function read<Key extends PreferenceKey>(
    key: Key,
  ): Promise<PreferenceValue<Key>> {
    const stored = await bb.storage.kv.get<unknown>(kvKey(key));
    if (stored === undefined) return getPreferenceDefault(key);
    const parsed = parseStoredPreferenceValue(key, stored);
    if (parsed.success) return parsed.value;
    bb.log.warn(
      `stored preference ${key} is invalid (${parsed.message}); using the default`,
    );
    return getPreferenceDefault(key);
  }

  async function readAll(): Promise<PreferenceValues> {
    const values = defaultPreferences();
    await Promise.all(
      PREFERENCE_KEYS.map(async (key) => {
        (values as Record<PreferenceKey, unknown>)[key] = await read(key);
      }),
    );
    return values;
  }

  async function write<Key extends PreferenceKey>(
    key: Key,
    value: unknown,
  ): Promise<PreferenceValue<Key>> {
    const parsed = parsePreferenceValue(key, value);
    if (!parsed.success) {
      throw new PreferenceValidationError(key, parsed.message);
    }
    await bb.storage.kv.set(kvKey(key), parsed.value);
    bb.realtime.publish(PREFERENCES_CHANGED_CHANNEL, {
      key,
      value: parsed.value,
    });
    return parsed.value;
  }

  async function reset<Key extends PreferenceKey>(
    key: Key,
  ): Promise<PreferenceValue<Key>> {
    await bb.storage.kv.delete(kvKey(key));
    const value = getPreferenceDefault(key);
    bb.realtime.publish(PREFERENCES_CHANGED_CHANNEL, { key, value });
    return value;
  }

  return { read, readAll, write, reset };
}

export class PreferenceValidationError extends Error {
  constructor(
    readonly key: PreferenceKey,
    readonly detail: string,
  ) {
    super(`Invalid value for ${key}: ${detail}`);
    this.name = "PreferenceValidationError";
  }
}

type SerializeMutation = <T>(operation: () => Promise<T>) => Promise<T>;

export function createFilterStore(bb: BbPluginApi, serialize: SerializeMutation) {
  async function read(): Promise<FilterReadResult> {
    const stored = await bb.storage.kv.get<unknown>(FILTER_DOCUMENT_KV_KEY);
    if (stored === undefined) {
      return { status: "success", document: defaultFilterDocument() };
    }
    const parsed = parseFilterDocument(stored);
    if (!parsed.success) {
      return { status: "error", code: parsed.code, issues: parsed.issues };
    }
    const sized = validateFilterDocumentSize(parsed.value);
    if (!sized.success) {
      return { status: "error", code: sized.code, issues: sized.issues };
    }
    return { status: "success", document: sized.value };
  }

  function validationError(issues: Array<{ path: Array<string | number>; message: string }>): FilterMutationResult {
    return { status: "error", code: "filter_validation_failed", issues };
  }

  async function mutate(
    expectedRevision: number,
    change: (document: FilterDocumentV1) => FilterDocumentV1 | FilterMutationResult,
  ): Promise<FilterMutationResult> {
    return serialize(async () => {
      const current = await read();
      if (current.status === "error") return current;
      if (current.document.revision !== expectedRevision) {
        return { status: "conflict", currentRevision: current.document.revision };
      }
      const changed = change(current.document);
      if ("status" in changed) return changed;
      const next = { ...changed, revision: current.document.revision + 1 };
      const valid = parseFilterDocument(next);
      if (!valid.success) {
        return { status: "error", code: valid.code, issues: valid.issues };
      }
      const sized = validateFilterDocumentSize(valid.value);
      if (!sized.success) {
        return { status: "error", code: sized.code, issues: sized.issues };
      }
      await bb.storage.kv.set(FILTER_DOCUMENT_KV_KEY, sized.value);
      bb.realtime.publish(FILTERS_CHANGED_CHANNEL, { revision: sized.value.revision });
      return { status: "success", document: sized.value };
    });
  }

  function definitionInput(id: string, name: string, rule: ProjectFilterRule, icon?: FilterIcon) {
    return normalizeFilterDefinition({ id, name, rule, ...(icon === undefined ? {} : { icon }) });
  }

  function duplicateNameIssue(document: FilterDocumentV1, name: string, exceptId?: string) {
    const duplicate = document.filters.some(
      (filter) => filter.id !== exceptId && filterNameKey(filter.name) === filterNameKey(name),
    );
    return duplicate
      ? validationError([{ path: ["name"], message: "filter names must be unique" }])
      : null;
  }

  return {
    read,
    create(expectedRevision: number, name: string, rule: ProjectFilterRule, icon?: FilterIcon): Promise<FilterMutationResult> {
      return mutate(expectedRevision, (document) => {
        const normalized = definitionInput(randomUUID(), name, rule, icon);
        if (!normalized.success) return { status: "error", code: normalized.code, issues: normalized.issues };
        const duplicate = duplicateNameIssue(document, normalized.value.name);
        if (duplicate !== null) return duplicate;
        return { ...document, filters: [...document.filters, normalized.value] };
      });
    },
    update(expectedRevision: number, filterId: string, name: string, rule: ProjectFilterRule, icon?: FilterIcon): Promise<FilterMutationResult> {
      return mutate(expectedRevision, (document) => {
        const index = document.filters.findIndex((filter) => filter.id === filterId);
        if (index < 0) {
          return { status: "error", code: "filter_not_found", issues: [{ path: ["filterId"], message: "filter was not found" }] };
        }
        const normalized = definitionInput(filterId, name, rule, icon ?? document.filters[index]!.icon);
        if (!normalized.success) return { status: "error", code: normalized.code, issues: normalized.issues };
        const duplicate = duplicateNameIssue(document, normalized.value.name, filterId);
        if (duplicate !== null) return duplicate;
        const filters = document.filters.slice();
        filters[index] = normalized.value;
        return { ...document, filters };
      });
    },
    delete(expectedRevision: number, filterId: string): Promise<FilterMutationResult> {
      return mutate(expectedRevision, (document) => {
        if (!document.filters.some((filter) => filter.id === filterId)) {
          return { status: "error", code: "filter_not_found", issues: [{ path: ["filterId"], message: "filter was not found" }] };
        }
        return { ...document, filters: document.filters.filter((filter) => filter.id !== filterId) };
      });
    },
    reorder(expectedRevision: number, filterIds: string[]): Promise<FilterMutationResult> {
      return mutate(expectedRevision, (document) => {
        const currentIds = document.filters.map((filter) => filter.id);
        const uniqueIds = new Set(filterIds);
        if (
          uniqueIds.size !== filterIds.length
          || filterIds.length !== currentIds.length
          || currentIds.some((id) => !uniqueIds.has(id))
        ) {
          return validationError([{ path: ["filterIds"], message: "reorder requires every existing filter id exactly once" }]);
        }
        const byId = new Map(document.filters.map((filter) => [filter.id, filter]));
        return { ...document, filters: filterIds.map((id) => byId.get(id)!) };
      });
    },
    setDisplayMode(expectedRevision: number, displayMode: FilterDisplayMode): Promise<FilterMutationResult> {
      return mutate(expectedRevision, (document) => {
        const { displayMode: _previousMode, ...rest } = document;
        return displayMode === "text" ? rest : { ...rest, displayMode };
      });
    },
    setPinnedMode(expectedRevision: number, pinnedMode: PinnedMode): Promise<FilterMutationResult> {
      return mutate(expectedRevision, (document) => ({ ...document, pinnedMode }));
    },
  };
}

export async function importThreadListPreferences(bb: BbPluginApi): Promise<ImportResult> {
  const imported: PreferenceKey[] = [];
  try {
    if (await bb.storage.kv.get<unknown>(IMPORT_KV_KEY) === true) {
      return { state: "imported", imported, message: "Thread-list preferences were already imported." };
    }
    const { plugins } = await bb.sdk.plugins.list();
    const source = plugins.find((candidate) => candidate.id === "thread-list");
    if (source === undefined) {
      return { state: "absent", imported, message: "Thread-list is not installed. Using own preferences and defaults. Install and enable it before retrying an import." };
    }
    if (!source.enabled) throw new Error("Enable Thread-list before importing its preferences.");
    const response = await bb.sdk.plugins.callRpc({
      pluginId: "thread-list",
      method: "listPreferences",
      input: null,
      outputSchema: z.object({ preferences: preferenceValuesSchema }).strict(),
    });
    const { preferences } = z.object({ preferences: preferenceValuesSchema }).strict().parse(response);
    const store = createPreferenceStore(bb);
    for (const key of PREFERENCE_KEYS) {
      if (await bb.storage.kv.get<unknown>(kvKey(key)) !== undefined) continue;
      await store.write(key, preferences[key]);
      imported.push(key);
    }
    await bb.storage.kv.set(IMPORT_KV_KEY, true);
    return { state: "imported", imported, message: "Thread-list preferences imported. Existing own values were preserved." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bb.log.warn(`Thread-list preferences import failed: ${message}`);
    return { state: "failed", imported, message: `Import failed: ${message} Retry while Thread-list is enabled; existing own values will be preserved.` };
  }
}

function parseCliValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function requireCliPreferenceKey(raw: string): PreferenceKey {
  if (isPreferenceKey(raw)) return raw;
  throw new PluginCliError(`Unknown preference: ${raw}`, {
    code: "unknown_preference",
    hint: `Known preferences: ${PREFERENCE_KEYS.join(", ")}.`,
  });
}

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const EXPECTED_REVISION_OPTION = {
  type: "integer",
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  required: true,
  description: "Current filter document revision for optimistic concurrency",
} as const;

const FILTER_RULE_OPTIONS = {
  "project-ids-json": {
    type: "string",
    description: "JSON array of project ids; [] is an explicit empty static filter",
  },
  "globs-json": {
    type: "string",
    description: "JSON array of name glob lines; exactly empty lines are ignored",
  },
} as const;

function parseCliStringArray(raw: string, option: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  } catch {
    // Report one stable boundary error below.
  }
  throw new PluginCliError(`--${option} must be a JSON array of strings`, {
    code: "invalid_filter_rule_json",
    hint: option === "project-ids-json"
      ? `Use --project-ids-json '["proj_..."]' or --project-ids-json '[]'.`
      : `Use --globs-json '["work-*"]'.`,
  });
}

function parseCliRule(options: {
  "project-ids-json": string | undefined;
  "globs-json": string | undefined;
}): ProjectFilterRule {
  if (options["project-ids-json"] !== undefined) {
    return {
      kind: "projectIds",
      projectIds: parseCliStringArray(options["project-ids-json"], "project-ids-json"),
    };
  }
  return {
    kind: "nameGlobs",
    globs: parseCliStringArray(options["globs-json"]!, "globs-json"),
  };
}

function readableFilterDocument(document: FilterDocumentV1): string {
  const lines = [
    `Filter document revision ${document.revision}`,
    `Display mode: ${document.displayMode ?? "text"}`,
    `Pinned mode: ${document.pinnedMode}`,
  ];
  if (document.filters.length === 0) lines.push("No user filters.");
  for (const filter of document.filters) {
    lines.push(`${filter.id}\t${filter.name}\t${JSON.stringify(filter.rule)}`);
  }
  return lines.join("\n");
}

function filterErrorMessage(code: Extract<FilterMutationResult, { status: "error" }>["code"]): string {
  switch (code) {
    case "filter_document_invalid": return "Stored filter document is invalid.";
    case "filter_document_too_large": return "Filter document exceeds the storage limit.";
    case "filter_not_found": return "Filter was not found.";
    case "filter_validation_failed": return "Filter validation failed.";
  }
}

function formatFilterIssueHint(issues: Array<{ path: Array<string | number>; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`)
    .join("; ");
}

function requireFilterSuccess(result: FilterMutationResult): FilterDocumentV1 {
  if (result.status === "success") return result.document;
  if (result.status === "conflict") {
    throw new PluginCliError(
      `Filter document revision conflict; current revision is ${result.currentRevision}.`,
      {
        code: "filter_revision_conflict",
        hint: `Read the current document and retry with --expected-revision ${result.currentRevision}.`,
      },
    );
  }
  throw new PluginCliError(filterErrorMessage(result.code), {
    code: result.code,
    hint: formatFilterIssueHint(result.issues),
  });
}

function requireFilterReadSuccess(result: FilterReadResult): FilterDocumentV1 {
  if (result.status === "success") return result.document;
  throw new PluginCliError(filterErrorMessage(result.code), {
    code: result.code,
    hint: formatFilterIssueHint(result.issues),
  });
}

export default async function projectFirstSidebarPlugin(bb: BbPluginApi) {
  const store = createPreferenceStore(bb);
  let writes: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = writes.then(operation);
    writes = result.catch(() => undefined);
    return result;
  }
  let importStatus = await serialize(() => importThreadListPreferences(bb));
  const filters = createFilterStore(bb, serialize);
  async function importPreferences(): Promise<ImportResult> {
    return serialize(async () => {
      importStatus = await importThreadListPreferences(bb);
      return importStatus;
    });
  }

  bb.rpc.register(projectFirstSidebarRpcContract, {
    async getImportStatus() { return importStatus; },
    importPreferences,
    async listPreferences() {
      return { preferences: await store.readAll() };
    },
    async setPreference({ key, value }) {
      return { key, value: await serialize(() => store.write(key, value)) };
    },
    async resetPreference({ key }) {
      return { key, value: await serialize(() => store.reset(key)) };
    },
    listFilters() { return filters.read(); },
    createFilter({ expectedRevision, name, rule, icon }) {
      return filters.create(expectedRevision, name, rule, icon);
    },
    updateFilter({ expectedRevision, filterId, name, rule, icon }) {
      return filters.update(expectedRevision, filterId, name, rule, icon);
    },
    deleteFilter({ expectedRevision, filterId }) {
      return filters.delete(expectedRevision, filterId);
    },
    reorderFilters({ expectedRevision, filterIds }) {
      return filters.reorder(expectedRevision, filterIds);
    },
    setDisplayMode({ expectedRevision, displayMode }) {
      return filters.setDisplayMode(expectedRevision, displayMode);
    },
    setPinnedMode({ expectedRevision, pinnedMode }) {
      return filters.setPinnedMode(expectedRevision, pinnedMode);
    },
  });

  bb.cli.register(
    defineCli({
      name: bb.pluginId,
      summary: "Inspect and change the sidebar thread list's layout preferences",
      description:
        "Organization mode, sort, section order, hidden groups, and collapsed groups for bb's sidebar thread list. Values are JSON; a bare word is read as a string.",
      commands: {
        "filters list": cliCommand({
          summary: "List the versioned project filter document",
          options: { json: JSON_OPTION },
          async run(input) {
            const document = requireFilterReadSuccess(await filters.read());
            return {
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify(document) : readableFilterDocument(document),
            };
          },
        }),
        "filters create": cliCommand({
          summary: "Create a project filter with one static-id or name-glob rule",
          options: {
            name: { type: "string", required: true, description: "Filter display name" },
            ...FILTER_RULE_OPTIONS,
            "expected-revision": EXPECTED_REVISION_OPTION,
            json: JSON_OPTION,
          },
          constraints: [{ kind: "exactly-one", options: ["project-ids-json", "globs-json"] }],
          async run(input) {
            const document = requireFilterSuccess(await filters.create(
              input.options["expected-revision"],
              input.options.name,
              parseCliRule(input.options),
            ));
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify(document) : readableFilterDocument(document) };
          },
        }),
        "filters update": cliCommand({
          summary: "Replace one filter's name and complete rule",
          positionals: [{ name: "filterId", description: "Opaque user filter id", required: true }],
          options: {
            name: { type: "string", required: true, description: "Filter display name" },
            ...FILTER_RULE_OPTIONS,
            "expected-revision": EXPECTED_REVISION_OPTION,
            json: JSON_OPTION,
          },
          constraints: [{ kind: "exactly-one", options: ["project-ids-json", "globs-json"] }],
          async run(input) {
            const document = requireFilterSuccess(await filters.update(
              input.options["expected-revision"],
              input.positionals.filterId,
              input.options.name,
              parseCliRule(input.options),
            ));
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify(document) : readableFilterDocument(document) };
          },
        }),
        "filters delete": cliCommand({
          summary: "Delete one user filter",
          positionals: [{ name: "filterId", description: "Opaque user filter id", required: true }],
          options: { "expected-revision": EXPECTED_REVISION_OPTION, json: JSON_OPTION },
          async run(input) {
            const document = requireFilterSuccess(await filters.delete(
              input.options["expected-revision"],
              input.positionals.filterId,
            ));
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify(document) : readableFilterDocument(document) };
          },
        }),
        "filters reorder": cliCommand({
          summary: "Replace user filter order using every existing id exactly once",
          positionals: [{ name: "filterIds", description: "All opaque user filter ids in the new order", required: true, variadic: true }],
          options: { "expected-revision": EXPECTED_REVISION_OPTION, json: JSON_OPTION },
          async run(input) {
            const document = requireFilterSuccess(await filters.reorder(
              input.options["expected-revision"],
              input.positionals.filterIds,
            ));
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify(document) : readableFilterDocument(document) };
          },
        }),
        "filters pinned-mode": cliCommand({
          summary: "Set whether project filtering applies to pinned subtrees",
          positionals: [{ name: "mode", description: "filter or always-show", required: true }],
          options: { "expected-revision": EXPECTED_REVISION_OPTION, json: JSON_OPTION },
          async run(input) {
            if (input.positionals.mode !== "filter" && input.positionals.mode !== "always-show") {
              throw new PluginCliError("Pinned mode must be filter or always-show", {
                code: "invalid_pinned_mode",
                hint: "Use `filter` or `always-show`.",
              });
            }
            const document = requireFilterSuccess(await filters.setPinnedMode(
              input.options["expected-revision"],
              input.positionals.mode,
            ));
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify(document) : readableFilterDocument(document) };
          },
        }),
        "prefs import": cliCommand({
          summary: "Import Thread-list preferences once; retry a failed snapshot without overwriting own values",
          options: { json: JSON_OPTION },
          async run(input) {
            const result = await importPreferences();
            return { exitCode: result.state === "failed" ? 1 : 0, stdout: input.options.json ? JSON.stringify(result) : result.message };
          },
        }),
        "prefs import-status": cliCommand({
          summary: "Show the latest Thread-list import result",
          options: { json: JSON_OPTION },
          async run(input) {
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify(importStatus) : importStatus.message };
          },
        }),
        "prefs list": cliCommand({
          summary: "List every preference and its current value",
          options: { json: JSON_OPTION },
          async run(input) {
            const values = await store.readAll();
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(values) };
            }
            return {
              exitCode: 0,
              stdout: PREFERENCE_KEYS.map(
                (key) =>
                  `${key}\t${JSON.stringify(values[key])}\t${describePreference(key)}`,
              ).join("\n"),
            };
          },
        }),
        "prefs get": cliCommand({
          summary: "Print one preference",
          positionals: [
            { name: "key", description: "Preference name", required: true },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const key = requireCliPreferenceKey(input.positionals.key);
            const value = await store.read(key);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ key, value })
                : JSON.stringify(value),
            };
          },
        }),
        "prefs set": cliCommand({
          summary: "Set one preference",
          positionals: [
            { name: "key", description: "Preference name", required: true },
            {
              name: "value",
              description: 'JSON value, e.g. \'"machine"\' or \'["pinned","threads"]\'',
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const key = requireCliPreferenceKey(input.positionals.key);
            try {
              const value = await serialize(() => store.write(
                key,
                parseCliValue(input.positionals.value),
              ));
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ key, value })
                  : `${key} = ${JSON.stringify(value)}`,
              };
            } catch (error) {
              if (error instanceof PreferenceValidationError) {
                throw new PluginCliError(error.message, {
                  code: "invalid_preference_value",
                  hint: describePreference(key),
                });
              }
              throw error;
            }
          },
        }),
        "prefs reset": cliCommand({
          summary: "Restore one preference to its default",
          positionals: [
            { name: "key", description: "Preference name", required: true },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const key = requireCliPreferenceKey(input.positionals.key);
            const value = await serialize(() => store.reset(key));
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ key, value })
                : `${key} = ${JSON.stringify(value)}`,
            };
          },
        }),
      },
    }),
  );

}
