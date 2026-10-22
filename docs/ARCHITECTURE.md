# Architecture

## Runtime layers

1. **Codex discovery** finds `CODEX_HOME`, rollout JSONL files, global UI state and read-only Codex SQLite databases.
2. **Session parser** streams each changed rollout and extracts metadata plus numerical metrics. Message text is reduced to character weights and discarded.
3. **Metrics repository** stores a local SQLite projection and serves typed IPC queries for the live snapshot, history, turns and time series.
4. **Overlay controller** tracks the Codex window, positions the frameless window and resizes it between capsule, popover and analysis surfaces.
5. **Renderer** presents DSH-style capsules and uses Recharts for local-only trend visualizations.

## Storage

`sessions` stores one aggregate row per Codex thread. `turns` stores per-turn latency, token and tool summaries. Full snapshots and turns are stored as JSON in the application database for lossless renderer responses; source text is never included.

Each indexed file has size, modification time and parser version. An unchanged file is skipped. When a parser version changes or a rollout is truncated, that rollout is rebuilt.

## Refresh path

- Recursive directory watcher triggers a 250 ms debounced scan.
- A four-second polling fallback catches missed filesystem events.
- Changed rollouts update the local projection and broadcast a fresh snapshot through IPC.
- Analysis queries use the same projection with SQL filters and in-memory aggregation.

## Metric model

Token snapshots from `token_count` and `token_usage_record` are normalized into input, cached input, uncached input, cache-write input, output, reasoning output and total.

Model and tool intervals are unioned so overlapping events are not counted twice. Turn duration prefers `task_complete.duration_ms`; current turns use event timestamps. TPS uses output tokens over model-active time.

Context categories use recorded system/developer text, dynamic tool schema lengths and conversation item lengths. Their ratios are scaled to the latest measured request Token count.

## Security boundaries

- Codex SQLite files are opened with `readonly: true`.
- Renderer has context isolation, sandboxing and no Node integration.
- The preload exposes a narrow typed IPC API.
- The renderer has a restrictive Content Security Policy.
- No network APIs, credentials or remote services are used.
