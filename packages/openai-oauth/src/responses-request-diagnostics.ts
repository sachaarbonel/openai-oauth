import { AsyncLocalStorage } from "node:async_hooks"
import {
	type ResponsesLifecycleTrace,
	safeStreamErrorName,
} from "./responses-lifecycle-diagnostics.js"
import { isRecord } from "./shared.js"

// Public protocol identifiers only. Never log tool names, schemas, arguments,
// prompts, domain filters, URLs, headers, or arbitrary unknown type strings.
export const diagnosticToolTypes = new Set([
	"function",
	"custom",
	"namespace",
	"tool_search",
	"web_search",
	"web_search_preview",
	"web_search_preview_2025_03_11",
	"file_search",
	"code_interpreter",
	"computer",
	"computer_use_preview",
	"image_generation",
	"mcp",
	"apply_patch",
	"shell",
	"local_shell",
])

const toolTypes = (value: unknown) => {
	if (value === undefined) return { shape: "omitted" }
	if (!Array.isArray(value)) return { shape: "invalid" }
	return {
		count: value.length,
		types: [
			...new Set(
				value
					.slice(0, 128)
					.map((tool) =>
						isRecord(tool) &&
						typeof tool.type === "string" &&
						diagnosticToolTypes.has(tool.type)
							? tool.type
							: "unknown",
					),
			),
		],
		truncated: value.length > 128,
	}
}

export const summarizeRequestTools = (body: Record<string, unknown>) => {
	const additional = Array.isArray(body.input)
		? body.input
				.slice(0, 128)
				.filter((item) => isRecord(item) && item.type === "additional_tools")
		: []
	return {
		topLevel: toolTypes(body.tools),
		additionalTools: additional
			.slice(0, 8)
			.map((item) => toolTypes(item.tools)),
		additionalToolsTruncated: additional.length > 8,
		inputScanTruncated: Array.isArray(body.input) && body.input.length > 128,
	}
}

type UpstreamSummary = {
	responsesLite: boolean
	capture: "captured" | "unavailable"
	tools?: ReturnType<typeof summarizeRequestTools>
}
const context = new AsyncLocalStorage<{
	upstream?: UpstreamSummary
	trace?: ResponsesLifecycleTrace
}>()

export const withResponsesRequestDiagnostics = <T>(
	diagnostic: boolean | { trace: ResponsesLifecycleTrace } | undefined,
	run: () => T,
): T =>
	diagnostic
		? context.run(
				{
					trace: typeof diagnostic === "boolean" ? undefined : diagnostic.trace,
				},
				run,
			)
		: run()

export const upstreamRequestSummary = () => context.getStore()?.upstream

const observeUpstreamBody = (
	response: Response,
	trace: ResponsesLifecycleTrace,
	upstreamCall: number,
	target: "responses" | "search",
	signal?: AbortSignal | null,
): Response => {
	if (!response.body) return response
	const reader = response.body.getReader()
	let settled = false
	let released = false
	let bytes = 0
	let firstByteAt: string | undefined
	let lastByteAt: string | undefined
	const details = () => ({
		upstreamCall,
		target,
		firstByteAt,
		lastByteAt,
		bytes,
		signalAborted: signal?.aborted ?? false,
	})
	const release = () => {
		if (released) return
		try {
			reader.releaseLock()
			released = true
			trace.record("upstream_reader_released", details())
		} catch {
			/* A pending read can retain the lock until it settles. */
		}
	}
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const { done, value } = await reader.read()
					if (done) {
						settled = true
						trace.record("upstream_body_end", details())
						controller.close()
						release()
						return
					}
					lastByteAt = new Date().toISOString()
					bytes += value.byteLength
					if (!firstByteAt) {
						firstByteAt = lastByteAt
						trace.record("upstream_first_byte", details())
					}
					controller.enqueue(value)
				} catch (error) {
					if (!settled) {
						settled = true
						trace.record("upstream_body_error", {
							...details(),
							errorName: safeStreamErrorName(error),
						})
						try {
							controller.error(error)
						} catch {
							/* The downstream may have canceled during the pending read. */
						}
					}
					release()
				}
			},
			async cancel(reason) {
				if (!settled) {
					settled = true
					trace.record("upstream_body_cancel", details())
				}
				try {
					await reader.cancel(reason)
				} finally {
					release()
				}
			},
		},
		{ highWaterMark: 0 },
	)
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

// Runs at the transport boundary, AFTER core normalization. Async-local state
// prevents concurrent requests from mixing summaries. The lifecycle probe reads
// upstream bytes only when the caller pulls its response body.
export const observeResponsesFetch =
	(transport: typeof fetch): typeof fetch =>
	async (input, init) => {
		const current = context.getStore()
		let target: "responses" | "search" | undefined
		if (current) {
			try {
				const url = input instanceof Request ? input.url : String(input)
				const pathname = new URL(url).pathname
				target = pathname.endsWith("/responses")
					? "responses"
					: pathname.endsWith("/alpha/search")
						? "search"
						: undefined
				if (target === "responses") {
					const summary: UpstreamSummary = {
						responsesLite:
							new Headers(init?.headers).get(
								"x-openai-internal-codex-responses-lite",
							) === "true",
						capture: "unavailable",
					}
					current.upstream = summary
					if (typeof init?.body === "string" && init.body.length <= 1_048_576) {
						const body: unknown = JSON.parse(init.body)
						if (isRecord(body)) {
							summary.tools = summarizeRequestTools(body)
							summary.capture = "captured"
						}
					}
				}
			} catch {
				/* Diagnostics must never change transport behavior. */
			}
		}
		if (!target || !current?.trace) return transport(input, init)
		const trace = current.trace
		const upstreamCall = trace.nextUpstreamCall()
		let response: Response
		try {
			response = await transport(input, init)
		} catch (error) {
			trace.record("upstream_fetch_error", {
				upstreamCall,
				target,
				errorName: safeStreamErrorName(error),
				signalAborted: init?.signal?.aborted ?? false,
			})
			throw error
		}
		trace.record("upstream_headers", {
			upstreamCall,
			target,
			status: response.status,
			signalAborted: init?.signal?.aborted ?? false,
		})
		if (
			!response.ok ||
			!response.body ||
			(target === "responses" &&
				!response.headers
					.get("content-type")
					?.toLowerCase()
					.includes("text/event-stream"))
		)
			return response
		try {
			return observeUpstreamBody(
				response,
				trace,
				upstreamCall,
				target,
				init?.signal,
			)
		} catch {
			return response
		}
	}
