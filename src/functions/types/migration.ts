export type MigrationSummary = {
	scanned: number
	processed: number
	skipped: number
	failed: number
	originalBytes: number
	compressedBytes: number
	savedBytes: number
	pageCount: number
}

export type MigrationRuntimeConfig = {
	pageSize: number
	batchSize: number
	delayBetweenBatchesSec: number
	skipRatioThreshold: number
	minSavingsRatio: number
	dryRun: boolean
	backupContainer: string
	ledgerTableName: string
	ledgerPartitionKey: string
}

export type OrchestratorState = {
	nextCursor: string | null
	runId: string
	summary: MigrationSummary
	config: MigrationRuntimeConfig
}

export type CloudinaryAsset = {
	publicId: string
	secureUrl: string
	bytes: number
	format: string
	resourceType: string
}

export type FetchAssetPageInput = {
	nextCursor: string | null
	pageSize: number
}

export type FetchAssetPageResult = {
	cursorUsed: string | null
	nextCursor: string | null
	scannedCount: number
	candidateCount: number
	assets: CloudinaryAsset[]
}

export type ProcessImageInput = {
	runId: string
	config: MigrationRuntimeConfig
	asset: CloudinaryAsset
}

export type ProcessImageResult = {
	publicId: string
	status: "completed" | "skipped" | "failed" | "already-handled"
	originalBytes: number
	compressedBytes: number
	savedBytes: number
	ratio: number
	reason?: string
}

export type StartRequestBody = {
	nextCursor?: string | null
	dryRun?: boolean
	runId?: string
	pageSize?: number
	batchSize?: number
	delayBetweenBatchesSec?: number
}

export type UpsertImageLedgerInput = {
	publicId: string
	partitionKey: string
	tableName: string
	payload: Record<string, unknown>
}

export const ORCHESTRATOR_NAME = "migrationOrchestrator"
export const FETCH_ASSET_PAGE_ACTIVITY = "fetchAssetPage"
export const PROCESS_IMAGE_ACTIVITY = "processImage"
export const UPSERT_IMAGE_LEDGER_ACTIVITY = "upsertImageLedger"
