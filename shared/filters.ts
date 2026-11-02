import { z } from "zod";
import { filterIconSchema, displayModeSchema, type FilterIcon, type FilterDisplayMode } from "./filter-icons.js";

export const FILTER_DOCUMENT_KV_KEY = "project-first-sidebar:filters:v1";
export const FILTERS_CHANGED_CHANNEL = "project-first-sidebar.filters";
export const FILTER_DOCUMENT_MAX_BYTES = 255 * 1024;
export const FILTER_VALIDATION_MAX_ISSUES = 32;
export const FILTER_VALIDATION_MAX_PATH_SEGMENTS = 12;
export const FILTER_VALIDATION_MAX_PATH_SEGMENT_CHARS = 64;
export const FILTER_VALIDATION_MAX_MESSAGE_CHARS = 256;
export const FILTER_VALIDATION_MAX_TOTAL_BYTES = 16 * 1024;
export const FILTER_VALIDATION_TRUNCATED_MESSAGE = "Additional validation issues were truncated.";

export const BUILT_IN_FILTER_IDS = ["all", "projectless"] as const;
const RESERVED_FILTER_NAMES = new Set([
  "все",
  "без проектов",
]);

export type PinnedMode = "filter" | "always-show";

export type ProjectFilterRule =
  | { kind: "projectIds"; projectIds: string[] }
  | { kind: "nameGlobs"; globs: string[] };

export interface ProjectFilterDefinition {
  id: string;
  name: string;
  rule: ProjectFilterRule;
  icon?: FilterIcon;
}

export interface FilterDocumentV1 {
  schemaVersion: 1;
  revision: number;
  pinnedMode: PinnedMode;
  displayMode?: FilterDisplayMode;
  filters: ProjectFilterDefinition[];
}

export interface FilterValidationIssue {
  path: Array<string | number>;
  message: string;
}

export type FilterValidationFailure = {
  success: false;
  code: "filter_validation_failed" | "filter_document_invalid" | "filter_document_too_large";
  issues: FilterValidationIssue[];
};

export type FilterValidationResult<T> =
  | { success: true; value: T }
  | FilterValidationFailure;

const nonEmptyIdSchema = z.string().min(1, "must not be empty");
const projectIdsRuleSchema = z.object({
  kind: z.literal("projectIds"),
  projectIds: z.array(nonEmptyIdSchema),
}).strict();
const nameGlobsRuleSchema = z.object({
  kind: z.literal("nameGlobs"),
  globs: z.array(z.string()),
}).strict();

export const projectFilterRuleSchema = z.discriminatedUnion("kind", [
  projectIdsRuleSchema,
  nameGlobsRuleSchema,
]);

export const projectFilterDefinitionSchema = z.object({
  id: nonEmptyIdSchema,
  name: z.string().min(1, "must not be empty"),
  rule: projectFilterRuleSchema,
  icon: filterIconSchema.optional(),
}).strict();

export const filterDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  pinnedMode: z.enum(["filter", "always-show"]),
  displayMode: displayModeSchema.optional(),
  filters: z.array(projectFilterDefinitionSchema),
}).strict().superRefine((document, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  document.filters.forEach((filter, index) => {
    if ((BUILT_IN_FILTER_IDS as readonly string[]).includes(filter.id)) {
      context.addIssue({ code: "custom", path: ["filters", index, "id"], message: "built-in filter ids are reserved" });
    }
    if (ids.has(filter.id)) {
      context.addIssue({ code: "custom", path: ["filters", index, "id"], message: "filter ids must be unique" });
    }
    ids.add(filter.id);

    const normalizedName = normalizeName(filter.name);
    if (filter.name !== normalizedName) {
      context.addIssue({ code: "custom", path: ["filters", index, "name"], message: "stored filter names must be trimmed" });
    }
    const nameKey = filterNameKey(filter.name);
    if (RESERVED_FILTER_NAMES.has(nameKey)) {
      context.addIssue({ code: "custom", path: ["filters", index, "name"], message: "built-in filter names are reserved" });
    }
    if (names.has(nameKey)) {
      context.addIssue({ code: "custom", path: ["filters", index, "name"], message: "filter names must be unique" });
    }
    names.add(nameKey);

    if (filter.rule.kind === "projectIds") {
      const projectIds = new Set<string>();
      filter.rule.projectIds.forEach((projectId, projectIndex) => {
        if (projectIds.has(projectId)) {
          context.addIssue({
            code: "custom",
            path: ["filters", index, "rule", "projectIds", projectIndex],
            message: "stored project ids must be unique",
          });
        }
        projectIds.add(projectId);
      });
    } else {
      if (filter.rule.globs.length === 0 || filter.rule.globs.some((glob) => glob === "")) {
        context.addIssue({
          code: "custom",
          path: ["filters", index, "rule", "globs"],
          message: "stored glob rules require at least one non-empty line",
        });
      }
    }
  });
});

export function defaultFilterDocument(): FilterDocumentV1 {
  return { schemaVersion: 1, revision: 0, pinnedMode: "filter", filters: [] };
}

export function normalizeName(name: string): string {
  return name.trim();
}

export function filterNameKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

function truncateText(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  const suffix = "… [truncated]";
  let end = Math.max(0, maxChars - suffix.length);
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1;
  return { value: `${value.slice(0, end)}${suffix}`, truncated: true };
}

