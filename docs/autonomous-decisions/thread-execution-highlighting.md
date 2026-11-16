# Thread execution highlighting decisions

## Rebuild during another job

The service has one shared job. Initial fill and rebuild both produce a full index, so a rebuild request joins either job. Recovery rechecks an existing index and is not itself a full rebuild: the control is disabled with an explanation until recovery completes. Afterwards a rebuild can be started normally. This avoids overlapping jobs and a misleading success indication.

## Workflow substitutions

The `to-spec` and `to-tickets` skills were unavailable. Their contracts were reproduced through a local specification, an independent specification challenge, and local dependency-linked tickets. No external tracker is used.
