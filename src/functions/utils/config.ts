import { HttpRequest } from "@azure/functions"
import { MigrationRuntimeConfig, StartRequestBody } from "../types/migration"

export function getRuntimeConfig(): MigrationRuntimeConfig {
	return {
		pageSize: toPositiveInt(process.env.PAGE_SIZE, 500),
		batchSize: toPositiveInt(process.env.BATCH_SIZE, 50),
		delayBetweenBatchesSec: toPositiveInt(
			process.env.DELAY_BETWEEN_BATCHES_SEC,
			120,
		),
		skipRatioThreshold: toNumber(process.env.SKIP_RATIO_THRESHOLD, 0.9),
		minSavingsRatio: toNumber(process.env.MIN_SAVINGS_RATIO, 0.1),
		dryRun: toBoolean(process.env.DRY_RUN, false),
		backupContainer: process.env.AZURE_BACKUP_CONTAINER ?? "cloudinary-backups",
		ledgerTableName: process.env.LEDGER_TABLE_NAME ?? "ImageMigrationLedger",
		ledgerPartitionKey:
			process.env.LEDGER_PARTITION_KEY ?? "cloudinary-png-migration",
	}
}

export function requireSetting(name: string): string {
	const value = process.env[name]
	if (!value) {
		throw new Error(`Missing required app setting '${name}'.`)
	}

	return value
}

export async function parseStartBody(
	request: HttpRequest,
): Promise<StartRequestBody> {
	return parseJsonBody<StartRequestBody>(request, {})
}

export async function parseJsonBody<T>(
	request: HttpRequest,
	fallbackValue: T,
): Promise<T> {
	if (!request.headers.get("content-type")?.includes("application/json")) {
		return fallbackValue
	}

	try {
		return (await request.json()) as T
	} catch {
		return fallbackValue
	}
}

export function isStartMigrationEnabled(): boolean {
	return toBoolean(process.env.START_MIGRATION_ENABLED, true)
}

export function getStartMigrationLockReason(): string | undefined {
	const value = process.env.START_MIGRATION_LOCK_REASON?.trim()
	if (!value) {
		return undefined
	}

	return value
}

export function toPositiveInt(input: unknown, defaultValue: number): number {
	const parsed = Number(input)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return defaultValue
	}

	return Math.floor(parsed)
}

export function toNumber(input: unknown, defaultValue: number): number {
	const parsed = Number(input)
	if (!Number.isFinite(parsed)) {
		return defaultValue
	}

	return parsed
}

export function toBoolean(input: unknown, defaultValue: boolean): boolean {
	if (typeof input === "boolean") {
		return input
	}

	if (typeof input === "string") {
		const normalized = input.trim().toLowerCase()
		if (normalized === "true") {
			return true
		}

		if (normalized === "false") {
			return false
		}
	}

	return defaultValue
}
