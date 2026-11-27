import { z } from "zod";
import { filterNameKey } from "./filters.js";

export const PROJECT_SECTIONS_CHANGED_CHANNEL = "project-first-sidebar.project-sections";
export const PROJECT_SECTION_DOCUMENT_MAX_BYTES = 1_048_576;
export const PROJECT_SECTION_NAME_MAX_LENGTH = 200;
export const PROJECT_SECTION_MAX_PER_PROJECT = 100;
export const PROJECT_SECTION_VALIDATION_MAX_ISSUES = 32;
export const PROJECT_SECTION_VALIDATION_MAX_PATH_SEGMENTS = 12;
export const PROJECT_SECTION_VALIDATION_MAX_PATH_SEGMENT_CHARS = 64;
export const PROJECT_SECTION_VALIDATION_MAX_MESSAGE_CHARS = 256;
export const PROJECT_SECTION_VALIDATION_MAX_TOTAL_BYTES = 16 * 1024;
export const PROJECT_SECTION_VALIDATION_TRUNCATED_MESSAGE = "Additional validation issues were truncated.";

export interface ProjectSectionDefinition {
  id: string;
  projectId: string;
  name: string;
}

export interface ProjectSectionOrder {
  projectId: string;
  sectionIds: string[];
}

export interface ProjectSectionDocumentV1 {
  schemaVersion: 1;
  revision: number;
  sections: ProjectSectionDefinition[];
  order: ProjectSectionOrder[];
}

export interface ProjectSectionValidationIssue {
  path: Array<string | number>;
  message: string;
}

export type ProjectSectionReadErrorCode = "document_invalid" | "storage";
export type ProjectSectionMutationErrorCode =
  | ProjectSectionReadErrorCode
  | "validation"
  | "not_found"
  | "ownership"
  | "too_large";

export type ProjectSectionFailure = {
  success: false;
  code: "document_invalid" | "too_large" | "validation";
  issues: ProjectSectionValidationIssue[];
};

export type ProjectSectionValidationResult<T> =
  | { success: true; value: T }
  | ProjectSectionFailure;

const nonEmptyIdSchema = z.string().min(1, "must not be empty");

const projectSectionDefinitionSchema = z.object({
  id: nonEmptyIdSchema,
  projectId: nonEmptyIdSchema,
  name: z.string(),
}).strict();

const projectSectionOrderSchema = z.object({
  projectId: nonEmptyIdSchema,
  sectionIds: z.array(nonEmptyIdSchema),
}).strict();

