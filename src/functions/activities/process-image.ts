import { InvocationContext } from "@azure/functions"
import { ActivityHandler } from "durable-functions"
import sharp from "sharp"
import { ProcessImageInput, ProcessImageResult } from "../types/migration"
import { overwriteCloudinaryImage } from "../utils/cloudinary"
import { toErrorMessage } from "../utils/error"
import { downloadImage, sha256 } from "../utils/image"
import { retryTransient } from "../utils/retry"
import {
	backupOriginalImage,
	getLedgerClient,
	getLedgerEntity,
	upsertLedgerEntity,
} from "../utils/storage"

export const processImageActivity: ActivityHandler = async (
	input: ProcessImageInput,
	context: InvocationContext,
): Promise<ProcessImageResult> => {
	const { asset, config } = input
	const publicId = asset.publicId
	const ledger = getLedgerClient(config.ledgerTableName)

	const existing = await getLedgerEntity(
		ledger,
		config.ledgerPartitionKey,
		publicId,
	)
	if (
		existing &&
		(existing.status === "completed" || existing.status === "skipped")
	) {
		return {
			publicId,
			status: "already-handled",
			originalBytes: Number(existing.originalBytes ?? 0),
			compressedBytes: Number(existing.compressedBytes ?? 0),
			savedBytes: Number(existing.savedBytes ?? 0),
			ratio: Number(existing.ratio ?? 1),
			reason: "already completed in ledger",
		}
	}

	const attemptCount = Number(existing?.attemptCount ?? 0) + 1
	const now = new Date().toISOString()
	await upsertLedgerEntity(ledger, {
		partitionKey: config.ledgerPartitionKey,
		rowKey: publicId,
		status: "processing",
		attemptCount,
		updatedAtUtc: now,
	})

	try {
		const sourceBuffer = await retryTransient(
			() => downloadImage(asset.secureUrl),
			4,
		)
		const originalBytes = sourceBuffer.length
		const checksum = sha256(sourceBuffer)

		const backupBlobName = await backupOriginalImage(
			publicId,
			sourceBuffer,
			checksum,
			config.backupContainer,
		)

		const compressedBuffer = await sharp(sourceBuffer)
			.png({
				compressionLevel: 9,
				palette: true,
				quality: 80,
				colours: 256,
				effort: 8,
			})
			.toBuffer()

		const compressedBytes = compressedBuffer.length
		const ratio = compressedBytes / Math.max(originalBytes, 1)
		const savingsRatio = 1 - ratio
		const shouldSkip =
			ratio > config.skipRatioThreshold || savingsRatio < config.minSavingsRatio

		if (shouldSkip) {
			const result: ProcessImageResult = {
				publicId,
				status: "skipped",
				originalBytes,
				compressedBytes,
				savedBytes: Math.max(0, originalBytes - compressedBytes),
				ratio,
				reason: "below minimum savings threshold",
			}

			await upsertLedgerEntity(ledger, {
				partitionKey: config.ledgerPartitionKey,
				rowKey: publicId,
				status: "skipped",
				originalBytes,
				compressedBytes,
				savedBytes: result.savedBytes,
				ratio,
				backupBlobName,
				checksum,
				attemptCount,
				updatedAtUtc: new Date().toISOString(),
			})

			return result
		}

		if (!config.dryRun) {
			await retryTransient(
				() => overwriteCloudinaryImage(publicId, compressedBuffer),
				4,
			)
		}

		const result: ProcessImageResult = {
			publicId,
			status: "completed",
			originalBytes,
			compressedBytes,
			savedBytes: Math.max(0, originalBytes - compressedBytes),
			ratio,
			reason: config.dryRun ? "dry-run complete (no overwrite)" : undefined,
		}

		await upsertLedgerEntity(ledger, {
			partitionKey: config.ledgerPartitionKey,
			rowKey: publicId,
			status: "completed",
			originalBytes,
			compressedBytes,
			savedBytes: result.savedBytes,
			ratio,
			backupBlobName,
			checksum,
			attemptCount,
			dryRun: config.dryRun,
			updatedAtUtc: new Date().toISOString(),
		})

		return result
	} catch (error: any) {
		context.error(
			`Failed processing ${publicId}: ${error?.message ?? "unknown error"}`,
		)

		await upsertLedgerEntity(ledger, {
			partitionKey: config.ledgerPartitionKey,
			rowKey: publicId,
			status: "failed",
			lastError: toErrorMessage(error),
			attemptCount,
			updatedAtUtc: new Date().toISOString(),
		})

		return {
			publicId,
			status: "failed",
			originalBytes: 0,
			compressedBytes: 0,
			savedBytes: 0,
			ratio: 1,
			reason: toErrorMessage(error),
		}
	}
}
