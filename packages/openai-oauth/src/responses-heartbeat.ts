import { copyUpstreamResponse } from "./shared.js"

const encoder = new TextEncoder()
const heartbeat = encoder.encode(": keep-alive\n")
const maxPendingLine = 8 * 1024 * 1024

/** Keep idle SSE transports alive without inventing model events or splitting a data line. */
export const withResponsesHeartbeat = (
	response: Response,
	signal: AbortSignal,
): Response => {
	if (
		!response.ok ||
		!response.body ||
		!response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("text/event-stream")
	)
		return copyUpstreamResponse(response)

	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let pending = ""
	let finished = false
	let timer: ReturnType<typeof setInterval>
	let abort: () => void
	const cleanup = () => {
		finished = true
		clearInterval(timer)
		signal.removeEventListener("abort", abort)
	}
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			abort = () => {
				if (finished) return
				cleanup()
				void reader
					.cancel(signal.reason)
					.catch(() => {})
					.finally(() => reader.releaseLock())
				controller.error(signal.reason)
			}
			if (signal.aborted) {
				abort()
				return
			}
			signal.addEventListener("abort", abort, { once: true })
			controller.enqueue(heartbeat)
			timer = setInterval(() => {
				// A stalled consumer gets at most one queued comment, not an unbounded timer queue.
				if ((controller.desiredSize ?? 0) > 0) controller.enqueue(heartbeat)
			}, 15_000)
		},
		async pull(controller) {
			try {
				while (!finished) {
					const { value, done } = await reader.read()
					if (finished) return
					pending += decoder.decode(value, { stream: !done })
					if (done) {
						if (pending) controller.enqueue(encoder.encode(pending))
						pending = ""
						cleanup()
						controller.close()
						reader.releaseLock()
						return
					}
					let end = 0
					for (let i = 0; i < pending.length; i++) {
						if (pending[i] === "\n") end = i + 1
						else if (pending[i] === "\r") {
							// Hold a trailing CR until we know whether the LF belongs to it.
							if (i === pending.length - 1) break
							if (pending[i + 1] === "\n") i++
							end = i + 1
						}
					}
					const complete = pending.slice(0, end)
					pending = pending.slice(end)
					if (pending.length > maxPendingLine)
						throw new Error("Responses SSE line exceeds the transport limit.")
					if (complete) {
						controller.enqueue(encoder.encode(complete))
						return
					}
				}
			} catch (error) {
				if (finished) return
				cleanup()
				void reader
					.cancel(error)
					.catch(() => {})
					.finally(() => reader.releaseLock())
				controller.error(error)
			}
		},
		cancel(reason) {
			cleanup()
			return reader.cancel(reason).finally(() => reader.releaseLock())
		},
	})
	const headers = new Headers(response.headers)
	headers.delete("content-length")
	headers.delete("content-encoding")
	headers.set("cache-control", "no-store, no-transform")
	headers.set("x-accel-buffering", "no")
	return new Response(body, { status: response.status, headers })
}
