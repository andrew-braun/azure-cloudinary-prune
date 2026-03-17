# Cloudinary Image Migration — Project Plan

## 1. Goal

Reduce Cloudinary storage costs by compressing ~26,000 content images currently stored as full-resolution PNGs (2–3 MB each, ~50–75 GB total). The target is a 50%+ reduction in stored size without breaking any existing URLs or delivery pipelines.

The function should:

- **Back up** every original image to Azure Blob Storage before modifying anything
- **Detect transparency** in each PNG and choose the optimal output format: JPEG (quality 85) for opaque images, palette-compressed PNG for images with transparency
- **Re-upload** the compressed version to Cloudinary using the same `public_id`, so all existing URLs, transformations, and references continue working
- **Only process content images** — filenames starting with `Picture_of` or `thumbnail_Picture_of` — and leave all other assets untouched
- **Respect Cloudinary's API rate limit** of 2,000 requests/hour by batching with pauses
- **Skip images** where compression achieves less than 10% savings (not worth the CDN cache invalidation)

---

## 2. Architecture

### Why Azure Durable Functions?

This is a long-running batch job (~15–20 hours for 26k images). A standard Azure Function has a 5–10 minute execution timeout (Consumption plan). Durable Functions solve this by breaking the work into an **orchestrator** that coordinates **activity functions**, with automatic checkpointing between steps. If the function app restarts mid-run, the orchestrator replays from its last checkpoint — no images get processed twice.

Alternative approaches considered:

| Approach                                      | Verdict                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Timer-triggered function (one image per tick) | Too complex — requires external state tracking for cursor/progress, cold start overhead, harder to monitor                   |
| Plain script on Hetzner VPS                   | Simpler for a one-off, but no automatic retry/checkpointing, no monitoring dashboard, and the user specifically wanted Azure |
| Azure Container Instance                      | Overkill — no need for a custom container when Functions handles the runtime                                                 |

### Durable storage type: Azure Storage

The orchestrator's checkpoint/history data is stored in Azure Table Storage and Azure Queues within the same storage account used by the Function App (`AzureWebJobsStorage`). This is the default and simplest option. MSSQL and Durable Task Scheduler exist for high-scale or enterprise scenarios and are unnecessary here.

### Function architecture

```
startMigration (HTTP trigger, POST /api/start)
  └─► migrationOrchestrator (orchestration)
        ├─► fetchAssetList (activity) — paginates Cloudinary Admin API, returns filtered asset list
        └─► for each batch of 50:
              ├─► processImage (activity) × 50 in parallel — backup → compress → re-upload
              └─► createTimer — 2-minute pause before next batch
checkStatus (HTTP trigger, GET /api/status/{instanceId})
```

### Rate limiting strategy

Cloudinary allows 2,000 Admin/Upload API requests per hour. Each image requires roughly 2 API calls (1 download via `secure_url`, 1 `upload_stream` call). The `fetchAssetList` activity paginates with `max_results: 500`, consuming ~52 calls for 26k images.

With `BATCH_SIZE = 50` and `DELAY_BETWEEN_BATCHES_SEC = 120`:

- 50 images × 2 calls = ~100 calls per batch
- 1 batch every 2 minutes = ~30 batches/hour = ~3,000 theoretical calls/hour

However, `maxConcurrentActivityFunctions` in `host.json` is set to 3, which throttles actual parallelism. In practice this stays well under the limit. If you still hit rate limits, increase `DELAY_BETWEEN_BATCHES_SEC` to 180.

---

## 3. Implementation Details

### 3.1 Dependencies

```json
{
	"dependencies": {
		"@azure/functions": "^4",
		"@azure/storage-blob": "latest",
		"cloudinary": "latest",
		"durable-functions": "^3",
		"sharp": "latest"
	}
}
```

`sharp` is used for image compression and transparency detection. It's a native module (uses libvips under the hood), so the Azure Function App must run on a Linux plan with Node.js 18+.

### 3.2 Environment variables

These go in `local.settings.json` for local dev and in the Function App's Application Settings for production:

```
CLOUDINARY_CLOUD_NAME     — Cloudinary cloud name
CLOUDINARY_API_KEY        — Cloudinary API key
CLOUDINARY_API_SECRET     — Cloudinary API secret
AZURE_STORAGE_CONNECTION_STRING — Connection string for the Azure Storage account used for image backups
AZURE_BACKUP_CONTAINER    — Blob container name for backups (default: "cloudinary-backups")
```

