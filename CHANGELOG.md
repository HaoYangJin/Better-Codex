# Changelog

All notable changes to Better Codex Info are documented here.

## [0.1.0] - 2026-10-22

### Added

- DSH-style Codex companion capsules for rounds, steps, TPS, cumulative tokens, cache hit rate and context usage.
- Detailed session, token and context popovers.
- In-place analytics center with totals, switchable Token/cache/speed/tool trends, history filters, per-turn metrics and tool distribution.
- Local incremental indexing for Codex rollout logs and read-only access to Codex SQLite metadata.
- Token budget, context threshold and cache-rate notification rules.
- CSV and JSON metric export.
- Windows NSIS packaging, macOS x64/arm64 build configuration and cross-platform CI.

### Notes

- This is the first public release.
- Context composition and legacy TTFT values can be approximate and are labelled in the UI.
- macOS packages require a macOS runner and are unsigned until a Developer ID certificate is configured.
