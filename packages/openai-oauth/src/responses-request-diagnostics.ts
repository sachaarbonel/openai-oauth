import { AsyncLocalStorage } from "node:async_hooks"
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
const context = new AsyncLocalStorage<{ upstream?: UpstreamSummary }>()

export const withResponsesRequestDiagnostics = <T>(
	enabled: boolean,
	run: () => T,
): T => (enabled ? context.run({}, run) : run())

export const upstreamRequestSummary = () => context.getStore()?.upstream

// Runs at the transport boundary, AFTER core normalization. Async-local state
// prevents concurrent requests from mixing summaries. No streams are consumed.
export const observeResponsesFetch =
	(transport: typeof fetch): typeof fetch =>
	async (input, init) => {
		const current = context.getStore()
		if (current) {
			try {
				const url = input instanceof Request ? input.url : String(input)
				if (new URL(url).pathname.endsWith("/responses")) {
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
		return transport(input, init)
	}