Note: `AzureWebJobsStorage` is a separate setting that the Azure Functions runtime uses for its own internal state (orchestrator checkpoints, queues, etc.). It can point to the same storage account but is configured separately.

### 3.3 host.json configuration

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

Key settings:

- `maxConcurrentActivityFunctions: 3` — limits parallel image processing to avoid memory spikes (each image is 2–3 MB in memory during processing) and to help with rate limiting
- `maxConcurrentOrchestratorFunctions: 1` — only one orchestrator instance should run at a time
- The extension bundle provides the Durable Functions runtime; no NuGet package installation is needed

### 3.4 Transparency detection

Not all PNGs use transparency. For images that are fully opaque, converting to JPEG yields much better compression than any PNG optimization. The `hasTransparency` helper samples ~10,000 pixels from the alpha channel:

```javascript
async function hasTransparency(buffer) {
	try {
		const { channels, width, height } = await sharp(buffer).metadata()
		if (channels < 4) return false // no alpha channel at all

		const { data } = await sharp(buffer)
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true })

		const stride = 4 // RGBA = 4 bytes per pixel
		const step = Math.max(1, Math.floor((width * height) / 10000))
		for (let i = 0; i < width * height; i += step) {
			if (data[i * stride + 3] < 255) return true
		}
		return false
	} catch {
		return true // if detection fails, assume transparency — safer to keep PNG
	}
}
```

This samples rather than checking every pixel for performance — a 3000×2000 image has 6 million pixels, and we only need to know "does any transparency exist?" not "how much?"

### 3.5 Image compression strategy

| Scenario                                      | Output format | sharp settings                                                  | Expected savings                |
| --------------------------------------------- | ------------- | --------------------------------------------------------------- | ------------------------------- |
| Opaque PNG (no transparency)                  | JPEG          | `quality: 85, mozjpeg: true` + `flatten` with white background  | 60–80%                          |
| Transparent PNG                               | PNG           | `quality: 80, compressionLevel: 9, palette: true, colours: 256` | 40–70%                          |
| Any image where `compressed / original > 0.9` | Skipped       | —                                                               | N/A (not worth CDN cache churn) |

The `flatten({ background: { r: 255, g: 255, b: 255 } })` call composites transparent areas onto a white background before JPEG encoding, since JPEG doesn't support transparency.

### 3.6 Cloudinary re-upload

The compressed image is uploaded using `upload_stream` with these critical options:

```javascript
cloudinary.uploader.upload_stream(
	{
		public_id, // same ID — preserves all existing URLs
		resource_type: "image",
		overwrite: true, // replace the stored original
		invalidate: true, // bust CDN cache so new version is served
		format: outputFormat, // "jpg" or "png"
	},
	callback,
)
```

`invalidate: true` tells Cloudinary to purge cached versions of this asset from its CDN. There may be a brief period (seconds to minutes) where the CDN re-fetches the new version, but this is unavoidable when replacing stored assets.

### 3.7 Orchestrator flow

The orchestrator is a generator function. Each `yield` is a checkpoint — if the function app restarts, replay resumes from the last yielded result without re-executing completed activities.

```javascript
df.app.orchestration("migrationOrchestrator", function* (context) {
	// Step 1: Fetch filtered asset list (single activity call)
	const assets = yield context.df.callActivity("fetchAssetList")

	// Step 2: Process in batches with rate-limiting delays
	for (let i = 0; i < assets.length; i += BATCH_SIZE) {
		const batch = assets.slice(i, i + BATCH_SIZE)

		// Fan-out: all images in batch processed concurrently
		const tasks = batch.map((asset) =>
			context.df.callActivity("processImage", asset),
		)
		const results = yield context.df.Task.all(tasks)

		// Rate-limit pause (durable timer — survives restarts)
		if (i + BATCH_SIZE < assets.length) {
			const deadline = new Date(
				context.df.currentUtcDateTime.getTime() +
					DELAY_BETWEEN_BATCHES_SEC * 1000,
			)
			yield context.df.createTimer(deadline)
		}
	}

	// Step 3: Return summary
	return summary
})
```

Important: the orchestrator must be **deterministic**. Never use `Date.now()`, `Math.random()`, or make API calls directly inside the orchestrator. All non-deterministic work goes in activity functions. Use `context.df.currentUtcDateTime` instead of `Date.now()`.

### 3.8 HTTP triggers

Two HTTP endpoints are registered:

