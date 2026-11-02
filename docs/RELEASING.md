# Building and releasing

## CI

`.github/workflows/build.yml` runs on pull requests, pushes to main, release tags and manual dispatch. Only GitHub-hosted `ubuntu-24.04` runners are used. The build job has read-only repository permission and does not receive publication credentials. It installs the committed lockfile, checks types, runs the full suite including the public SDK boundary, builds using the pinned BB CLI, validates the package and uploads a tarball, SHA256SUMS and BUILD.json for seven days.

Tests and source are public. Deployment receipts, user filters/icons, host snapshots, credentials and internal Git history are excluded from this repository. The npm `files` allowlist is narrower still; `npm run check:package` rejects unexpected package paths and lifecycle hooks.

## First publication

1. Publish the reviewed repository to GitHub and wait for its build to succeed. Download that run's tarball and verify SHA256SUMS; check BUILD.json against the approved commit.
2. Establish the npm maintainer account with an interactive `npm login`. The first publication of a previously nonexistent package requires that account; a trusted publisher is configured in the existing package's npm settings.
3. Publish the exact reviewed GitHub-built tarball using `npm publish PATH_TO_TARBALL --access public --ignore-scripts`. This one-time bootstrap is separate from the automated OIDC path; do not put a long-lived npm token in the workflow.
4. In npm package settings, configure GitHub Actions trusted publishing for owner `kuntashov`, repository `bb-plugin-project-first-sidebar`, workflow `build.yml`, with direct `npm publish` allowed. Node 24 supplies an npm version supporting OIDC. No GitHub environment is configured by this workflow.
5. Push the immutable release tag matching package.json. The tag run rebuilds and verifies the package. If that exact version and integrity already exist on npm, it preserves the publication and creates the GitHub Release; a different integrity is an error. If the build does not reproduce the bootstrap tarball byte-for-byte, stop and inspect the difference instead of republishing or moving the tag.

The first release is pending until actual GitHub CI, account authentication and registry publication have been verified. A successful local build is not evidence that GitHub Actions has run.

## Subsequent releases

1. Update package.json and package-lock.json to a new version and review the source. Build and test through a pull request/main CI.
2. Create an annotated immutable `vX.Y.Z` tag for the approved commit and push it. The tag must match package.json.
3. The tag workflow builds once. Its publication job has `contents: write` and `id-token: write`, downloads only that run's artifact, verifies checksums, checks npm for a conflicting version, publishes through trusted OIDC, and creates a GitHub Release with the tarball and checksums.
4. Confirm the run, registry integrity and release assets before announcing the release. Never move an existing release tag or overwrite a published version.

PRs and manual build runs never publish. Release concurrency does not cancel an in-progress tag run. Caches are disabled for the configured build tool setup. The workflow does not install into or restart any running BB server; installation/update is a separate operator action.

## Local validation

Run the commands in the root README. `bb plugin build` downloads its pinned esbuild/Tailwind toolchain on first use. Runtime source entrypoints and required dist files are included in npm, while tests, operational checks, development scripts and credentials are excluded. A Git/path installation can build on the BB host; use the prebuilt npm source when avoiding a local frontend build is required.
