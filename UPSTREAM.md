# Upstream provenance

The original standalone foundation was extracted from [get-bb/bb](https://github.com/get-bb/bb), tag `desktop-v0.46.1`, commit `411eac54ac16d0a3cb57d1de8396d37564884a73`.

Source areas:

- `plugins/thread-list`: thread list, rows, sections and interactions.
- `packages/shared-ui/src`: vendored UI, hooks and supporting utilities.
- `packages/plugin-registry/flavors/components/ui/icon.tsx`: standalone public icon wrapper.

The MIT copyright notice for Michael Yong is preserved in LICENSE. This repository distributes the derived code under MIT and does not claim the upstream implementation as original work.

Compatibility with BB 0.48.1 uses public SDK 0.6.104 and the release `desktop-v0.48.1`, commit `e003e9510cbfd3bb6c26a28630b46ffb1c242a44`. The thread action target forwards `parentNotifications` as required by that release.

The built-in icon catalogue contains 180 names, copied from that 0.48.1 release's `CORE_ICON_MAP` keys and `EXTENDED_ICON_NAMES`; the public BB icon renderer supplies the glyphs. No private registry implementation is imported. Exact source paths and hashes are recorded in `checks/filter-appearance/icon-catalog.json`.

`app/filters/ClearFilterIcon.tsx` adapts the upstream Filter funnel path with an upper-left X, using a 24-unit viewBox, currentColor and 1.5-unit round strokes matching BB's icons. The same MIT attribution applies.

Local extensions include project-first defaults, an independent preferences namespace and one-time validated Thread-list import, versioned filter definitions and icons, revision-checked mutations and realtime invalidation, window-local selection, full-snapshot projection, pinned policy, static/glob membership, the shared settings/dialog editor, and reveal history that retains full-snapshot continuity while limiting emissions to visible rows. Normal host thread actions still use the public SDK.

The initial public export is based on the tested standalone 0.3.4 source. Production source files and the test suite are retained; private deployment receipts, environment snapshots and operational Git history are not included. `docs/source-export.json` records hashes of the copied files. Packaging metadata, public documentation and GitHub Actions are prepared separately for the public 0.4.0 release. The working local deployment is not replaced by publication.
