import { InvocationContext } from "@azure/functions"
import { ActivityHandler } from "durable-functions"
import { FetchAssetPageInput, FetchAssetPageResult } from "../types/migration"
import { getCloudinaryClient } from "../utils/cloudinary"
import { isInScopePng, toAsset } from "../utils/image"
import { retryTransient } from "../utils/retry"

export const fetchAssetPageActivity: ActivityHandler = async (
	input: FetchAssetPageInput,
	context: InvocationContext,
): Promise<FetchAssetPageResult> => {
	const startedAt = Date.now()
	const cloudinary = getCloudinaryClient()

	const pageSize = Math.max(1, input?.pageSize ?? 500)
	const response = await retryTransient(
		() =>
			cloudinary.api.resources({
				type: "upload",
				resource_type: "image",
				max_results: pageSize,
				fields: "public_id,secure_url,bytes,format,resource_type",
				...(input?.nextCursor ? { next_cursor: input.nextCursor } : {}),
			}),
		4,
		{
			rateLimitSource: "admin",
			onRateLimited: (snapshot, _, attempt) => {
				context.log(
					`429 detected source=admin attempt=${attempt} total429=${snapshot.total429} recent429Last5Min=${snapshot.recent429Last5Min}`,
				)
			},
		},
	)

	const resources = Array.isArray(response.resources) ? response.resources : []
	const assets = resources.filter(isInScopePng).map(toAsset)

	const result: FetchAssetPageResult = {
		cursorUsed: input?.nextCursor ?? null,
		nextCursor: response.next_cursor ?? null,
		scannedCount: resources.length,
		candidateCount: assets.length,
		assets,
	}

	const durationMs = Date.now() - startedAt
	context.log(
		`Fetched page cursor=${result.cursorUsed ?? "start"} scanned=${result.scannedCount} candidates=${result.candidateCount} durationMs=${durationMs}`,
	)

	return result
}
