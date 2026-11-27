import { z } from "zod";
import {
  PROJECT_SECTION_VALIDATION_MAX_ISSUES,
  projectSectionValidationIssueSchema,
} from "./project-sections.js";

export const PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL = "project-first-sidebar.project-section-assignments";
export const PROJECT_SECTION_ASSIGNMENT_PROJECT_KEY = "projectId";
export const PROJECT_SECTION_ASSIGNMENT_SECTION_KEY = "projectSectionId";
export const PROJECT_SECTION_LOOSE_CHOICE = "__project_section_loose__";

export interface ProjectSectionAssignment {
  projectId: string;
  projectSectionId: string;
}

export type ProjectSectionAssignmentInterpretation =
  | { kind: "absent" }
  | { kind: "record"; assignment: ProjectSectionAssignment }
  | { kind: "invalid" };

const assignmentIssueSchema = projectSectionValidationIssueSchema;

const assignmentStorageErrorSchema = z.object({
  status: z.literal("error"),
  code: z.literal("storage"),
  issues: z.array(assignmentIssueSchema).max(PROJECT_SECTION_VALIDATION_MAX_ISSUES),
}).strict();

export const projectSectionAssignmentResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success") }).strict(),
  z.object({
    status: z.literal("error"),
    code: z.enum(["validation", "ownership", "section_unavailable", "storage"]),
    issues: z.array(assignmentIssueSchema).max(PROJECT_SECTION_VALIDATION_MAX_ISSUES),
  }).strict(),
]);

export const projectSectionClearAssignmentResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success") }).strict(),
  assignmentStorageErrorSchema,
]);

export const projectSectionThreadRequestSchema = z.looseObject({
  projectId: z.string().min(1),
});

export const projectSectionCreateThreadResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    threadId: z.string().min(1),
    assignment: z.object({
      projectId: z.string().min(1),
      projectSectionId: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    status: z.literal("error"),
    code: z.enum(["section_unavailable", "project_mismatch", "spawn_failed", "storage"]),
    issues: z.array(assignmentIssueSchema).max(PROJECT_SECTION_VALIDATION_MAX_ISSUES),
  }).strict(),
]);

export const projectSectionMetadataReadResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    threads: z.array(z.object({
      threadId: z.string().min(1),
      metadata: z.record(z.string(), z.json()),
    }).strict()),
  }).strict(),
  assignmentStorageErrorSchema,
]);

export type ProjectSectionAssignmentResult = z.infer<typeof projectSectionAssignmentResultSchema>;
export type ProjectSectionClearAssignmentResult = z.infer<typeof projectSectionClearAssignmentResultSchema>;
export type ProjectSectionMetadataReadResult = z.infer<typeof projectSectionMetadataReadResultSchema>;
export type ProjectSectionCreateThreadResult = z.infer<typeof projectSectionCreateThreadResultSchema>;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function interpretProjectSectionAssignment(
  metadata: Record<string, unknown>,
): ProjectSectionAssignmentInterpretation {
  const hasProject = Object.prototype.hasOwnProperty.call(metadata, PROJECT_SECTION_ASSIGNMENT_PROJECT_KEY);
  const hasSection = Object.prototype.hasOwnProperty.call(metadata, PROJECT_SECTION_ASSIGNMENT_SECTION_KEY);
  if (!hasProject && !hasSection) return { kind: "absent" };
  const projectId = metadata[PROJECT_SECTION_ASSIGNMENT_PROJECT_KEY];
  const projectSectionId = metadata[PROJECT_SECTION_ASSIGNMENT_SECTION_KEY];
  if (nonEmptyString(projectId) && nonEmptyString(projectSectionId)) {
    return { kind: "record", assignment: { projectId, projectSectionId } };
  }
  return { kind: "invalid" };
}
