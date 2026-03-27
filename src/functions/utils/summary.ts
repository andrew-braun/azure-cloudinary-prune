import { MigrationSummary } from "../types/migration"

export function emptySummary(): MigrationSummary {
	return {
		scanned: 0,
		processed: 0,
		skipped: 0,
		failed: 0,
		originalBytes: 0,
		compressedBytes: 0,
		savedBytes: 0,
		pageCount: 0,
	}
}
