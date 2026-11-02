---
name: project-first-sidebar
description: Inspect or change Project-first sidebar layout preferences and project filters, or retry its snapshot import from Thread-list.
---

# Project-first sidebar

Use `bb project-first-sidebar prefs list --json` to inspect effective preferences.
Use `prefs get <key>`, `prefs set <key> <JSON-or-bare-word>`, or `prefs reset <key>`
with the same command prefix. `prefs list` includes descriptions and known keys.

For migration, inspect `bb project-first-sidebar prefs import-status --json`.
Keep the source Thread-list enabled, then run
`bb project-first-sidebar prefs import --json` to retry a failed import.
The result has `state` (`imported`, `absent`, `failed`), `imported` key names and
`message`. Failed results exit 1. `absent` means the source is not installed;
read/validation/write errors return `failed`. Only `imported` authorizes continuing
an existing user's transition. Own values always win; successful imports are one-time.

The same import/retry control is in the plugin's Settings page. After success,
disable the source Thread-list and select Project-first sidebar in
Settings → Interface → Sidebar. Follow the operator's authorization for live changes.
The two providers running together are outside the supported v1 workflow.

## Project filter document

Read the shared, versioned document with:

```text
bb project-first-sidebar filters list [--json]
```

Every mutation requires the revision returned by the latest read. A stale write exits 1
with `filter_revision_conflict`; read again and decide whether to reapply the change.
Successful mutations return the complete document with revision incremented by one.

```text
bb project-first-sidebar filters create --name NAME --project-ids-json '["proj_..."]' --expected-revision N [--json]
bb project-first-sidebar filters create --name NAME --globs-json '["work-*"]' --expected-revision N [--json]
bb project-first-sidebar filters update FILTER_ID --name NAME --project-ids-json '[]' --expected-revision N [--json]
bb project-first-sidebar filters delete FILTER_ID --expected-revision N [--json]
bb project-first-sidebar filters reorder FILTER_ID... --expected-revision N [--json]
bb project-first-sidebar filters pinned-mode <filter|always-show> --expected-revision N [--json]
```

Create and update require exactly one rule option. `--project-ids-json '[]'` is a valid
empty static filter. Glob arrays ignore only exactly empty strings; whitespace-only lines
remain significant. Reorder must contain every current user-filter ID exactly once.
Filter IDs are opaque server values: copy them from `filters list` and do not derive them.

The backend exposes the equivalent typed RPC methods `listFilters`, `createFilter`,
`updateFilter`, `deleteFilter`, `reorderFilters`, and `setPinnedMode`. Mutations return
`success`, typed `conflict`, or a stable error code with issues. The realtime channel
`project-first-sidebar.filters` carries only `{ revision }` invalidations; consumers must
refetch the document.

The sidebar renders `Все`, `Без проектов`, then user filters in document order. The active
choice is window-local and memory-only: it survives provider remount/compact drawer in the
current bundle generation, while reload and a new window start at `Все`. Definitions are
shared between windows. The same editor is available from the sidebar management button
and the plugin Settings page; it supports static ordinary-project selection, name-glob
rules, full-catalog preview, explicit conflict reread, reorder/delete and pinned policy.

Filtering is a projection of the loaded SDK snapshot and loaded archive pages. It does not
perform server-side archive search, persist the active choice, infer a creation project for
a multi-project filter, or change thread membership merely by selecting a filter. Real
browser/Electron/native-pointer/live-backend acceptance is not established by the synthetic
harness. Do not install/reload a path plugin on a host where source builds are prohibited.
