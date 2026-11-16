# Thread execution highlighting

## Problem statement

A sidebar user cannot see which threads last ran with higher reasoning or the fast service tier without inspecting each thread. The sidebar needs a concise, optional indication that remains correct as histories, membership and connections change, without disturbing existing navigation or controls.

## Solution and meaning

When enabled, colour only each thread's title according to the **last accepted execution configuration** in that thread's own saved event history. This is the normalized reasoning level and service tier of the request correlated with the latest `turn/input/accepted`, not a draft, a queued or rejected request, project defaults, or the actual configuration after provider fallback. An idle or archived thread retains its last accepted colour. A fork includes its copied saved history and receives its result after successful background reading without a new run; until then it is loading, or error if reading fails. Later changes to the source do not propagate. A normal child without copied history starts without an accepted configuration.

| Reasoning | Service tier | Title |
| --- | --- | --- |
| High+ | fast | red |
| High+ | other or unknown | orange |
| other or unknown | fast | purple |
| other or unknown | other or unknown | ordinary |

High+ is exactly `high`, `xhigh`, `ultracode`, `max`, `ultra`. Fast is exactly `fast`; `ultrafast`, `priority` and custom reasoning IDs are not inferred to belong. Classify each known dimension independently and explain unknown values accurately. No accepted event anywhere in the available own history means absent, with ordinary title colour. Loading, unverified and error are distinct from absent and must not assert a colour as current.

## User stories and acceptance criteria

1. As a user, I want one synchronized opt-in under Organize → Rows beside Provider icons, default off, so that I control the appearance across windows.
2. As a user, I want the four colour combinations above, including independently unknown dimensions, so that the title reflects only supported facts.
3. As a user, I want an accessible explanation of the values, their origin and when they update, while the full title remains accessible.
4. As a user, I want a newly accepted configuration to update without reloading, while draft, queued and rejected inputs leave it unchanged.
5. As a user, I want the same semantics in active, idle, archived, pinned and nested threads and every grouping mode, without colour propagation to parents, children, projects or sections.
6. As a user, I want fork history represented after successful background reading without a new run, with loading or error shown until then, independently from later source changes; a normal child must not inherit its parent's configuration.
7. As a user, I want status icons and colours, active/split/hover backgrounds, reveal highlighting, links, mention chips, rename, selection, keyboard navigation, filtering, sorting, placement and drag-and-drop to keep working. Both light and dark themes must remain legible.
8. As a user, I want the index to fill automatically in the background for all visible, nondeleted threads, including the entire archive, without opening a window, expanding a group or enabling the option. The server and ordinary sidebar must not wait for completion.
9. As a user, I want a settings action to rebuild the index, with current state, processed/discovered counts, errors and outcome; counts may change as the catalogue changes.
10. As a user with multiple windows, I want a rebuild request during initial fill or rebuild to join that current full job, and a working index to remain available and live during rebuild. During recovery, the rebuild button is disabled and explicitly says to wait for recovery to finish; afterwards I can start a full rebuild.
11. As a user, I want interrupted work resumed automatically and missed changes reconciled after restart or reconnect, without a separate concurrent recovery job or manual rebuild.
12. As a user, I want an explicit error when history cannot be read or correlated, rather than a misleading ordinary or stale colour; a building-only error must preserve verified working data. Report errors at list/settings level without one toast per row.
13. As a user, I want a failed rebuild to retain the working generation and checkpoint, and a retry to continue failed work and recheck changes.
14. As a user, I want a successful rebuild to replace the index atomically within plugin storage, with subsequent changes converging through live reconciliation.

## Implementation decisions and invariants

### Boundaries and extraction

- Use public SDK history and events, plugin-owned SQLite via storage API, plugin RPC and realtime. Do not read or modify BB's main database, patch core, add an alternative SQL read, or infer missing data. Persist only the normalized pair, provenance identifiers/sequences and projection/job state; never store message text or a full event copy.
- For each thread read `turn/input/accepted` descending, limit 1. No accepted yields `absent`. Otherwise search preceding `client/turn/requested`, starting with a narrow limit 1, matching request `requestId` to accepted `clientRequestId`; continue backwards in pages of at most 100 until found or history exhausted. Events need not be adjacent. Malformed payload or missing pair is error, not absent. Inspect SDK shapes and sequence boundaries in supported runtime before finalizing the extractor.
- A history edit can remove a suffix: a lower surviving accepted sequence or no accepted is a valid newer projection. Freshness is a local dirty revision/token plus job/load generation, never `max(acceptedSeq)`. Identity/sequence alone must not be assumed to prove an edited event is unchanged. When an accepted event is demonstrably unchanged, do not reread requested or emit unnecessary invalidation.
- Third-party bridges that do not emit the required events have no additional semantic guarantee. Runtime provider and SDK compatibility must be checked; no claim is made that static analysis proves it.

