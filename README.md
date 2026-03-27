# Cloudinary PNG Migration Function

Durable Azure Function app for recompressing in-scope Cloudinary PNG assets while preserving existing URLs.

## Endpoints

- `POST /api/start` starts the migration orchestration.
- `GET /api/status/{instanceId}` returns durable orchestration status and custom summary.

Both endpoints use `authLevel: function`.

## Current Workflow

1. Orchestrator fetches a page of Cloudinary assets.
2. It filters to `image/png` assets with basename prefix `Picture_of`.
3. Assets are processed in configurable batches.
4. Each image is backed up to Azure Blob Storage before any overwrite.
5. A Table Storage ledger tracks `processing`, `completed`, `skipped`, and `failed` states.
6. At page boundary, orchestration uses `continueAsNew` with the next cursor.

## Required App Settings

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `AZURE_STORAGE_CONNECTION_STRING`
- `AzureWebJobsStorage`

## Operational App Settings

- `AZURE_BACKUP_CONTAINER` (default `cloudinary-backups`)
- `LEDGER_TABLE_NAME` (default `ImageMigrationLedger`)
- `LEDGER_PARTITION_KEY` (default `cloudinary-png-migration`)
- `PAGE_SIZE` (default `500`)
- `BATCH_SIZE` (default `50`)
- `DELAY_BETWEEN_BATCHES_SEC` (default `120`)
- `SKIP_RATIO_THRESHOLD` (default `0.9`)
- `MIN_SAVINGS_RATIO` (default `0.1`)
- `DRY_RUN` (`true` recommended for first execution)

## Local Development

```bash
npm install
npm run build
func start
```

## Start Migration

```bash
curl -X POST "http://localhost:7071/api/start?code=<function-key>" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true}'
```

Optional body fields:

- `nextCursor`
- `runId`
- `dryRun`
- `pageSize`
- `batchSize`
- `delayBetweenBatchesSec`
