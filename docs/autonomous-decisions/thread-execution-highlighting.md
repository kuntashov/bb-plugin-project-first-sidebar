# Thread execution highlighting decisions

## Rebuild during another job

The service has one shared job. Initial fill and rebuild both produce a full index, so a rebuild request joins either job. Recovery rechecks an existing index and is not itself a full rebuild: the control is disabled with an explanation until recovery completes. Afterwards a rebuild can be started normally. This avoids overlapping jobs and a misleading success indication.

## Workflow substitutions

The `to-spec` and `to-tickets` skills were unavailable. Their contracts were reproduced through a local specification, an independent specification challenge, and local dependency-linked tickets. No external tracker is used.

## Execution index schema

The public base has no execution-index storage migrations. The feature-only intermediate schemas were not shipped or installed; installation of intermediate slices was explicitly excluded. The first release therefore creates the final execution-index schema directly. It does not infer job history from intermediate schemas, and upgrades from those unreleased schemas are not supported. Crash recovery and resume apply to databases created with the final schema.