### Catalogue, jobs and concurrency

- Migrate plugin tables before service startup. Start the background service after factory initialization; factory must not await cold fill. One server-owned job/queue covers initial fill, rebuild and recovery across all windows. The initial job begins when the new version finds an unprepared index; successful initial fill is not repeated on each window open.
- Obtain the full manifest in one public `threads.list({includeHidden:false})` without limit, offset or archived filter, covering visible nondeleted active and archived threads; persist IDs. Verify this contract and response size on supported BB/SDK. Process active before archived with bounded workers (initial target four), at most one read/writer for an ID. UI row rendering and opt-in do not cause history reads.
- Keep `activeGeneration`, one job with kind/state/target generation, per-ID manifest state pending/done/error and projections keyed by generation and ID. Completion order must not be represented by a single offset. Atomic synchronous SQLite transactions join/start the job, and commit current result plus checkpoint. A rebuild request joins an active initial fill or rebuild; while recovery runs the action is disabled and explains that recovery must finish first, after which a full rebuild can be started. Previously running units become pending after a crash. Resume reconciles the catalogue and rechecks even previously done IDs for changes while offline.
- Initial fill can expose verified entries as they finish. A rebuild writes a separate building generation while the working generation remains available and live. A single sequential writer per ID coordinates initial/live/rebuild. A new notification during async reading increments its dirty token; discard stale results and retry. Fence every commit by current token and job/load generation. Write current reconciled results transactionally to working and applicable building generations with checkpoint.
- Register history handlers and one public server `thread:changed` subscription without thread ID plus `realtime:connection` before reconciliation. Visibility changes can arrive as title-changed without a history event. For affected IDs use public `threads.list` with IDs and `includeHidden:false`, without archived filter. On successful exclusion invalidate the token and remove the ID from both generations and manifest; a failed lookup is not exclusion.
- Ensure realtime is ready before the baseline catalogue read or reconcile after first connected. On connected/reconnect/resume, reconcile the complete catalogue including offline additions/deletions, then check latest accepted for existing IDs. While a full catalogue request is in flight, collect membership-changed IDs and recheck them through the same token-fenced queue after applying the snapshot. A stale snapshot must neither resurrect a hidden/deleted ID nor discard a newer visible addition.
- Cutover only when all manifest IDs are done with ready/absent projections and there are no errors, pending IDs, unapplied membership/live dirty work or in-flight writes. The same writer switches active generation and records job success in one synchronous transaction. Fence old job/load results, transfer any still-needed reconciliation to the current generation, emit one invalidation after commit, then clean only old plugin index generations. A crash after pointer commit requires cleanup, not a new rebuild.
- This promises plugin database integrity and eventual convergence subject to delivery, recovery and retry policy; it does not promise an atomic cross-database snapshot or linearizable freshness at cutover. Late BB notifications reconcile the new generation.

### Errors, recovery and lifecycle

- Retry a targeted transient SDK/network/SQLite busy failure at most three times, after 1, 5 and 15 seconds. Persist dirty/error and checkpoint; after exhaustion expose error and require a new trigger (event, rebuild action or restart). Do not poll the full catalogue. `413`, malformed event and unmatchable pair are terminal for automatic retry.
- A live writer failure removes an untrustworthy colour for that ID; a failure confined to the building generation does not erase confirmed working data. No failure is represented as absent. Rebuild failure prevents success and cutover.
- SDK history can return HTTP 413 even at limit 1 when one event exceeds the approximately 8 MiB response limit. A public narrow execution-pair read with the same acceptance semantics was not found. Mark this as an error; full rebuild remains unsuccessful and the working generation remains. Do not add a core patch, direct database access or fallback. Initial fill may show other verified entries.
- At startup, previously cached data is unverified until reconciled; do not present an unverified colour as current. Check all indexed IDs in the background even after a successful prior fill. On browser reconnect, reread the plugin projection if the server remained active.
- Dispose/abort cancels timers, queue and subscriptions and invalidates the load token before SQLite closes. Late asynchronous work must not commit or touch a closed handle.

