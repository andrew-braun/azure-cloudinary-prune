# Cloudinary Image Migration - Final Plan v2

## 1. Goal

Reduce Cloudinary storage costs by recompressing approximately 26,000 content PNG images currently stored at full resolution (roughly 50 to 75 GB total), without breaking any existing URLs or delivery behavior.

### Final constraints and targets

- Existing CMS links reference `.png` URLs directly, so the migration must remain PNG-safe.
- Every image must be backed up to Azure Blob Storage before overwrite.
- Only content images are in scope: basename starts with `Picture_of`.
- Cloudinary Admin API limit is 2,000 calls/hour; pacing must stay within this limit.
- Skip low-value rewrites where savings are below 10%.

### Revised savings expectation

Because output format stays PNG (no JPG conversion), practical portfolio savings are expected to be:

- Typical: 15% to 30%
- Good: 30% to 45%
- Exceptional (limited-color/graphic assets): above 50%

This replaces the previous 50%+ overall target.

---

## 2. Architecture

### Why Durable Functions

This is a long-running batch workload and should be resilient to restarts. Durable Functions provides:

- deterministic orchestration replay
- checkpointed progress
- manageable fan-out/fan-in for activity work

### Core design update: cursor-driven orchestration with continueAsNew

Instead of loading all assets into one orchestration history, process paged results and continue as new:

1. Fetch one page of assets (`max_results: 500`) via Admin API.
2. Filter to in-scope PNG assets (`Picture_of*`).
3. Process in bounded batches.
4. Persist progress and summary.
5. Call `continueAsNew` with `nextCursor` and updated summary.

This prevents unbounded orchestration history growth and keeps replay fast.

### Function topology

```
POST  /api/start                  -> startMigration (HTTP trigger)
GET   /api/status/{instanceId}    -> checkStatus   (HTTP trigger)

migrationOrchestrator (orchestration)
  -> fetchAssetPage (activity)
  -> processImageBatch (activity fan-out/fan-in)
  -> optional delay timer for pacing
  -> continueAsNew(nextCursor, summary)

Activities
  fetchAssetPage
  processImage
  upsertImageLedger
```

---

## 3. Idempotency and Data Integrity

### Recommended idempotency mechanism: Azure Table ledger

Use a dedicated table (`ImageMigrationLedger`) keyed by `public_id`.

Suggested schema:

- `PartitionKey`: migration run id or static partition (for one-off job, static is fine)
- `RowKey`: Cloudinary `public_id`
- `status`: `processing | completed | failed | skipped`
- `originalBytes`
- `compressedBytes`
- `ratio`
- `backupBlobName`
- `checksum` (SHA-256 of original)
- `attemptCount`
- `lastError`
- `updatedAtUtc`

### Behavior

1. Before processing an image, check ledger.
2. If `completed` or `skipped`, do not reprocess.
3. Write `processing` before external side effects.
4. Only write `completed` after backup and upload succeed.
5. Write `failed` with last error for triage.

### Backup integrity

When writing backup blobs, store metadata:

- `original-bytes`
- `sha256`
- `content-type`
- `cloudinary-public-id`
- `backup-created-at`

Optional hardening for production:

- blob immutability/retention policy for migration window

---

## 4. Rate Limits and Throughput

### Cloudinary API realities

- Admin API is rate-limited.
- Upload API is not rate-limited.

This plan still uses conservative static pacing because Admin calls (list/paging, occasional metadata) must remain safe.

### Pacing defaults

- `PAGE_SIZE=500`
- `BATCH_SIZE=50`
- `DELAY_BETWEEN_BATCHES_SEC=120`
- `MAX_CONCURRENT_ACTIVITY_FUNCTIONS=3`

### Practical strategy

- Keep Admin calls page-based, not per-image.
- Avoid per-image Admin reads during processing.
- If any rate pressure appears, increase `DELAY_BETWEEN_BATCHES_SEC` to 180.

---

## 5. Compression Strategy (PNG-safe)

### Transparency handling

Since all outputs remain PNG, transparency does not force a format branch anymore.

- Keep alpha as-is.
- Use PNG quantization and compression for all in-scope images.

### Sharp settings baseline

```javascript
sharp(input).png({
	compressionLevel: 9,
	palette: true,
	quality: 80,
	colours: 256,
	effort: 8,
})
```

### Skip rule

If `compressedBytes / originalBytes > 0.9`, mark as `skipped` and do not overwrite.

---

## 6. Retry and Failure Policy

Use layered retries for resilience.

