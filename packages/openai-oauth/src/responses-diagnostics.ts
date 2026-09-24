import { randomUUID } from "node:crypto"
import {
	diagnosticToolTypes,
	summarizeRequestTools,
	upstreamRequestSummary,
} from "./responses-request-diagnostics.js"
import { observeResponsesStream } from "./responses-stream-diagnostics.js"
import { isRecord } from "./shared.js"

type Stage = "proxy_validation" | "upstream_response" | "transport_or_auth"
export type ResponseDiagnostic = (
	stage: Stage,
	response: Response,
	requestBody?: Record<string, unknown>,
) => Promise<Response>

const safeWords = new Set([
	...diagnosticToolTypes,
	"invalid_request_error",
	"invalid_function_parameters",
	"invalid_type",
	"invalid_value",
	"unsupported_parameter",
	"unsupported_value",
	"validation_error",
	"union_tag_invalid",
	"literal_error",
	"extra_forbidden",
	"missing",
	"missing_required_parameter",
	"model_not_found",
	"context_length_exceeded",
	"rate_limit_exceeded",
	"insufficient_quota",
	"usage_limit_reached",
	"server_error",
	"authentication_error",
	"permission_error",
	"access_denied",
	"service_unavailable_error",
	"model",
	"input",
	"instructions",
	"tools",
	"tool_choice",
	"parallel_tool_calls",
	"reasoning",
	"effort",
	"summary",
	"context",
	"text",
	"verbosity",
	"format",
	"service_tier",
	"store",
	"stream",
	"include",
	"previous_response_id",
	"conversation",
	"max_output_tokens",
	"temperature",
	"top_p",
	"truncation",
	"type",
	"name",
	"parameters",
	"properties",
	"items",
	"required",
	"strict",
	"additionalProperties",
	"anyOf",
	"oneOf",
	"allOf",
	"enum",
	"content",
	"additional_tools",
	"environment",
	"background",
	"metadata",
	"prompt",
	"function",
	"custom",
	"namespace",
	"apply_patch",
	"shell",
	"local_shell",
	"computer",
	"web_search",
	"file_search",
	"code_interpreter",
])

const safeField = (value: unknown) => {
	if (typeof value !== "string" || value.length > 160) return undefined
	const tokens = value.replace(/\[\d{1,5}\]/g, "").split(".")
	return tokens.every((token) => safeWords.has(token)) ? value : undefined
}

const serviceTiers = new Set([
	"auto",
	"default",
	"flex",
	"priority",
	"scale",
	"fast",
])

// Preserve word order and negation without copying arbitrary upstream prose.
// Every emitted word comes from this finite vocabulary; all other spans collapse
// to [redacted]. This is an outline, not the complete upstream explanation.
const messageWords = new Set([
	...[...safeWords].map((word) => word.toLowerCase()),
	...serviceTiers,
	..."invalid unsupported supported allowed disallowed forbidden permitted denied unavailable available required requires expected valid value values argument parameter field tier tiers account project plan must should can cannot is are was were be not only one of and or for with this the a an to on in set provided received does do support supports accept accepts accepted rejected enabled disabled tool tools namespaces".split(
		" ",
	),
])

