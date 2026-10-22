# Project Guidance

## Validation

Before delivery run:

```powershell
pnpm run typecheck
pnpm test
pnpm run build
```

Run `pnpm exec playwright test` when Electron UI or packaging behavior changes.

## Data and privacy

- Never commit real Codex sessions, credentials, databases, or user message content.
- Keep test fixtures synthetic and limited to metric metadata.
- Do not add telemetry or remote application requests without an explicit product requirement.
- The application must continue to read Codex data stores without modifying them.

## Delivery

- Do not commit `release/`, `out/`, `node_modules/`, or `test-results/`.
- Build release artifacts from the final verified commit.
- Release creation requires an explicit request for a concrete version.
- Keep the installer version in `package.json` aligned with the Git tag and release notes.
