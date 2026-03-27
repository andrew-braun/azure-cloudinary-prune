import { ActivityHandler } from "durable-functions"
import { UpsertImageLedgerInput } from "../types/migration"
import { getLedgerClient, upsertLedgerEntity } from "../utils/storage"

export const upsertImageLedgerActivity: ActivityHandler = async (
	input: UpsertImageLedgerInput,
): Promise<void> => {
	const ledger = getLedgerClient(input.tableName)
	await upsertLedgerEntity(ledger, {
		partitionKey: input.partitionKey,
		rowKey: input.publicId,
		...input.payload,
	})
}
