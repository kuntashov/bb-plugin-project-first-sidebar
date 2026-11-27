import { describe, expect, it, vi } from "vitest";
import { entry } from "./test-fixtures.js";
import { defaultFilterDocument } from "../../shared/filters.js";
import { completeAncestors, effectiveProject, filterProjectIds, listSearchThreads, matchThreadQuery, matchTitle } from "./search-model.js";


describe("navigation by literal fragments", () => {
  it("requires every slash part, ignoring order and case", () => {
    const title = "Исследование: каналы публикации";
    expect(matchTitle(title, "Исс/пуб")).toEqual([{ start: 0, end: 3 }, { start: 21, end: 24 }]);
    expect(matchTitle(title, "пуб/ИСС")).toEqual(matchTitle(title, "Исс/пуб"));
    expect(matchTitle("Исследование: каналы", "исс/пуб")).toBeNull();
  });
  it("preserves leading/trailing whitespace; a space is a real query", () => {
    expect(matchTitle("Исследование: публикации", "исс/ пуб")).not.toBeNull();
    expect(matchTitle("Исследование:публикации", "исс/ пуб")).toBeNull();
    expect(matchTitle("публикации", "пуб ")).toBeNull();
    expect(matchTitle("пуб дальше", "пуб ")).toEqual([{ start: 0, end: 4 }]);
    expect(matchTitle("слово", " ")).toBeNull();
  });
  it("ignores zero-length parts and highlights all repeated/overlapping matches", () => {
    expect(matchTitle("банана", "ана/ана//")).toEqual([{ start: 1, end: 6 }]);
    expect(matchTitle("пуб и пуб", "пуб")).toEqual([{ start: 0, end: 3 }, { start: 6, end: 9 }]);
    expect(matchTitle("любое", "///")).toEqual([]);
  });
  it("maps lowercase expansion and emoji back to intact original characters", () => {
    expect(matchTitle("İ😀ПУБ", "i/😀/пуб")).toEqual([{ start: 0, end: 6 }]);
    expect(matchTitle("ёлка", "елка")).toBeNull();
    expect(matchTitle("публикации", "публкации")).toBeNull();
  });
});

describe("project prefix and keyboard layout", () => {
  it.each(["cthdth", "сервер"])("finds and highlights Russian title from %s", (query) => {
    expect(matchTitle("Наш сервер", query)).toEqual([{ start: 4, end: 10 }]);
  });
  it.each(["server", "ыукмук"])("finds and highlights English title from %s", (query) => {
    expect(matchTitle("Our SERVER", query)).toEqual([{ start: 4, end: 10 }]);
  });
  it("allows independent layouts in AND fragments and highlights both interpretations", () => {
    expect(matchTitle("Сервер server", "cthdth/ыукмук")).toEqual([{ start: 0, end: 6 }, { start: 7, end: 13 }]);
    expect(matchTitle("сервер cthdth", "cthdth")).toEqual([{ start: 0, end: 6 }, { start: 7, end: 13 }]);
    expect(matchTitle("сервер", " cthdth")).toBeNull();
    expect(matchTitle("😀СЕРВЕР", "CTHDTH")).toEqual([{ start: 2, end: 8 }]);
  });
  it("requires project and every title fragment on their respective fields", () => {
    expect(matchThreadQuery("Настройка сравнения", "Admin tools", "adm:на/сра")).toEqual({
      titleRanges: [{ start: 0, end: 2 }, { start: 10, end: 13 }], projectRanges: [{ start: 0, end: 3 }],
    });
    expect(matchThreadQuery("Настройка сравнения adm", "Home", "adm:на/сра")).toBeNull();
    expect(matchThreadQuery("Настройка", "Admin сравнения", "adm:на/сра")).toBeNull();
    expect(matchThreadQuery("Настройка сравнения", "Admin", "фвь:на/сра")).not.toBeNull();
  });
  it("uses only the first colon, preserves spaces and permits empty sides", () => {
    expect(matchThreadQuery("URL http:server", "Admin", "adm:http:server")).not.toBeNull();
    expect(matchThreadQuery("Тред", "Admin", "adm:")).not.toBeNull();
    expect(matchThreadQuery("Сервер", "Home", ":cthdth")).not.toBeNull();
    expect(matchThreadQuery("Сервер", "Home", ":")).toEqual({ titleRanges: [], projectRanges: [] });
    expect(matchThreadQuery("Сервер", "Admin", "adm :сервер")).toBeNull();
    expect(matchThreadQuery("Сервер", "Admin", "adm: сервер")).toBeNull();
    expect(matchThreadQuery("Admin", "Home", "adm")).toEqual({ titleRanges: [{ start: 0, end: 3 }], projectRanges: [] });
  });
});

