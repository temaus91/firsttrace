# Example Frontend Snapshot

This tiny repository snapshot exists so `examples/minimal.local.config.yaml`
can be validated immediately. Replace it with your own exported or checked-out
application repository before running real investigations.

The `src/` files are generic synthetic bug fixtures for manager-owner triage:

- `src/components/EntityLinks.tsx`: raw route interpolation for slash-containing
  IDs.
- `src/routes/EntityShell.tsx`: blank existing-entity detail screen from parent
  shell fallback.
- `src/routes/entity-url.ts`: route helper URL encoding and decoding behavior.
- `src/api/entity-client.ts`: API request construction with an unencoded ID.
- `src/server/retry-store.ts`: retry/idempotency state-machine ownership.

They intentionally avoid private customer routes, product nouns, repositories,
tenants, channels, or workflow labels.