**POST /api/start** — kicks off the orchestration and returns a JSON response containing management URLs (status check, terminate, etc.). The `createCheckStatusResponse` helper generates these automatically.

**GET /api/status/{instanceId}** — returns the current orchestration status (`Running`, `Completed`, `Failed`) and the output summary once complete.

---

## 4. Setup Guide (VSCode + Azure Tooling)

### 4.1 Prerequisites

- **Node.js 18+** installed locally
- **Azure Functions Core Tools v4**: `npm install -g azure-functions-core-tools@4 --unsafe-perm true`
- **VSCode** with the Azure Functions extension installed
- An **Azure account** with a Storage Account created

### 4.2 Create the Function App in VSCode

1. Open the Command Palette (`Ctrl+Shift+P`) → "Azure Functions: Create New Project"
2. Choose a folder for the project
3. Select **JavaScript** as the language
4. Select **Model V4** as the programming model
5. When prompted for a template, select **Durable Functions orchestrator**
6. When prompted for durable storage type, select **Azure Storage**
7. Name the orchestrator `migrationOrchestrator`

This scaffolds a basic project with `host.json`, `local.settings.json`, `package.json`, and a starter function file.

### 4.3 Install dependencies

```bash
npm install cloudinary sharp @azure/storage-blob
```

The `durable-functions` and `@azure/functions` packages should already be in `package.json` from the scaffolding step. If not:

```bash
npm install durable-functions@^3 @azure/functions@^4
```

### 4.4 Replace the scaffolded code

Delete whatever starter code VSCode generated in `src/functions/` and replace it with the single `index.js` file from this project. The file registers all functions (orchestrator, activities, HTTP triggers) in one place using the v4 programming model.

### 4.5 Configure local.settings.json

```json
{
	"IsEncrypted": false,
	"Values": {
		"AzureWebJobsStorage": "UseDevelopmentStorage=true",
		"FUNCTIONS_WORKER_RUNTIME": "node",
		"CLOUDINARY_CLOUD_NAME": "your-cloud-name",
		"CLOUDINARY_API_KEY": "your-api-key",
		"CLOUDINARY_API_SECRET": "your-api-secret",
		"AZURE_STORAGE_CONNECTION_STRING": "your-azure-storage-connection-string",
		"AZURE_BACKUP_CONTAINER": "cloudinary-backups"
	}
}
```

For local development with `AzureWebJobsStorage`, you can use `"UseDevelopmentStorage=true"` if you have **Azurite** running (the Azure Storage emulator). Alternatively, point it at a real Azure Storage account connection string.

### 4.6 Run locally

```bash
func start
```

Or press `F5` in VSCode with the Azure Functions launch configuration.

The terminal should show all registered functions:

```
Functions:
  startMigration: [POST] http://localhost:7071/api/start
  checkStatus:    [GET]  http://localhost:7071/api/status/{instanceId}
  migrationOrchestrator: orchestrationTrigger
  fetchAssetList: activityTrigger
  processImage:   activityTrigger
```

### 4.7 Test with a dry run

Before processing all 26k images, do a dry run. In `index.js`, temporarily modify the `processImage` activity to skip the Cloudinary re-upload:

```javascript
// Comment out the upload_stream block and replace with:
result.status = "dry_run"
result.outputFormat = outputFormat
result.originalBytes = originalBuffer.length
result.compressedBytes = compressedBuffer.length
result.ratio = ratio
return result
```

This will still download each image, back it up to Azure Blob Storage, and run the compression — but won't overwrite anything on Cloudinary. Check the Azure Blob container to verify backups are landing correctly, and check the summary output to see projected savings.

### 4.8 Deploy to Azure

**Option A: VSCode**

1. Open Command Palette → "Azure Functions: Deploy to Function App"
2. Select your subscription and either create a new Function App or select an existing one
3. Use **Linux** as the OS and **Node.js 18** as the runtime
4. Choose **Consumption** or **Flex Consumption** plan (Consumption is fine for this)
5. After deployment, go to the Function App's "Configuration" in the Azure Portal and add the environment variables from section 4.5

**Option B: CLI**

```bash
# Create the Function App
az functionapp create \
  --resource-group your-rg \
  --consumption-plan-location westeurope \
  --runtime node \
  --runtime-version 18 \
  --functions-version 4 \
  --name cloudinary-migration \
  --storage-account yourstorageaccount \
  --os-type Linux

# Set environment variables
az functionapp config appsettings set \
  --name cloudinary-migration \
  --resource-group your-rg \
  --settings \
    CLOUDINARY_CLOUD_NAME=xxx \
    CLOUDINARY_API_KEY=xxx \
    CLOUDINARY_API_SECRET=xxx \
    AZURE_STORAGE_CONNECTION_STRING="xxx" \
    AZURE_BACKUP_CONTAINER=cloudinary-backups

# Deploy
func azure functionapp publish cloudinary-migration
```

