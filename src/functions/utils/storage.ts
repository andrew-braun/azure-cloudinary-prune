import { TableClient } from "@azure/data-tables"
import { BlobServiceClient } from "@azure/storage-blob"
import { requireSetting } from "./config"

const tableReadyPromises = new Map<string, Promise<void>>()
const backupContainerReadyPromises = new Map<string, Promise<void>>()

function getBlobServiceClient(): BlobServiceClient {
	const connectionString = requireSetting("AZURE_STORAGE_CONNECTION_STRING")
	return BlobServiceClient.fromConnectionString(connectionString)
}

export function getLedgerClient(tableName: string): TableClient {
	const connectionString = requireSetting("AZURE_STORAGE_CONNECTION_STRING")
	return TableClient.fromConnectionString(connectionString, tableName)
}

async function ensureTableExists(client: TableClient): Promise<void> {
	const key = client.tableName
	if (!tableReadyPromises.has(key)) {
		tableReadyPromises.set(
			key,
			client.createTable().catch((error: any) => {
				if (error?.statusCode !== 409) {
					throw error
				}
			}),
		)
	}

	await tableReadyPromises.get(key)
}

async function ensureBackupContainerExists(
	containerName: string,
): Promise<void> {
	if (!backupContainerReadyPromises.has(containerName)) {
		const blobServiceClient = getBlobServiceClient()
		backupContainerReadyPromises.set(
			containerName,
			blobServiceClient
				.getContainerClient(containerName)
				.createIfNotExists()
				.then(() => undefined),
		)
	}

	await backupContainerReadyPromises.get(containerName)
}

export async function getLedgerEntity(
	client: TableClient,
	partitionKey: string,
	rowKey: string,
): Promise<Record<string, any> | null> {
	await ensureTableExists(client)

	try {
		return (await client.getEntity(partitionKey, rowKey)) as Record<string, any>
	} catch (error: any) {
		if (error?.statusCode === 404) {
			return null
		}

		throw error
	}
}

export async function upsertLedgerEntity(
	client: TableClient,
	entity: {
		partitionKey: string
		rowKey: string
		[key: string]: unknown
	},
): Promise<void> {
	await ensureTableExists(client)
	await client.upsertEntity(entity)
}

export async function backupOriginalImage(
	publicId: string,
	data: Buffer,
	checksum: string,
	containerName: string,
): Promise<string> {
	await ensureBackupContainerExists(containerName)

	const sanitizedPublicId = publicId.replace(/[^a-zA-Z0-9/_-]/g, "_")
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
	const blobName = `${sanitizedPublicId}/${timestamp}.png`

	const containerClient =
		getBlobServiceClient().getContainerClient(containerName)
	const blobClient = containerClient.getBlockBlobClient(blobName)
	await blobClient.uploadData(data, {
		blobHTTPHeaders: { blobContentType: "image/png" },
		metadata: {
			originalbytes: String(data.length),
			sha256: checksum,
			contenttype: "image/png",
			cloudinarypublicid: publicId,
			backupcreatedatutc: new Date().toISOString(),
		},
	})

	return blobName
}
