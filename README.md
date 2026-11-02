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
