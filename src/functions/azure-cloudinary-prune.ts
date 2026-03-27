import {
	app,
	HttpHandler,
	HttpRequest,
	HttpResponseInit,
	InvocationContext,
} from "@azure/functions"
import * as df from "durable-functions"
import { OrchestrationContext, OrchestrationHandler } from "durable-functions"
import { fetchAssetPageActivity } from "./activities/fetch-asset-page"
import { processImageActivity } from "./activities/process-image"
import { upsertImageLedgerActivity } from "./activities/upsert-image-ledger"
import {
	FETCH_ASSET_PAGE_ACTIVITY,
	FetchAssetPageInput,
	FetchAssetPageResult,
	ORCHESTRATOR_NAME,
	OrchestratorState,
	PROCESS_IMAGE_ACTIVITY,
	ProcessImageInput,
	ProcessImageResult,
	StartRequestBody,
	UPSERT_IMAGE_LEDGER_ACTIVITY,
} from "./types/migration"
import { chunkArray } from "./utils/arrays"
import { getRuntimeConfig, parseStartBody, toPositiveInt } from "./utils/config"
import { emptySummary } from "./utils/summary"

const migrationOrchestrator: OrchestrationHandler = function* (
	context: OrchestrationContext,
) {
	const state = context.df.getInput() as OrchestratorState | undefined
	if (!state) {
		throw new Error("Orchestrator state is required.")
	}

	const retryOptions = new df.RetryOptions(5000, 4)
	retryOptions.backoffCoefficient = 2
	retryOptions.maxRetryIntervalInMilliseconds = 60000

	const pageResult = (yield context.df.callActivityWithRetry(
		FETCH_ASSET_PAGE_ACTIVITY,
		retryOptions,
		{
			nextCursor: state.nextCursor,
			pageSize: state.config.pageSize,
		} as FetchAssetPageInput,
	)) as FetchAssetPageResult

	const summary = {
		...state.summary,
		scanned: state.summary.scanned + pageResult.scannedCount,
		pageCount: state.summary.pageCount + 1,
	}

	const batches = chunkArray(
		pageResult.assets,
		Math.max(1, state.config.batchSize),
	)
	for (let i = 0; i < batches.length; i += 1) {
		const batch = batches[i]
		const tasks = batch.map((asset) =>
			context.df.callActivityWithRetry(PROCESS_IMAGE_ACTIVITY, retryOptions, {
				runId: state.runId,
				config: state.config,
				asset,
			} as ProcessImageInput),
		)

		const results = (yield context.df.Task.all(tasks)) as ProcessImageResult[]
		let batchCompleted = 0
		let batchSkipped = 0
		let batchFailed = 0
		let batchSavedBytes = 0

		for (const result of results) {
			summary.originalBytes += result.originalBytes
			summary.compressedBytes += result.compressedBytes
			summary.savedBytes += result.savedBytes
			batchSavedBytes += result.savedBytes

			if (result.status === "completed") {
				summary.processed += 1
				batchCompleted += 1
			} else if (result.status === "skipped") {
				summary.skipped += 1
				batchSkipped += 1
			} else if (result.status === "failed") {
				summary.failed += 1
				batchFailed += 1
			}
		}

		if (!context.df.isReplaying) {
			context.log(
				`Batch ${i + 1}/${batches.length} completed=${batchCompleted} skipped=${batchSkipped} failed=${batchFailed} savedBytes=${batchSavedBytes} delaySec=${state.config.delayBetweenBatchesSec}`,
			)
		}

		context.df.setCustomStatus({
			runId: state.runId,
			cursor: pageResult.nextCursor,
			summary,
			batch: i + 1,
			totalBatches: batches.length,
		})

		const isLastBatch = i === batches.length - 1
		if (!isLastBatch && state.config.delayBetweenBatchesSec > 0) {
			const fireAt = new Date(
				context.df.currentUtcDateTime.getTime() +
					state.config.delayBetweenBatchesSec * 1000,
			)
			yield context.df.createTimer(fireAt)
		}
	}

	if (pageResult.nextCursor) {
		context.df.continueAsNew({
			...state,
			nextCursor: pageResult.nextCursor,
			summary,
		} as OrchestratorState)
		return
	}

	return {
		runId: state.runId,
		completedAtUtc: context.df.currentUtcDateTime.toISOString(),
		summary,
	}
}

df.app.orchestration(ORCHESTRATOR_NAME, migrationOrchestrator)
df.app.activity(FETCH_ASSET_PAGE_ACTIVITY, { handler: fetchAssetPageActivity })
df.app.activity(PROCESS_IMAGE_ACTIVITY, { handler: processImageActivity })
df.app.activity(UPSERT_IMAGE_LEDGER_ACTIVITY, {
	handler: upsertImageLedgerActivity,
})

const startMigration: HttpHandler = async (
	request: HttpRequest,
	context: InvocationContext,
): Promise<HttpResponseInit> => {
	const body = (await parseStartBody(request)) as StartRequestBody
	const baseConfig = getRuntimeConfig()

	const config = {
		...baseConfig,
		pageSize: toPositiveInt(body.pageSize, baseConfig.pageSize),
		batchSize: toPositiveInt(body.batchSize, baseConfig.batchSize),
		delayBetweenBatchesSec: toPositiveInt(
			body.delayBetweenBatchesSec,
			baseConfig.delayBetweenBatchesSec,
		),
		dryRun: typeof body.dryRun === "boolean" ? body.dryRun : baseConfig.dryRun,
	}

	const input: OrchestratorState = {
		nextCursor: body.nextCursor ?? null,
		runId: body.runId ?? `migration-${new Date().toISOString()}`,
		summary: emptySummary(),
		config,
	}

	const client = df.getClient(context)
	const instanceId = await client.startNew(ORCHESTRATOR_NAME, { input })
	context.log(
		`Started orchestration '${ORCHESTRATOR_NAME}' with ID '${instanceId}'.`,
	)

	return client.createCheckStatusResponse(request, instanceId)
}

app.http("startMigration", {
	methods: ["POST"],
	authLevel: "function",
	route: "start",
	extraInputs: [df.input.durableClient()],
	handler: startMigration,
})

const checkStatus: HttpHandler = async (
	request: HttpRequest,
	context: InvocationContext,
): Promise<HttpResponseInit> => {
	const instanceId = request.params.instanceId
	if (!instanceId) {
		return {
			status: 400,
			jsonBody: { error: "instanceId route parameter is required." },
		}
	}

	const client = df.getClient(context)
	const status = await client.getStatus(instanceId, {
		showHistory: false,
		showHistoryOutput: false,
		showInput: false,
	})

	if (!status) {
		return {
			status: 404,
			jsonBody: {
				error: `No orchestration found for instance '${instanceId}'.`,
			},
		}
	}

	return {
		status: 200,
		jsonBody: {
			instanceId: status.instanceId,
			runtimeStatus: status.runtimeStatus,
			createdTime: status.createdTime,
			lastUpdatedTime: status.lastUpdatedTime,
			customStatus: status.customStatus,
		},
	}
}

app.http("checkStatus", {
	methods: ["GET"],
	authLevel: "function",
	route: "status/{instanceId}",
	extraInputs: [df.input.durableClient()],
	handler: checkStatus,
})
