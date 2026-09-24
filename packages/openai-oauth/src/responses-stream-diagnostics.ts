import { isRecord } from "./shared.js"

type StreamOutcome = "forwarded" | "client_closed" | "forward_error"
type Terminal =
	| "response.completed"
	| "response.failed"
	| "response.incomplete"
	| "error"

const knownItemTypes = new Set([
	"message",
	"reasoning",
	"function_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
	"web_search_call",
	"file_search_call",
	"computer_call",
	"code_interpreter_call",
	"apply_patch_call",
	"shell_call",
])
const knownToolNames = new Set([
	"web_search",
	"file_search",
	"apply_patch",
	"shell",
	"local_shell",
	"computer",
	"code_interpreter",
	"__openai_oauth_web_search",
])
const terminalEvents = new Set<Terminal>([
	"response.completed",
	"response.failed",
	"response.incomplete",
	"error",
])

export type ResponsesStreamObserver = {
	chunk(value: Uint8Array): void
	finish(outcome: StreamOutcome, error?: unknown): void
}

const observers = new WeakMap<Response, ResponsesStreamObserver>()

export const getResponsesStreamObserver = (response: Response) =>
	observers.get(response)

export const observeResponsesStream = (
	response: Response,
	requestId: string,
	write: (line: string) => void,
) => {
	if (
		!response.ok ||
		!response.body ||
		!response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("text/event-stream")
	)
		return response

	const decoder = new TextDecoder()
	let pending = ""
	let eventCount = 0
	let oversizedEvents = 0
	let inspecting = true
	let droppingOversized = false
	let finished = false
	let terminal: Terminal | undefined
	let itemTypes: string[] | undefined
	let toolNames: string[] | undefined
	let withheldToolNames = 0
	let outputSummary = "unavailable"

	const inspect = (frame: string) => {
		if (++eventCount > 10_000) {
			inspecting = false
			return
		}
		const event = /^event:\s*([^\r\n]+)/m.exec(frame)?.[1]
		if (!event || !terminalEvents.has(event as Terminal)) return
		terminal = event as Terminal
		if (terminal !== "response.completed") return
		const data = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
		try {
			const payload: unknown = JSON.parse(data)
			const output =
				isRecord(payload) && isRecord(payload.response)
					? payload.response.output
					: undefined
			if (!Array.isArray(output)) return
			itemTypes = []
			toolNames = []
			for (const item of output.slice(0, 128)) {
				if (!isRecord(item)) continue
				if (typeof item.type === "string" && knownItemTypes.has(item.type)) {
					if (!itemTypes.includes(item.type)) itemTypes.push(item.type)
				}
				if (typeof item.name === "string") {
					if (knownToolNames.has(item.name)) {
						if (!toolNames.includes(item.name)) toolNames.push(item.name)
					} else withheldToolNames++
				}
			}
			outputSummary = output.length > 128 ? "truncated" : "captured"
		} catch {
			outputSummary = "invalid_or_oversized_json"
		}
	}

	const observer: ResponsesStreamObserver = {
		chunk(value) {
			if (!inspecting) return
			for (let offset = 0; offset < value.byteLength; offset += 8192) {
				pending += decoder.decode(value.subarray(offset, offset + 8192), {
					stream: true,
				})
				while (true) {
					const match = /\r?\n\r?\n/.exec(pending)
					if (!match) break
					const frame = pending.slice(0, match.index)
					pending = pending.slice(match.index + match[0].length)
					if (!droppingOversized) inspect(frame)
					droppingOversized = false
				}
				if (pending.length > 131_072) {
					const event = /^event:\s*([^\r\n]+)/m.exec(pending)?.[1]
					if (event && terminalEvents.has(event as Terminal)) {
						terminal = event as Terminal
						outputSummary = "oversized_event"
					}
					pending = pending.slice(-3)
					droppingOversized = true
					oversizedEvents++
				} else if (droppingOversized) pending = pending.slice(-3)
			}
		},
		finish(outcome, error) {
			if (finished) return
			finished = true
			const errorName =
				error instanceof Error &&
				["AbortError", "TypeError", "Error", "NetworkError"].includes(
					error.name,
				)
					? error.name
					: error === undefined
						? undefined
						: "other_error"
			try {
				write(
					JSON.stringify({
						source: "openai-oauth-responses-stream-diagnostic",
						timestamp: new Date().toISOString(),
						requestId,
						outcome,
						terminal: terminal ?? "not_observed",
						itemTypes,
						toolNames,
						withheldToolNames: withheldToolNames || undefined,
						outputSummary:
							terminal === "response.completed" ? outputSummary : undefined,
						inspection: inspecting ? "complete" : "event_limit",
						oversizedEvents: oversizedEvents || undefined,
						errorName,
					}),
				)
			} catch {
				/* Diagnostics must not affect forwarding. */
			}
		},
	}
	observers.set(response, observer)
	return response
}