### Client contract

- Provide validated batch RPC by thread IDs returning distinct loading, ready, absent and error states, plus changed-ID realtime invalidation. Provide job start/join and status RPC. Multiple windows share the server projection and job and reload after reconnect.
- Projection-only updates must reach the row even if title, status and updatedAt do not change. If the projection is folded into a structural sidebar snapshot, its equality/key must include the relevant change. Do not reread history on render. Keep preference synchronization consistent with existing settings.

## Testing decisions

Test externally observable behaviour at the highest practical seams, with deterministic SDK/event, clock, transaction and lifecycle controls. Existing server RPC tests, preference synchronization tests, row tests, sidebar projection tests and reveal/interaction tests provide prior art. Avoid tests that only mirror internal structure.

- **Extractor and SDK boundary:** accepted/requested correlation with intervening events, backwards pages and exhaustion; no accepted; malformed and 413; exact values and unknowns; queued/rejected/draft; fork copied history and source independence; ordinary child; edited/cleared suffix, lower sequence, absent and subsequent accepted; verify that a demonstrably unchanged accepted event avoids rereading requested and extra invalidation, while changed history with the same IDs is reconciled correctly. Validate real supported SDK event shape and built-in provider paths in an isolated runtime where possible.
- **Server service and storage:** migration, complete active/archive catalogue and ordering, bounded concurrency, independent UI/opt-in, one job across windows, initial/rebuild join, disabled recovery action with explanation and a full rebuild available after recovery, progress, out-of-order per-ID checkpoints, resume and done recheck, live update during reads, stale token and generation rejection, working/building atomic writes, transaction failures and no stale colour. Test transient retry timing/exhaustion/new trigger, terminal errors, and disposal with pending callbacks.
- **Membership and cutover:** hidden↔visible via title change, successful removal versus lookup error, offline additions and deletes, first connected/reconnect/resume, catalogue snapshot races in both directions, dirty/in-flight barrier, late writes, crash before and after pointer commit, one invalidation and scoped cleanup. Verify automatic convergence without claiming a cross-database snapshot.
- **Client integration:** synchronized default-off control, both windows, batch/realtime and reconnect, summary-only row update, settings action/progress/error, all classification combinations including unknown/absent/loading/error. Exercise grouping, pins, nesting, archive, selection/split/hover/reveal, mention, rename, navigation and DnD; visually check both themes and accessible full title/explanation.
- **Operational evidence:** measure real cold and warm SDK path, response size and background activity on a suitable isolated runtime; prior direct SQL diagnostics are not SDK performance evidence. Run relevant tests and typecheck locally; plugin build is performed only in GitHub Actions. Record actual runtime and visual coverage separately from synthetic tests.

## Out of scope

Rule editor, configurable colours, implicit inheritance, aggregate project/section colouring, direct BB database access, core/SDK changes, per-row history reads, polling, additional infrastructure, deployment, installation, release and marketplace publication. Existing quick-thread-search and keyboard navigation remain intact.

## Technical verification questions

These are implementation investigations, not new product decisions:

1. Does every supported BB/SDK version in the declared range preserve the unbounded catalogue and archive/hidden semantics, and how large is its response? Verify actual runtime contract before relying on it.
2. What exact event payload shapes, inclusive/exclusive sequence boundaries and identity guarantees apply after edit, clear and fork, and can identical event identifiers conceal changed contents? Verify against SDK and controlled runtime; the freshness requirement above remains mandatory.
3. Which SDK failures are reliably classifiable as transient versus terminal, including SQLite busy and HTTP 413? Verify error shapes so retry policy cannot silently misclassify failures.
4. Can the host lifecycle and SQLite API guarantee synchronous transaction, service disposal ordering and safe cancellation as specified? Exercise crash/abort and late-result seams in the actual host or an isolated harness.
5. What is the practical SDK throughput and per-event response size, and do all built-in provider paths generate the correlated pair? Static evidence and direct SQL timings do not answer runtime acceptance.
6. Which existing tooltip/accessibility and theme mechanisms preserve full title, mention rendering and sufficient legibility? Verify actual rendered UI and keyboard interactions in both themes.