export const projectSectionDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  sections: z.array(projectSectionDefinitionSchema),
  order: z.array(projectSectionOrderSchema),
}).strict().superRefine((document, context) => {
  const ids = new Set<string>();
  const nameKeysByProject = new Map<string, Set<string>>();
  const sectionsByProject = new Map<string, ProjectSectionDefinition[]>();
  document.sections.forEach((section, index) => {
    if (ids.has(section.id)) {
      context.addIssue({ code: "custom", path: ["sections", index, "id"], message: "section ids must be unique" });
    }
    ids.add(section.id);
    const trimmed = section.name.trim();
    if (section.name !== trimmed) {
      context.addIssue({ code: "custom", path: ["sections", index, "name"], message: "stored section names must be trimmed" });
    }
    if (trimmed.length < 1 || trimmed.length > PROJECT_SECTION_NAME_MAX_LENGTH) {
      context.addIssue({
        code: "custom",
        path: ["sections", index, "name"],
        message: `section name must be 1 to ${PROJECT_SECTION_NAME_MAX_LENGTH} UTF-16 units`,
      });
    }
    const names = nameKeysByProject.get(section.projectId) ?? new Set<string>();
    const nameKey = filterNameKey(section.name);
    if (names.has(nameKey)) {
      context.addIssue({ code: "custom", path: ["sections", index, "name"], message: "section names must be unique within a project" });
    }
    names.add(nameKey);
    nameKeysByProject.set(section.projectId, names);
    const grouped = sectionsByProject.get(section.projectId) ?? [];
    grouped.push(section);
    sectionsByProject.set(section.projectId, grouped);
  });
  for (const [projectId, sections] of sectionsByProject) {
    if (sections.length > PROJECT_SECTION_MAX_PER_PROJECT) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: `project ${projectId} has more than ${PROJECT_SECTION_MAX_PER_PROJECT} sections`,
      });
    }
  }
  const orderedProjects = new Set<string>();
  document.order.forEach((entry, index) => {
    if (orderedProjects.has(entry.projectId)) {
      context.addIssue({ code: "custom", path: ["order", index, "projectId"], message: "a project has one order entry" });
    }
    orderedProjects.add(entry.projectId);
    const sections = sectionsByProject.get(entry.projectId) ?? [];
    const expected = new Set(sections.map((section) => section.id));
    const seen = new Set<string>();
    if (entry.sectionIds.length === 0 || entry.sectionIds.length !== expected.size) {
      context.addIssue({
        code: "custom",
        path: ["order", index, "sectionIds"],
        message: "order must list every section of the project once",
      });
    }
    entry.sectionIds.forEach((sectionId, sectionIndex) => {
      if (seen.has(sectionId) || !expected.has(sectionId)) {
        context.addIssue({
          code: "custom",
          path: ["order", index, "sectionIds", sectionIndex],
          message: "order ids must be the project's own section ids",
        });
      }
      seen.add(sectionId);
    });
  });
  for (const projectId of sectionsByProject.keys()) {
    if (!orderedProjects.has(projectId)) {
      context.addIssue({ code: "custom", path: ["order"], message: `project ${projectId} is missing its order entry` });
    }
  }
});

export function defaultProjectSectionDocument(): ProjectSectionDocumentV1 {
  return { schemaVersion: 1, revision: 0, sections: [], order: [] };
}

export function projectSectionCollapseKey(projectId: string, sectionId: string): string {
  return `project-section:${projectId}::${sectionId}`;
}

export function projectSectionLooseDropKey(projectId: string): string {
  return `project-loose:${projectId}`;
}

export function parseProjectSectionDropKey(key: string): { projectId: string; sectionId: string | null } | null {
  const sectionPrefix = "project-section:";
  if (key.startsWith(sectionPrefix)) {
    const body = key.slice(sectionPrefix.length);
    const split = body.indexOf("::");
    if (split <= 0 || split >= body.length - 2) return null;
    return { projectId: body.slice(0, split), sectionId: body.slice(split + 2) };
  }
  const loosePrefix = "project-loose:";
  if (!key.startsWith(loosePrefix)) return null;
  const projectId = key.slice(loosePrefix.length);
  if (projectId.length === 0) return null;
  return { projectId, sectionId: null };
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
  for (const segment of path.slice(0, PROJECT_SECTION_VALIDATION_MAX_PATH_SEGMENTS)) {
    if (typeof segment === "number") {
      bounded.push(segment);
      continue;
    }
    const text = truncateText(String(segment), PROJECT_SECTION_VALIDATION_MAX_PATH_SEGMENT_CHARS);
    bounded.push(text.value);
    truncated ||= text.truncated;
  }
  if (path.length > PROJECT_SECTION_VALIDATION_MAX_PATH_SEGMENTS) {
    bounded[PROJECT_SECTION_VALIDATION_MAX_PATH_SEGMENTS - 1] = "[path truncated]";
    truncated = true;
  }
  return { path: bounded, truncated };
}