const summarizeMessage = (message: string) => {
	const words: string[] = []
	// Drop credential-bearing header/assignment tails even when a credential
	// happens to be a word in the public protocol vocabulary.
	const text = message
		.replace(
			/\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=][^\r\n]*/gi,
			"[redacted]",
		)
		.replace(/\bcan't\b/gi, "cannot")
		.replace(/\b(is|are|was|were|does|do|must|should)n't\b/gi, "$1 not")
	for (const token of text.split(/[\s"'`:,;()[\]{}!?]+/)) {
		if (!token) continue
		const word = token.toLowerCase().replace(/\.$/, "")
		if (messageWords.has(word)) words.push(word)
		else if (words.at(-1) !== "[redacted]") words.push("[redacted]")
		if (words.length === 64) {
			words.push("[truncated]")
			break
		}
	}
	return words.join(" ").slice(0, 768) || undefined
}

const summarizeServiceTier = (body: Record<string, unknown>) => {
	const value = body.service_tier
	if (value === undefined) return "omitted"
	if (value === null) return "null"
	return typeof value === "string" && serviceTiers.has(value)
		? value
		: "unrecognized_value_withheld"
}

// Error fields can echo secrets and prompts. Only known protocol identifiers and
// fixed vocabulary leave this function; unrecognized prose is never logged.
export const summarizeRejection = (body: unknown) => {
	const root = isRecord(body) ? body : {}
	const errors = Array.isArray(root.detail)
		? root.detail
		: Array.isArray(body)
			? body
			: undefined
	const validation = errors && isRecord(errors[0]) ? errors[0] : undefined
	const shape = isRecord(root.error)
		? "error_object"
		: isRecord(root.detail)
			? "detail_object"
			: Array.isArray(root.detail)
				? "detail_array"
				: typeof root.error === "string"
					? "error_string"
					: typeof root.detail === "string"
						? "detail_string"
						: Array.isArray(body)
							? "array"
							: isRecord(body)
								? "object"
								: typeof body === "string"
									? "string"
									: "primitive"
	const error = isRecord(root.error)
		? root.error
		: isRecord(root.detail)
			? root.detail
			: (validation ?? root)
	const message =
		typeof error.message === "string"
			? error.message
			: typeof error.msg === "string"
				? error.msg
				: typeof root.error === "string"
					? root.error
					: typeof root.detail === "string"
						? root.detail
						: typeof body === "string"
							? body
							: ""
	const reason = /^Unsupported (?:parameter|field):/i.test(message)
		? "unsupported_parameter"
		: /^Invalid schema for function /.test(message)
			? "invalid_function_schema"
			: /unsupported.*tool|tool.*not supported|does not match any of the expected tags/i.test(
						message,
					)
				? "unsupported_tool_or_tag"
				: /^Store must be set to false\.?$/i.test(message)
					? "requires_store_false"
					: /^Stream must be set to true\.?$/i.test(message)
						? "requires_stream_true"
						: "unrecognized_message_withheld"
	const referencedFields = [...safeWords]
		.filter((word) => new RegExp(`\\b${word}\\b`).test(message))
		.slice(0, 16)
	const loc = Array.isArray(error.loc)
		? error.loc.filter((part) => part !== "body")
		: []
	const location = loc
		.map((part, index) =>
			typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${part}`,
		)
		.join("")
	return {
		shape,
		type: safeField(error.type),
		code: safeField(error.code),
		param: safeField(error.param) ?? safeField(location),
		reason,
		messageSummary: summarizeMessage(message),
		withheldBecause:
			reason === "unrecognized_message_withheld"
				? message
					? "Message is not a recognized safe error template; free-form text may contain credentials or private data."
					: "No recognized error message field; arbitrary body fields may contain credentials or private data."
				: undefined,
		referencedFields,
	}
}

const readSummary = async (response: Response) => {
	// Only record a fixed format category, never the raw Content-Type header.
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
	const declaredFormat = contentType.includes("json")
		? "json"
		: contentType.includes("html")
			? "html"
			: contentType.startsWith("text/")
				? "text"
				: "unknown"
	const withheld = (why: string) => ({
		format: declaredFormat,
		formatSource: "content-type",
		reason: "withheld",
		withheldBecause: why,
	})
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
	try {
		reader = response.clone().body?.getReader()
	} catch {
		return withheld("Response body is unavailable for diagnostic inspection.")
	}
	if (!reader)
		return {
			format: "empty",
			reason: "withheld",
			withheldBecause: "Response has no error body.",
		}
	const bodyReader = reader
	let timedOut = false
	const timeout = setTimeout(() => {
		timedOut = true
		void bodyReader.cancel().catch(() => undefined)
	}, 1_000)
	let text = ""
	let bytes = 0
	const decoder = new TextDecoder()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			bytes += value.byteLength
			if (bytes > 16_384)
				return withheld(
					"Response body exceeds the 16384-byte diagnostic limit.",
				)
			text += decoder.decode(value, { stream: true })
		}
		if (timedOut)
			return withheld(
				"Response body inspection exceeded the 1000-millisecond diagnostic limit.",
			)
		text += decoder.decode()
		if (!text.trim())
			return {
				format: "empty",
				reason: "withheld",
				withheldBecause: "Response error body is empty.",
			}
		try {
			return { format: "json", ...summarizeRejection(JSON.parse(text)) }
		} catch {
			const format = /^\s*(?:<!doctype html\b|<html\b)/i.test(text)
				? "html"
				: declaredFormat === "json"
					? "invalid_json"
					: "text"
			return { format, ...summarizeRejection(text) }
		}
	} catch {
		return withheld(
			"Response body could not be read for diagnostic inspection.",
		)
	} finally {
		clearTimeout(timeout)
		void reader.cancel().catch(() => undefined)
		reader.releaseLock()
	}
}

// Explicit opt-in; independent success/rejection budgets renew every minute.
// Each rejection remains limited to 16 KiB/1s of inspection.
// Stream metadata is observed only as the Node response writer forwards bytes.
export const createResponsesDiagnostics = (
	enabled = process.env.CODEX_OPENAI_RESPONSES_DIAGNOSTICS === "1",
	write: (line: string) => void = (line) => console.log(line),
	now: () => number = Date.now,
): (() => ResponseDiagnostic | undefined) => {
	const budgets = {
		success: { started: now(), used: 0 },
		rejection: { started: now(), used: 0 },
	}
	return () => {
		if (!enabled) return undefined
		const requestId = randomUUID()
		const started = Date.now()
		return async (stage, response, requestBody) => {
			const category = response.ok ? "success" : "rejection"
			const budget = budgets[category]
			const timestamp = now()
			if (timestamp - budget.started >= 60_000) {
				budget.started = timestamp
				budget.used = 0
			}
			// Reserve before awaiting body inspection, including concurrent requests.
			if (budget.used++ >= 8) {
				if (budget.used === 9) {
					try {
						write(
							JSON.stringify({
								source: "openai-oauth-responses-diagnostic-limit",
								timestamp: new Date(timestamp).toISOString(),
								requestId,
								category,
								status: response.status,
								reason:
									"Eight diagnostics captured in this category; further details withheld until reset.",
								resumesAt: new Date(budget.started + 60_000).toISOString(),
							}),
						)
					} catch {
						/* Diagnostics must not affect the request. */
					}
				}
				return response
			}
			try {
				write(
					JSON.stringify({
						source: "openai-oauth-responses-diagnostic",
						timestamp: new Date().toISOString(),
						requestId,
						stage,
						status: response.status,
						durationMs: Date.now() - started,
						request: requestBody
							? {
									serviceTier: summarizeServiceTier(requestBody),
									tools: summarizeRequestTools(requestBody),
								}
							: undefined,
						upstreamRequest: upstreamRequestSummary(),
						rejection: response.ok ? undefined : await readSummary(response),
					}),
				)
			} catch {
				/* Diagnostics must not affect the request. */
			}
			return stage === "upstream_response"
				? observeResponsesStream(response, requestId, write)
				: response
		}
	}
}
