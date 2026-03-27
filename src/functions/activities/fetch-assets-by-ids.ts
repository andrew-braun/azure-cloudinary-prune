import { InvocationContext } from "@azure/functions"
import { ActivityHandler } from "durable-functions"
import {
	FetchAssetsByIdsInput,
	FetchAssetsByIdsResult,
} from "../types/migration"
import { chunkArray } from "../utils/arrays"
import { getCloudinaryClient } from "../utils/cloudinary"
import { isPngImageResource, toAsset } from "../utils/image"
import { retryTransient } from "../utils/retry"

const CLOUDINARY_IDS_PER_REQUEST = 100

export const fetchAssetsByIdsActivity: ActivityHandler = async (
	input: FetchAssetsByIdsInput,
	context: InvocationContext,
): Promise<FetchAssetsByIdsResult> => {
	const cloudinary = getCloudinaryClient()
	const requestedIds = Array.from(
		new Set(
			(input?.imageIds ?? [])
				.map((id) => String(id ?? "").trim())
				.filter((id) => id.length > 0),
		),
	)

	if (requestedIds.length === 0) {
		return {
			requestedCount: 0,
			foundCount: 0,
			missingIds: [],
			nonPngIds: [],
			assets: [],
		}
	}

	const resourcesByPublicId = new Map<string, any>()
	const idBatches = chunkArray(requestedIds, CLOUDINARY_IDS_PER_REQUEST)

	for (let i = 0; i < idBatches.length; i += 1) {
		const batchIds = idBatches[i]
		const response = await retryTransient(
			() =>
				cloudinary.api.resources_by_ids(batchIds, {
					resource_type: "image",
					fields: "public_id,secure_url,bytes,format,resource_type",
				}),
			4,
			{
				rateLimitSource: "admin",
				onRateLimited: (snapshot, _, attempt) => {
					context.log(
						`429 detected source=admin activity=fetchAssetsByIds attempt=${attempt} total429=${snapshot.total429} recent429Last5Min=${snapshot.recent429Last5Min}`,
					)
				},
			},
		)

		const resources = Array.isArray(response.resources)
			? response.resources
			: []
		for (const resource of resources) {
			const publicId = String(resource?.public_id ?? "")
			if (publicId) {
				resourcesByPublicId.set(publicId, resource)
			}
		}

		context.log(
			`Fetched ids batch ${i + 1}/${idBatches.length} requested=${batchIds.length} found=${resources.length}`,
		)
	}

	const foundIds = new Set(Array.from(resourcesByPublicId.keys()))
	const missingIds = requestedIds.filter((id) => !foundIds.has(id))

	const nonPngIds: string[] = []
	const assets = requestedIds
		.map((id) => resourcesByPublicId.get(id))
		.filter((resource) => {
			if (!resource) {
				return false
			}

			const isPng = isPngImageResource(resource)
			if (!isPng) {
				nonPngIds.push(String(resource.public_id ?? ""))
			}

			return isPng
		})
		.map(toAsset)

	return {
		requestedCount: requestedIds.length,
		foundCount: foundIds.size,
		missingIds,
		nonPngIds,
		assets,
	}
}