function issuesFromZod(error: z.ZodError): ProjectSectionValidationIssue[] {
  const issues: ProjectSectionValidationIssue[] = [];
  let totalBytes = 2;
  let truncated = false;
  const issueLimit = PROJECT_SECTION_VALIDATION_MAX_ISSUES - 1;
  const truncationIssue: ProjectSectionValidationIssue = {
    path: [],
    message: PROJECT_SECTION_VALIDATION_TRUNCATED_MESSAGE,
  };
  const truncationBytes = new TextEncoder().encode(JSON.stringify(truncationIssue)).byteLength + 1;
  for (const issue of error.issues) {
    if (issues.length >= issueLimit) {
      truncated = true;
      break;
    }
    const path = boundedPath(issue.path);
    const message = truncateText(issue.message, PROJECT_SECTION_VALIDATION_MAX_MESSAGE_CHARS);
    const bounded = { path: path.path, message: message.value };
    const bytes = new TextEncoder().encode(JSON.stringify(bounded)).byteLength + 1;
    if (totalBytes + bytes + truncationBytes > PROJECT_SECTION_VALIDATION_MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    issues.push(bounded);
    totalBytes += bytes;
    truncated ||= path.truncated || message.truncated;
  }
  if (truncated || issues.length < error.issues.length) issues.push(truncationIssue);
  return issues;
}

export function parseProjectSectionDocument(input: unknown): ProjectSectionValidationResult<ProjectSectionDocumentV1> {
  const parsed = projectSectionDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, code: "document_invalid", issues: issuesFromZod(parsed.error) };
  }
  return { success: true, value: parsed.data };
}

export function validateProjectSectionDocumentSize(
  document: ProjectSectionDocumentV1,
): ProjectSectionValidationResult<ProjectSectionDocumentV1> {
  const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
  if (bytes > PROJECT_SECTION_DOCUMENT_MAX_BYTES) {
    return {
      success: false,
      code: "too_large",
      issues: [{ path: [], message: `serialized project section document is ${bytes} bytes; maximum is ${PROJECT_SECTION_DOCUMENT_MAX_BYTES} bytes` }],
    };
  }
  return { success: true, value: document };
}

export function normalizeProjectSectionName(name: string): ProjectSectionValidationResult<string> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > PROJECT_SECTION_NAME_MAX_LENGTH) {
    return {
      success: false,
      code: "validation",
      issues: [{
        path: ["name"],
        message: `section name must be 1 to ${PROJECT_SECTION_NAME_MAX_LENGTH} UTF-16 units after trim`,
      }],
    };
  }
  return { success: true, value: trimmed };
}

export const projectSectionValidationIssueSchema = z.object({
  path: z.array(z.union([
    z.string().max(PROJECT_SECTION_VALIDATION_MAX_PATH_SEGMENT_CHARS),
    z.number().int(),
  ])).max(PROJECT_SECTION_VALIDATION_MAX_PATH_SEGMENTS),
  message: z.string().max(PROJECT_SECTION_VALIDATION_MAX_MESSAGE_CHARS),
}).strict();

const projectSectionReadErrorSchema = z.object({
  status: z.literal("error"),
  code: z.enum(["document_invalid", "storage"]),
  issues: z.array(projectSectionValidationIssueSchema).max(PROJECT_SECTION_VALIDATION_MAX_ISSUES),
}).strict();

const projectSectionMutationErrorSchema = z.object({
  status: z.literal("error"),
  code: z.enum(["document_invalid", "storage", "validation", "not_found", "ownership", "too_large"]),
  issues: z.array(projectSectionValidationIssueSchema).max(PROJECT_SECTION_VALIDATION_MAX_ISSUES),
}).strict();

export const projectSectionDocumentSuccessSchema = z.object({
  status: z.literal("success"),
  document: projectSectionDocumentSchema,
}).strict();

export const projectSectionConflictSchema = z.object({
  status: z.literal("conflict"),
  currentRevision: z.number().int().nonnegative().safe(),
}).strict();

export const projectSectionReadResultSchema = z.discriminatedUnion("status", [
  projectSectionDocumentSuccessSchema,
  projectSectionReadErrorSchema,
]);

export const projectSectionMutationResultSchema = z.discriminatedUnion("status", [
  projectSectionDocumentSuccessSchema,
  projectSectionConflictSchema,
  projectSectionMutationErrorSchema,
]);

export type ProjectSectionReadResult = z.infer<typeof projectSectionReadResultSchema>;
export type ProjectSectionMutationResult = z.infer<typeof projectSectionMutationResultSchema>;