describe("approximate thread titles", () => {
  it.each(["публкации", "публликации", "публкиации", "публыкации", "ge,krfwb"])(
    "finds a title with one typo in %s",
    (query) => {
      const result = matchThreadQuery("План публикации", "Admin", `adm:план/${query}`);
      expect(result?.fuzzyParts).toBe(1);
      expect(result?.titleRanges[0]).toEqual({ start: 0, end: 4 });
      expect(result?.titleRanges[1]?.start).toBe(5);
    },
  );

  it("keeps the project prefix, literal spaces and shorter terms exact", () => {
    expect(matchThreadQuery("План публикации", "Admin", "admn:публкации")).toBeNull();
    expect(matchThreadQuery("План публикации", "Admin", "публкации ")).toBeNull();
    expect(matchThreadQuery("Сервер", "Admin", "срв")).toBeNull();
    expect(matchThreadQuery("Сервер", "Admin", "proxy")).toBeNull();
    expect(matchThreadQuery("План публикации", "Admin", "публикации")?.fuzzyParts).toBeUndefined();
  });
});

describe("complete metadata instead of loaded sidebar pages", () => {
  it("continues across short pages, offsets before dedup, until an empty page", async () => {
    const list = vi.fn().mockResolvedValueOnce([entry({ id: "one" })])
      .mockResolvedValueOnce([entry({ id: "one" }), entry({ id: "two" })]).mockResolvedValueOnce([]);
    const result = await listSearchThreads({ threads: { list } }, false, new AbortController().signal);
    expect(result.map((t) => t.id)).toEqual(["one", "two"]);
    expect(list.mock.calls.map(([arg]) => arg.offset)).toEqual([0, 1, 3]);
    expect(list.mock.calls.every(([arg]) => arg.includeHidden && arg.archived === false)).toBe(true);
  });
  it("never calls a partial traversal complete when a later page fails", async () => {
    const list = vi.fn().mockResolvedValueOnce([entry()]).mockRejectedValueOnce(new Error("offline"));
    await expect(listSearchThreads({ threads: { list } }, true, new AbortController().signal)).rejects.toThrow("offline");
  });
  it("keeps an active child's effective project stable with an archived parent", async () => {
    const child = entry({ id: "child", projectId: "A", parentThreadId: "parent" });
    const parent = entry({ id: "parent", projectId: "B", archivedAt: 1, visibility: "hidden" });
    const get = vi.fn().mockResolvedValue(parent);
    const byId = await completeAncestors({ threads: { get } }, [child], new AbortController().signal);
    expect(effectiveProject(child, byId)).toBe("B");
    expect(effectiveProject(child, new Map([[child.id, child], [parent.id, parent]]))).toBe("B");
    expect(get).toHaveBeenCalledOnce();
  });
  it.each([403, 404])("stops at unavailable ancestor (%s), but not an arbitrary failure", async (status) => {
    const child = entry({ parentThreadId: "private" });
    const byId = await completeAncestors({ threads: { get: vi.fn().mockRejectedValue({ status }) } }, [child], new AbortController().signal);
    expect(effectiveProject(child, byId)).toBe("app");
    await expect(completeAncestors({ threads: { get: vi.fn().mockRejectedValue(new Error("offline")) } }, [child], new AbortController().signal)).rejects.toThrow("offline");
  });
  it("rejects cycles and excludes deleted ancestors", async () => {
    const child = entry({ id: "c", parentThreadId: "p" });
    const get = vi.fn().mockResolvedValue(entry({ id: "p", deletedAt: 1 }));
    expect(effectiveProject(child, await completeAncestors({ threads: { get } }, [child], new AbortController().signal))).toBe("app");
    await expect(completeAncestors({ threads: { get } }, [entry({ id: "c", parentThreadId: "c" })], new AbortController().signal)).rejects.toThrow("цикл");
  });
  it("selects a filter's multiple projects and never admits foreign pinned exceptions", () => {
    const document = { ...defaultFilterDocument(), pinnedMode: "always-show" as const,
      filters: [{ id: "work", name: "Work", rule: { kind: "nameGlobs" as const, globs: ["work-*"] } }] };
    const projects = [{ id: "a", name: "work-a", isPersonal: false }, { id: "b", name: "work-b", isPersonal: false }, { id: "c", name: "home", isPersonal: false }];
    expect([...filterProjectIds("work", document, projects)]).toEqual(["a", "b"]);
    expect(() => filterProjectIds("deleted", document, projects)).toThrow("удалён");
  });
});
