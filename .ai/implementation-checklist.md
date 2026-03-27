# Cloudinary Migration Implementation Checklist

This checklist converts the finalized plan into an execution sequence you can track to completion.

## A. Scope Lock and Final Decisions

- [x] Confirm migration is PNG-safe only (no JPG conversion).
- [x] Confirm in-scope filter is strict basename starts with Picture_of.
- [x] Confirm skip threshold is savings less than 10 percent.
- [x] Confirm concurrency default is 3 and configurable.
- [x] Confirm API pacing defaults (page size 500, batch size 50, delay 120s).
- [x] Confirm dry-run behavior and success criteria.

## B. Project Setup

- [ ] Verify runtime and tooling (Node 18+, Azure Functions v4, Durable Functions support).
- [x] Install dependencies (cloudinary, sharp, @azure/storage-blob, durable-functions, @azure/functions).
- [ ] Ensure Linux-compatible deployment target for sharp.
- [x] Set host settings for durable concurrency.
- [x] Add all required app settings for Cloudinary and Azure Storage.
- [x] Add operational settings (page size, batch size, delay, thresholds, dry-run flag).

## C. Data Model and Idempotency

- [x] Create ImageMigrationLedger table schema.
- [x] Define PartitionKey strategy (single run id or static partition).
- [x] Define RowKey as Cloudinary public_id.
- [x] Implement status transitions: processing, completed, skipped, failed.
- [x] Persist bytes, ratio, backup blob name, checksum, attempts, last error, updated time.
- [x] Enforce idempotency check before processing each asset.
- [x] Ensure completed and skipped assets are not reprocessed.

## D. Function Surface

- [x] Implement POST start endpoint.
- [x] Implement GET status endpoint.
- [x] Protect both endpoints for production (function key or Easy Auth).
- [x] Disable or restrict start endpoint after kickoff.

## E. Orchestrator Implementation

- [x] Define orchestration input state (cursor + summary counters).
- [x] Call fetch page activity with current cursor.
- [x] Fan out process image tasks in bounded batches.
- [x] Fan in results and aggregate summary.
- [x] Apply durable timer delay between batches.
- [x] Set custom status each cycle (processed, skipped, failed, bytes saved, cursor).
- [x] Call continueAsNew only at page boundaries.
- [x] Ensure deterministic orchestration code only.

## F. Asset Discovery Activity

- [x] Implement Admin API pagination using next_cursor.
- [x] Request only required resource fields.
- [x] Filter to image resources and PNG format.
- [x] Apply strict basename prefix filter for Picture_of.
- [x] Return page payload with next cursor and candidate assets.
- [x] Keep Admin API calls page-level only (no per-image Admin fetches).

## G. Image Processing Activity

- [x] Read ledger and short-circuit already completed or skipped records.
- [x] Write processing status before side effects.
- [x] Download source asset bytes.
- [x] Create checksum and record original byte size.
- [x] Write backup to Azure Blob before overwrite.
- [x] Attach backup blob metadata (original bytes, sha256, content type, public id, timestamp).
- [x] Compress with PNG quantization settings.
- [x] Compare compressed vs original ratio and apply skip rule.
- [x] If not skipped and not dry-run, upload overwrite to same public_id with invalidate enabled.
- [x] Record completed or skipped with final metrics.
- [x] Record failed with structured error details.

## H. Retry and Error Policy

- [x] Apply orchestrator-level retry for page fetch and image processing activities.
- [x] Configure retry baseline (4 attempts, 5s first retry, coefficient 2, max 60s).
- [x] Implement activity-level retry for transient download and upload errors.
- [x] Respect Retry-After when available.
- [x] Treat deterministic failures as terminal (unsupported or corrupt data).

## I. Rate-Limit Safety

- [ ] Confirm Admin API rate budget assumptions against 2000 per hour limit.
- [x] Verify no hidden per-image Admin calls.
- [x] Keep static pacing defaults initially.
- [x] Add option to increase delay to 180s without code changes.
- [x] Log rate-limit events and 429 bursts.

## J. Observability and Operations

- [x] Emit per-page logs (cursor, item count, duration).
- [x] Emit per-batch logs (size, success, skip, fail, saved bytes, delay).
- [x] Emit per-image failure logs (public id, error class, message, retry count).
- [ ] Add App Insights queries/dashboard for migration progress.
- [ ] Create alerts for failure ratio threshold and failed orchestration.
- [ ] Create alert for repeated 429 bursts.

## K. Security and Secrets

- [x] Keep Cloudinary and storage secrets in app settings only.
- [ ] Use Key Vault references where possible.
- [x] Confirm no secrets are logged.
- [ ] Confirm production auth mode is enabled before canary.

## L. Validation and Test Gates

### Local Dry Run Gate

- [ ] Run with dry-run enabled (no Cloudinary overwrite).
- [ ] Validate backups are created for sampled assets.
- [ ] Validate checksum metadata and byte metrics.
- [ ] Validate skip logic behavior.
- [ ] Validate summary and status endpoint outputs.

### Production Canary Gate

- [ ] Run on 100 to 300 assets.
- [ ] Validate URL behavior remains unchanged.
- [ ] Validate visual quality on sampled outputs.
- [ ] Validate failure ratio and retry behavior.
- [ ] Validate rate-limit behavior under production conditions.
- [ ] Obtain sign-off before full run.

## M. Full Run and Completion

- [ ] Start full orchestration.
- [ ] Monitor status continuously until completion.
- [ ] Triage and rerun failed assets if needed.
- [ ] Generate final report (scanned, processed, skipped, failed, original bytes, compressed bytes, net saved).
- [ ] Confirm all overwritten assets have backups with checksum metadata.
- [ ] Archive logs, queries, and run summary for audit.

## N. Rollback Readiness

- [ ] Prepare restore script/process from Azure backups.
- [ ] Validate restore to same public_id with invalidate enabled.
- [ ] Document rollback trigger criteria and approval path.
- [ ] Perform a small restore drill on test assets.

## O. Definition of Done Checklist

- [ ] All in-scope assets evaluated.
- [ ] Every asset ends in completed, skipped, or failed state.
- [ ] Failure count is below agreed threshold or fully triaged.
- [ ] No broken delivery URLs reported.
- [ ] Backup integrity verified for overwritten assets.
- [ ] Final summary published and approved.
