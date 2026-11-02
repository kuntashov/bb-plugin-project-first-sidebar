import { describe, expect, it } from "vitest";
import {
  defaultFilterDocument,
  normalizeFilterDefinition,
  parseFilterDocument,
} from "./filters.js";

describe("filter document model", () => {
  it("defines an empty revision-zero document", () => {
    expect(defaultFilterDocument()).toEqual({
      schemaVersion: 1,
      revision: 0,
      pinnedMode: "filter",
      filters: [],
    });
  });

  it("trims names, keeps emoji and significant glob spaces, and deduplicates static ids", () => {
    expect(normalizeFilterDefinition({
      id: "opaque-1",
      name: "  👨‍👩‍👧‍👦  ",
      rule: { kind: "projectIds", projectIds: ["proj_b", "proj_a", "proj_b"] },
    })).toEqual({
      success: true,
      value: {
        id: "opaque-1",
        name: "👨‍👩‍👧‍👦",
        rule: { kind: "projectIds", projectIds: ["proj_b", "proj_a"] },
      },
    });
    expect(normalizeFilterDefinition({
      id: "opaque-2",
      name: "Spaced",
      rule: { kind: "nameGlobs", globs: ["", " work-* ", "   "] },
    })).toEqual({
      success: true,
      value: {
        id: "opaque-2",
        name: "Spaced",
        rule: { kind: "nameGlobs", globs: [" work-* ", "   "] },
      },
    });
  });

  it("rejects reserved/duplicate names, duplicate ids, mixed rules, and empty glob rules", () => {
    expect(normalizeFilterDefinition({
      id: "opaque-1",
      name: " Все ",
      rule: { kind: "projectIds", projectIds: [] },
    })).toMatchObject({ success: false, code: "filter_validation_failed" });
    expect(normalizeFilterDefinition({
      id: "opaque-1",
      name: "x",
      rule: { kind: "nameGlobs", globs: [""] },
    })).toMatchObject({ success: false, code: "filter_validation_failed" });
    expect(normalizeFilterDefinition({
      id: "opaque-1",
      name: "x",
      rule: { kind: "projectIds", projectIds: [], globs: ["*"] },
    })).toMatchObject({ success: false, code: "filter_validation_failed" });

    const parsed = parseFilterDocument({
      ...defaultFilterDocument(),
      filters: [
        { id: "same", name: "One", rule: { kind: "projectIds", projectIds: [] } },
        { id: "same", name: "one", rule: { kind: "projectIds", projectIds: [] } },
      ],
    });
    expect(parsed).toMatchObject({ success: false, code: "filter_document_invalid" });
  });

  it("reserves only Russian built-in display names while keeping built-in ids reserved", () => {
    expect(normalizeFilterDefinition({
      id: "opaque-all-name",
      name: "All",
      rule: { kind: "projectIds", projectIds: [] },
    })).toMatchObject({ success: true, value: { name: "All" } });
    expect(normalizeFilterDefinition({
      id: "opaque-projectless-name",
      name: "projectless",
      rule: { kind: "projectIds", projectIds: [] },
    })).toMatchObject({ success: true, value: { name: "projectless" } });
    expect(normalizeFilterDefinition({
      id: "all",
      name: "Custom",
      rule: { kind: "projectIds", projectIds: [] },
    })).toMatchObject({ success: false, code: "filter_validation_failed" });
  });
});