### 4.9 Trigger the migration

```bash
curl -X POST https://cloudinary-migration.azurewebsites.net/api/start
```

The response includes a `statusQueryGetUri` — poll that URL to monitor progress.

---

## 5. Additional Notes for Implementation

### Things an AI agent implementing this should know

**The v4 programming model is different from v3.** In v4, functions are registered programmatically (e.g., `df.app.orchestration(...)`, `df.app.activity(...)`, `app.http(...)`) rather than via `function.json` binding files. If the VSCode scaffolding generates `function.json` files, delete them — the v4 model doesn't use them.

**The orchestrator generator function must be deterministic.** This is the single most common source of bugs. The Durable Functions runtime replays the orchestrator from the beginning on every checkpoint. If the orchestrator produces different results on replay (because it called `Date.now()` or read an environment variable that changed), the replay will fail with a `NonDeterministicOrchestratorError`. All side effects must be inside activity functions.

**`sharp` is a native module and needs a compatible runtime.** On Azure, this means a **Linux** Function App. If deployed to Windows, `sharp` will fail to load. The `npm install` step downloads platform-specific binaries, so you should deploy using `func azure functionapp publish` (which runs `npm install` on the remote) rather than zipping `node_modules` from a local machine with a different OS.

**Cloudinary's `secure_url` field returns the original asset URL.** Fetching this URL does not count against the Admin API rate limit — it's a standard CDN fetch. Only the `cloudinary.api.resources()` and `cloudinary.uploader.upload_stream()` calls count toward the 2,000/hour limit.

**The `fields` parameter in `cloudinary.api.resources()` is important.** Without it, Cloudinary returns the full resource object (including derived images, tags, context, etc.) which is much larger and slower. Specifying `fields: "public_id,format,bytes,secure_url"` keeps the response minimal.

**Blob naming preserves Cloudinary folder structure.** If a Cloudinary `public_id` is `content/gallery/Picture_of_sunset`, the backup blob will be `content/gallery/Picture_of_sunset.png`. Azure Blob Storage treats `/` in blob names as virtual directories, so this creates a browsable folder structure in the Azure Portal.

**If the orchestration fails mid-run**, you can check the Durable Functions monitor in the Azure Portal (Function App → Functions → migrationOrchestrator → Monitor) to see which batch failed. You can also query the orchestration status via the `checkStatus` endpoint. Failed orchestrations can be restarted, but already-processed images will be re-processed (since the orchestrator replays). To make this idempotent, you could check if a backup blob already exists before processing, but for a one-time migration the simpler approach is fine.

**Memory considerations.** Each `processImage` activity loads one full image into memory (~2–3 MB), runs `sharp` operations (which may temporarily use 2–3× the buffer size), then uploads. With `maxConcurrentActivityFunctions: 3`, peak memory usage is roughly 3 × 10 MB = 30 MB — well within the default Azure Functions memory allocation. If you increase concurrency, watch for out-of-memory errors.

**After the migration is complete**, you can verify savings by checking the Cloudinary dashboard's storage usage. Allow a few hours for Cloudinary to update its storage metrics. You can also compare the `totalOriginalMB` and `totalCompressedMB` fields in the orchestration output.

### Tuning reference

| Parameter                        | Location    | Default | Effect                                                                         |
| -------------------------------- | ----------- | ------- | ------------------------------------------------------------------------------ |
| `BATCH_SIZE`                     | `index.js`  | 50      | Images processed per batch. Higher = faster but more API calls per burst       |
| `DELAY_BETWEEN_BATCHES_SEC`      | `index.js`  | 120     | Pause between batches. Increase if hitting rate limits                         |
| `maxConcurrentActivityFunctions` | `host.json` | 3       | Parallel activity executions. Increase for speed, decrease for stability       |
| JPEG quality                     | `index.js`  | 85      | Lower = smaller files but more compression artifacts                           |
| PNG colours                      | `index.js`  | 256     | Palette size for transparent PNGs. Lower = smaller but potential color banding |
| Skip threshold                   | `index.js`  | 0.9     | Skip if compressed/original > this ratio                                       |
