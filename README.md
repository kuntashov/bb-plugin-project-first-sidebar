# Project-first Sidebar for BB

An experimental sidebar replacement for [BB](https://github.com/get-bb/bb): projects first, with shared project filters and familiar thread controls.

## Features

- Organize loaded threads by project, section or machine.
- Switch between All, projectless and custom project filters without changing thread membership.
- Choose projects explicitly or match project names with `*` and `?` globs.
- Assign a BB icon or PNG to each custom filter; display text, icons, or both.
- Keep the filter toolbar visible while scrolling.
- Use pinned threads, nested threads, section controls and supported drag-and-drop destinations.
- Edit the same shared definitions from the sidebar menu or plugin settings.
- Optionally highlight thread titles by their last accepted execution configuration.

The filter interface currently uses Russian labels. Active selection is local to each window and resets on reload. Definitions, icons and display policy are shared. Filtering uses the loaded sidebar snapshot and manually loaded archive pages; it does not search unloaded archives.

## Requirements

BB **0.48.1 or newer** with a compatible Plugin SDK (`>=0.6.104 <0.7`). The verified baseline is BB 0.48.1 / SDK 0.6.104; newer releases may require compatibility fixes. The plugin uses BB's public experimental Plugin SDK. No BPM plugin or external service account is required.

## Install

After the package has been published:

```sh
bb plugin install 'npm:bb-plugin-project-first-sidebar@^0.4.0'
```

The npm package includes prebuilt backend/frontend artifacts, so BB does not compile the frontend locally for this installation source. Git and path installations can rebuild source on the BB host.

For an existing Thread-list setup, keep Thread-list enabled while importing its preferences in the plugin Settings page. Check that import succeeded, then disable Thread-list and select **Project-first sidebar** under Settings → Interface → Sidebar. Existing Project-first values take priority over imported values.

Compatible npm updates can be checked and applied with `bb plugin outdated` and `bb plugin update`. Review the selected version and source before applying an update.

## Filters and icons

The ⋯ menu beside the filter toolbar opens the editor. Custom rules select ordinary projects by ID or match full project names with case-insensitive globs. Spaces in patterns are significant; `?` matches one Unicode code point. Personal-project threads are excluded from custom membership; use the projectless built-in filter when appropriate.

Uploaded icons are static PNG files up to **64 KiB**, with each dimension from **1 to 512 px**, rendered in a **16×16 px** box. The shared document has a **255 KiB** total budget. Built-in icons use BB's own public icon renderer.

Definition edits use Save/Cancel. Reordering, deletion, display mode and pinned policy are separate mutations; deletion asks for confirmation. Revision conflicts require rereading before retrying. Selecting a filter does not itself change collapse preferences or navigate to another thread.

## Execution highlighting

In the sidebar's **Organize → Rows** menu, enable **Execution highlighting** beside **Provider icons**. It is off by default and the setting is shared across windows. Only the thread title changes colour:

| Reasoning | Service tier | Title colour |
| --- | --- | --- |
| High+ | fast | Red |
| High+ | Other or unknown | Orange |
| Other or unknown | fast | Purple |
| Other or unknown | Other or unknown | Ordinary |

High+ means exactly `high`, `xhigh`, `ultracode`, `max` or `ultra`. Fast means exactly `fast`: `ultrafast` and `priority` are not treated as fast, and custom reasoning IDs are not inferred to be High+. Each value is classified independently, so a known value can still determine the colour when the other is unknown.

The colour describes the request associated with the **last accepted** input in the thread's own saved history. Drafts, queued or rejected inputs and project defaults do not change it; it describes the requested configuration, not any later provider fallback. Idle and archived threads retain their last accepted configuration. A fork includes its copied history and can acquire a colour after that history is read, without a new run; later changes to the source do not propagate. A normal child without copied history does not inherit its parent's colour. The title's explanation gives the values and their origin.

When there is no accepted input in the available history, the title has its ordinary colour. Loading, unverified and error states also have no colour, but do not mean there was no accepted input. If history cannot be read or the accepted input cannot be matched to its request, the explanation reports an error instead of treating it as absent.

## Execution index

The index fills in the background for visible, nondeleted threads, including the archive, even when highlighting is off. In the plugin settings, **Execution index** shows the job type and state, processed and discovered counts, thread errors and the outcome. Counts can change as threads are added or removed. Use **Rebuild execution index** to start a rebuild; a request during an initial fill or rebuild joins the existing job shared by all windows. During recovery or synchronization the button may be disabled with a message to wait.

The working index remains available and continues to receive updates during a rebuild. A successful rebuild replaces it; a failed rebuild keeps the working index and its progress can be retried. An error limited to the new index does not erase verified working data. If a live update cannot be verified, its old colour is not presented as current.

Interrupted work resumes automatically, and after restart or reconnection the index checks for missed changes. Cached results are unverified until checked, so updates may take time; this is not an atomic snapshot across BB and the plugin. A history response can fail with HTTP **413** when even a single event exceeds the SDK response limit (approximately 8 MiB). The affected history is reported as an error, the full rebuild cannot succeed, and the working index remains in use. Rebuilding alone cannot make an oversized event readable.

## Develop

Use Node 24 and npm. A running BB server is not needed to build.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run check:package
```

`bb-app@0.48.1` and `@get-bb/plugin-sdk@0.6.104` pin the compiler and SDK. The build script uses that local BB executable and clears `BB_CLI` so an enclosing BB session cannot redirect the build to a different installation.

GitHub-hosted Actions run the same checks and upload a ready npm tarball. A `vX.Y.Z` tag additionally publishes the verified tarball to npm and creates a GitHub Release. See [release setup](docs/RELEASING.md).

## Provenance and license

Derived from BB's MIT-licensed Thread-list and shared UI. Original attribution is preserved in [LICENSE](LICENSE); extraction bases and local extensions are described in [UPSTREAM.md](UPSTREAM.md). This is a third-party plugin, not an official BB plugin.

## Quick thread navigation

The “Найти тред по фильтру” command opens a keyboard-driven filter → thread picker. Match literal title fragments separated by `/`, with highlighted matches. Alt+A includes the complete archive. Enter opens the thread, applies the project filter and focuses its sidebar row. [Usage and keyboard controls](docs/quick-thread-search.md).
