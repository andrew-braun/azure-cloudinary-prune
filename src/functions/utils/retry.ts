import {
	increment429Counter,
	RateLimitCounterSnapshot,
	RateLimitSource,
} from "./rate-limit-telemetry"

function parseRetryAfter(headerValue: string | null): number | undefined {
	if (!headerValue) {
		return undefined
	}

	const seconds = Number(headerValue)
	if (!Number.isNaN(seconds) && seconds > 0) {
		return seconds * 1000
	}

	const dateValue = Date.parse(headerValue)
	if (Number.isNaN(dateValue)) {
		return undefined
	}

	return Math.max(0, dateValue - Date.now())
}

function getStatusCode(error: any): number {
	return Number(error?.status ?? error?.statusCode ?? error?.http_code)
}

export function isRateLimited(error: any): boolean {
	return getStatusCode(error) === 429
}

function isTransient(error: any): boolean {
	const status = getStatusCode(error)
	if (status === 429 || status >= 500) {
		return true
	}

	const code = String(error?.code ?? "").toUpperCase()
	return code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EAI_AGAIN"
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export type RetryTransientOptions = {
	rateLimitSource?: RateLimitSource
	onRateLimited?: (
		snapshot: RateLimitCounterSnapshot,
		error: any,
		attempt: number,
	) => void
}

export async function retryTransient<T>(
	operation: () => Promise<T>,
	maxAttempts: number,
	options?: RetryTransientOptions,
): Promise<T> {
	let delayMs = 1000

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await operation()
		} catch (error: any) {
			if (isRateLimited(error)) {
				const snapshot = increment429Counter(
					options?.rateLimitSource ?? "unknown",
				)
				options?.onRateLimited?.(snapshot, error, attempt)
			}

			const isLastAttempt = attempt === maxAttempts
			if (isLastAttempt || !isTransient(error)) {
				throw error
			}

			const retryAfterMs = Number(error?.retryAfterMs)
			const waitMs =
				Number.isFinite(retryAfterMs) && retryAfterMs > 0
					? Math.floor(retryAfterMs)
					: delayMs
			await sleep(waitMs)
			delayMs = Math.min(delayMs * 2, 30000)
		}
	}

	throw new Error("retryTransient exhausted without result.")
}

export function attachRetryAfter(error: any, headerValue: string | null): void {
	error.retryAfterMs = parseRetryAfter(headerValue)
}
