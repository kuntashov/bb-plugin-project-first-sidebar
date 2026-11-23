# Dynamic sidebar filter decisions

## Selection and stored filters

The active filter belongs to the current window. Reopening the sidebar keeps the selection, and reloading the window starts at All. The two dynamic filters have in-memory identifiers outside the string IDs of saved project filters. A previously saved filter can keep its ID and name even when its name matches a built-in option.

## Active threads and grouping

Both filters use the full live active-thread snapshot, even when the ordinary sidebar shows only archived threads. The active snapshot supplies the ancestor chain for resolving each thread's effective project before matches are selected. The unread and pending-interaction flags are independent and belong to each thread. Hidden and archived threads are excluded, and each matching pinned thread appears once in its project group.

## Visibility and reveal

Three separate plugin preferences control the built-in buttons. They default to visible. Hiding an active button selects All, and showing the button again leaves the selection unchanged. These preferences use the plugin's own settings storage. The Thread-list import validates and copies the established preference fields without importing plugin-local options.

The dynamic views reuse the sidebar row and its navigation, actions and virtualization. Their flat groups leave the ordinary tree's stored layout intact. Reveal first positions a matching row in the current view. For a missing match it uses the ordinary tree and the existing visibility confirmation when required.

## Search integration

The public execution-highlighting branch already contained the base quick search. The integration applied the search refinement patch from `eadb752` to that base. The refinement keeps project-prefix queries, layout-independent matching and compact virtualized results. Project sections are outside this release candidate.
