type Event =
	| "upstream_headers"
	| "upstream_fetch_error"
	| "upstream_first_byte"
	| "upstream_body_end"
	| "upstream_body_error"
	| "upstream_body_cancel"
	| "upstream_reader_released"
	| "downstream_close"
	| "proxy_abort"
	| "writer_cleanup"
	| "downstream_finish"
	| "forward_error"
	| "event_limit"

type Details = {
	upstreamCall?: number
	target?: "responses" | "search"
	status?: number
	errorName?: string
	firstByteAt?: string
	lastByteAt?: string
	bytes?: number
	signalAborted?: boolean
}

const maxEvents = 24
const safeErrorNames = new Set([
	"AbortError",
	"Error",
	"NetworkError",
	"TypeError",
	"TimeoutError",
])

export const safeStreamErrorName = (error: unknown): string =>
	error instanceof Error && safeErrorNames.has(error.name)
		? error.name
		: "other_error"

/** One bounded, content-free chronology for a public Responses request. */
export const createResponsesLifecycleTrace = (
	requestId: string,
	write: (line: string) => void,
) => {
	let active = false
	let discarded = false
	let sequence = 0
	let upstreamCalls = 0
	const pending: Record<string, unknown>[] = []
	const emit = (entry: Record<string, unknown>) => {
		try {
			write(JSON.stringify(entry))
		} catch {
			/* Diagnostics must never affect forwarding. */
		}
	}
	return {
		nextUpstreamCall: () => ++upstreamCalls,
		record(event: Event, details: Details = {}) {
			if (discarded || sequence > maxEvents) return
			const entry = {
				source: "openai-oauth-responses-lifecycle-diagnostic",
				timestamp: new Date().toISOString(),
				requestId,
				sequence: ++sequence,
				event: sequence === maxEvents + 1 ? "event_limit" : event,
				...(sequence <= maxEvents ? details : {}),
			}
			if (active) emit(entry)
			else pending.push(entry)
		},
		activate() {
			if (discarded || active) return
			active = true
			for (const entry of pending) emit(entry)
			pending.length = 0
		},
		discard() {
			discarded = true
			pending.length = 0
		},
	}
}

export type ResponsesLifecycleTrace = ReturnType<
	typeof createResponsesLifecycleTrace
>
