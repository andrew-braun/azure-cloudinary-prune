export type RateLimitSource = "admin" | "download" | "upload" | "unknown"

export type RateLimitCounterSnapshot = {
	total429: number
	bySource: Record<RateLimitSource, number>
	last429AtUtc: string | null
	recent429Last5Min: number
}

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000

const counters: RateLimitCounterSnapshot = {
	total429: 0,
	bySource: {
		admin: 0,
		download: 0,
		upload: 0,
		unknown: 0,
	},
	last429AtUtc: null,
	recent429Last5Min: 0,
}

const recent429Timestamps: number[] = []

function pruneRecent(now: number): void {
	while (
		recent429Timestamps.length > 0 &&
		now - recent429Timestamps[0] > RATE_LIMIT_WINDOW_MS
	) {
		recent429Timestamps.shift()
	}

	counters.recent429Last5Min = recent429Timestamps.length
}

export function increment429Counter(
	source: RateLimitSource,
): RateLimitCounterSnapshot {
	const now = Date.now()
	counters.total429 += 1
	counters.bySource[source] += 1
	counters.last429AtUtc = new Date(now).toISOString()

	recent429Timestamps.push(now)
	pruneRecent(now)

	return get429CounterSnapshot()
}

export function get429CounterSnapshot(): RateLimitCounterSnapshot {
	pruneRecent(Date.now())

	return {
		total429: counters.total429,
		bySource: { ...counters.bySource },
		last429AtUtc: counters.last429AtUtc,
		recent429Last5Min: counters.recent429Last5Min,
	}
}