### Orchestrator-level retries

Use `callActivityWithRetry` for `processImage` and page fetch activities.

Baseline:

- max attempts: 4
- first retry: 5 seconds
- backoff coefficient: 2
- max interval: 60 seconds

### Activity-level retries

Inside `processImage`, retry transient operations:

- download failures
- upload transient errors (`429`, `5xx`, timeout)

Rules:

- respect `Retry-After` where available
- do not endlessly retry deterministic failures (unsupported/corrupt)

---

## 7. Security

### Endpoint protection

- `startMigration`: do not expose anonymously in production
- `checkStatus`: protected access (function key or Easy Auth)

Recommended:

- Disable or restrict start endpoint after kickoff.
- Keep secrets only in Function App settings/Key Vault-backed references.

### Minimum secrets

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `AZURE_STORAGE_CONNECTION_STRING`
- `AzureWebJobsStorage`

---

## 8. Observability and Monitoring

Use Application Insights for structured telemetry.

### Required logs

- per-page:
  - page cursor
  - page item count
  - page duration
- per-batch:
  - batch size
  - success/skip/fail counts
  - bytes saved
  - delay applied
- per-image failure:
  - public_id
  - error class/message
  - retry count

### Custom orchestration status

Set custom status with:

- processed count
- skipped count
- failed count
- saved bytes total
- current page cursor

### Alerts

- failure ratio above threshold (for example >5% per page)
- orchestration in failed state
- repeated 429 bursts

---

## 9. Configuration

### host.json

```json
{
	"version": "2.0",
	"extensions": {
		"durableTask": {
			"maxConcurrentActivityFunctions": 3,
			"maxConcurrentOrchestratorFunctions": 1
		}
	},
	"extensionBundle": {
		"id": "Microsoft.Azure.Functions.ExtensionBundle",
		"version": "[4.*, 5.0.0)"
	}
}
```

### App settings

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `AZURE_STORAGE_CONNECTION_STRING`
- `AZURE_BACKUP_CONTAINER=cloudinary-backups`
- `PAGE_SIZE=500`
- `BATCH_SIZE=50`
- `DELAY_BETWEEN_BATCHES_SEC=120`
- `SKIP_RATIO_THRESHOLD=0.9`
- `MIN_SAVINGS_RATIO=0.1`
- `MAX_CONCURRENCY=3`
- `DRY_RUN=false`

---

## 10. Rollout Plan

### Phase 1: local dry run

- `DRY_RUN=true`
- do backup + compression + ledger only
- no Cloudinary overwrite
- verify backup integrity and projected savings

### Phase 2: canary in production

- process 100 to 300 images
- validate URL behavior, visual quality, and monitoring
- confirm failure ratio and rate-limit behavior

### Phase 3: full execution

- trigger full orchestration
- monitor status + Application Insights
- tune delay only if needed

### Rollback

- for affected assets, restore from Azure backup and re-upload to same `public_id`
- use `invalidate=true` when restoring

---

## 11. Definition of Done

Migration is complete when all conditions are met:

- all in-scope assets evaluated
- each asset ends in `completed`, `skipped`, or `failed`
- failures are below accepted threshold or triaged with rerun plan
- no broken delivery URLs reported
- backup blobs exist for all overwritten assets with checksum metadata
- summary report produced:
  - total scanned
  - total processed
  - total skipped
  - total failed
  - total original bytes
  - total compressed bytes
  - net bytes saved

---

## 12. Implementation Notes

- Orchestrator code must remain deterministic.
- Do not call network APIs directly in orchestrator.
- Use `context.df.currentUtcDateTime` for timers.
- Keep `continueAsNew` at page boundaries only.

---

## 13. Final Scope Decisions

- Format conversion to JPG is out of scope for this migration because URLs are `.png`-dependent.
- Prefix match rule is strict: basename starts with `Picture_of`.
- Default concurrency remains 3 but is configurable.

---

## 14. References Used During Review

- Durable Functions eternal orchestrations:
  - https://learn.microsoft.com/azure/azure-functions/durable/durable-functions-eternal-orchestrations
- Durable Functions error handling and retries:
  - https://learn.microsoft.com/azure/azure-functions/durable/durable-functions-error-handling
- Sharp PNG output options:
  - https://github.com/lovell/sharp/blob/main/docs/src/content/docs/api-output.md
- Cloudinary Admin API:
  - https://cloudinary.com/documentation/admin_api
- Cloudinary Upload API:
  - https://cloudinary.com/documentation/image_upload_api_reference