function boundedPath(path: PropertyKey[]): { path: Array<string | number>; truncated: boolean } {
  const bounded: Array<string | number> = [];
  let truncated = false;
  for (const segment of path.slice(0, FILTER_VALIDATION_MAX_PATH_SEGMENTS)) {
    if (typeof segment === "number") {
      bounded.push(segment);
      continue;
    }
    const text = truncateText(String(segment), FILTER_VALIDATION_MAX_PATH_SEGMENT_CHARS);
    bounded.push(text.value);
    truncated ||= text.truncated;
  }
  if (path.length > FILTER_VALIDATION_MAX_PATH_SEGMENTS) {
    bounded[FILTER_VALIDATION_MAX_PATH_SEGMENTS - 1] = "[path truncated]";
    truncated = true;
  }
  return { path: bounded, truncated };
}

function issuesFromZod(error: z.ZodError): FilterValidationIssue[] {
  const issues: FilterValidationIssue[] = [];
  let totalBytes = 2;
  let truncated = false;
  const issueLimit = FILTER_VALIDATION_MAX_ISSUES - 1;
  const truncationIssue: FilterValidationIssue = {
    path: [],
    message: FILTER_VALIDATION_TRUNCATED_MESSAGE,
  };
  const truncationBytes = new TextEncoder().encode(JSON.stringify(truncationIssue)).byteLength + 1;

  for (const issue of error.issues) {
    if (issues.length >= issueLimit) {
      truncated = true;
      break;
    }
    const path = boundedPath(issue.path);
    const message = truncateText(issue.message, FILTER_VALIDATION_MAX_MESSAGE_CHARS);
    const bounded = { path: path.path, message: message.value };
    const bytes = new TextEncoder().encode(JSON.stringify(bounded)).byteLength + 1;
    if (totalBytes + bytes + truncationBytes > FILTER_VALIDATION_MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    issues.push(bounded);
    totalBytes += bytes;
    truncated ||= path.truncated || message.truncated;
  }

  if (truncated || issues.length < error.issues.length) {
    issues.push(truncationIssue);
  }
  return issues;
}

export function normalizeFilterDefinition(input: unknown): FilterValidationResult<ProjectFilterDefinition> {
  const parsed = projectFilterDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, code: "filter_validation_failed", issues: issuesFromZod(parsed.error) };
  }
  const name = normalizeName(parsed.data.name);
  const issues: FilterValidationIssue[] = [];
  if (name.length === 0) issues.push({ path: ["name"], message: "filter name must not be empty" });
  if (RESERVED_FILTER_NAMES.has(filterNameKey(name))) {
    issues.push({ path: ["name"], message: "built-in filter names are reserved" });
  }
  if ((BUILT_IN_FILTER_IDS as readonly string[]).includes(parsed.data.id)) {
    issues.push({ path: ["id"], message: "built-in filter ids are reserved" });
  }
  let rule: ProjectFilterRule;
  if (parsed.data.rule.kind === "projectIds") {
    rule = { kind: "projectIds", projectIds: [...new Set(parsed.data.rule.projectIds)] };
  } else {
    const globs = parsed.data.rule.globs.filter((glob) => glob !== "");
    if (globs.length === 0) {
      issues.push({ path: ["rule", "globs"], message: "at least one non-empty glob is required" });
    }
    rule = { kind: "nameGlobs", globs };
  }
  if (issues.length > 0) return { success: false, code: "filter_validation_failed", issues };
  return { success: true, value: { id: parsed.data.id, name, rule, ...(parsed.data.icon === undefined ? {} : { icon: parsed.data.icon }) } };
}

export function parseFilterDocument(input: unknown): FilterValidationResult<FilterDocumentV1> {
  const parsed = filterDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, code: "filter_document_invalid", issues: issuesFromZod(parsed.error) };
  }
  return { success: true, value: parsed.data };
}

export function validateFilterDocumentSize(document: FilterDocumentV1): FilterValidationResult<FilterDocumentV1> {
  const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
  if (bytes > FILTER_DOCUMENT_MAX_BYTES) {
    return {
      success: false,
      code: "filter_document_too_large",
      issues: [{ path: [], message: `serialized filter document is ${bytes} bytes; maximum is ${FILTER_DOCUMENT_MAX_BYTES} bytes` }],
    };
  }
  return { success: true, value: document };
}

export const filterValidationIssueSchema = z.object({
  path: z.array(z.union([
    z.string().max(FILTER_VALIDATION_MAX_PATH_SEGMENT_CHARS),
    z.number().int(),
  ])).max(FILTER_VALIDATION_MAX_PATH_SEGMENTS),
  message: z.string().max(FILTER_VALIDATION_MAX_MESSAGE_CHARS),
}).strict();

export const filterDocumentErrorSchema = z.object({
  status: z.literal("error"),
  code: z.enum([
    "filter_validation_failed",
    "filter_document_invalid",
    "filter_document_too_large",
    "filter_not_found",
  ]),
  issues: z.array(filterValidationIssueSchema).max(FILTER_VALIDATION_MAX_ISSUES),
}).strict();

export const filterDocumentSuccessSchema = z.object({
  status: z.literal("success"),
  document: filterDocumentSchema,
}).strict();

export const filterConflictSchema = z.object({
  status: z.literal("conflict"),
  currentRevision: z.number().int().nonnegative().safe(),
}).strict();

export const filterReadResultSchema = z.discriminatedUnion("status", [
  filterDocumentSuccessSchema,
  filterDocumentErrorSchema,
]);

export const filterMutationResultSchema = z.discriminatedUnion("status", [
  filterDocumentSuccessSchema,
  filterConflictSchema,
  filterDocumentErrorSchema,
]);

export type FilterReadResult = z.infer<typeof filterReadResultSchema>;
export type FilterMutationResult = z.infer<typeof filterMutationResultSchema>;
