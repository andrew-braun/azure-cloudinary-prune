# Cloudinary Prune Plan Review Feedback (2026-03-23)

This note captures the key feedback and decisions from the latest plan review so we can revisit implementation details later.

## 1) continueAsNew behavior and repeat safety

- `continueAsNew` restarts the orchestrator with new input.
- It keeps the same instance ID and resets orchestration history.
- It does **not** automatically deduplicate external side effects.
- To avoid repeats, pass forward durable progress state (`nextCursor`, summary counters, etc.) and process only from that checkpoint.
- If an orchestrator hits an uncaught exception, it fails; `continueAsNew` does not rescue that failure.
- Incomplete tasks at the moment `continueAsNew` is called are discarded, so call it only at clean boundaries (end of page or batch).

## 2) Overall direction

- Using paged processing + `continueAsNew` is a strong fit for ~26k assets and avoids very large orchestration history/replay overhead.

## 3) PNG-only URL constraint (Strapi links directly to PNG)

Because URLs currently depend on `.png`, changing format to JPG is high-risk.

Expected savings with PNG-only optimization:

- Typical for photo-like PNGs: ~10% to ~30%
- Good case: ~30% to ~45%
- Exceptional (flat graphics/limited colors): can exceed 50%

For this dataset (large content images), realistic portfolio expectation is roughly **15% to 30%** unless many files are illustration-like.

## 4) Idempotency options (best choices)

### Recommended: Azure Table checkpoint ledger

Store one row per `public_id` with:

- state (`processing`, `completed`, `failed`)
- original/compressed bytes
- backup blob path
- timestamps
- last error

Behavior:

- Upsert `processing` when starting
- Upsert `completed` only after successful backup + upload
- Skip already completed on reruns

### Alternatives

- Blob-only marker check (simpler but weaker correctness)
- Cloudinary tag/context marker (works, but can increase Admin API use)

## 5) Downsides to note

Idempotency tradeoffs:

- Table ledger: extra storage ops + more code complexity
- Blob-only: weaker during partial failures
- Cloudinary marker: can consume Admin API budget if read-before-write checks are frequent

Transparency detection tradeoff:

- Full alpha scan: better correctness, higher CPU cost
- Sampling alpha: faster, but risk of false negatives on sparse transparency

## 6) Rate limit strategy (2000/hr Admin API)

Static pacing is acceptable with this constraint.

Important Cloudinary behavior:

- Admin API is rate-limited
- Upload API is not rate-limited

Practical implication:

- Keep Admin calls for paging/resource listing only
- Avoid per-image Admin lookups

## 7) Retry strategy (needed)

Use layered retries:

- Orchestrator-level retries for activities (exponential backoff)
- Operation-level retries inside activity for download/upload on transient failures (`429`, `5xx`, timeouts)
- Respect `Retry-After` where provided
- Do not endlessly retry deterministic failures (unsupported format, persistent corrupt input)

Suggested baseline:

- max attempts: 4
- initial delay: 5s
- backoff coefficient: 2
- max delay: 60s
- add jitter

## Confirmed plan adjustments from discussion

- Auth/security: lock `/api/start` and `/api/status` for production
- Backup integrity: store checksum + size + content-type metadata
- Observability: add structured per-batch logs and progress status
- Concurrency tuning: keep default 3, but make configurable via env var
- Prefix filtering: enforce strict basename starts with `Picture_of`

## Context7 note

Context7 access was available after activating the library-resolution tools in this session. Docs were then queried for Durable Functions, Sharp, and Cloudinary references.

## Key references consulted

- Durable Functions eternal orchestrations (`continueAsNew`):
  - https://learn.microsoft.com/azure/azure-functions/durable/durable-functions-eternal-orchestrations
- Durable Functions error handling and retries:
  - https://learn.microsoft.com/azure/azure-functions/durable/durable-functions-error-handling
- Sharp PNG options:
  - https://github.com/lovell/sharp/blob/main/docs/src/content/docs/api-output.md
- Cloudinary Admin API:
  - https://cloudinary.com/documentation/admin_api
- Cloudinary Upload API:
  - https://cloudinary.com/documentation/image_upload_api_reference
