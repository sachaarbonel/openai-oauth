import { randomUUID } from "node:crypto"
import { isRecord } from "./shared.js"

type Stage = "proxy_validation" | "upstream_response" | "transport_or_auth"
export type ResponseDiagnostic = (
	stage: Stage,
	response: Response,
) => Promise<Response>

const safeWords = new Set([
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

// Error fields can echo secrets and prompts. Only known protocol identifiers and
// fixed explanations leave this function; unrecognized prose is never logged.
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

// Explicit opt-in; first eight requests per runtime, <=16 KiB/1s per rejection.
// Successful SSE bodies are never read. Return the original response unchanged.
export const createResponsesDiagnostics = (
	enabled = process.env.CODEX_OPENAI_RESPONSES_DIAGNOSTICS === "1",
	write: (line: string) => void = (line) => console.log(line),
): (() => ResponseDiagnostic | undefined) => {
	let remaining = 8
	return () => {
		if (!enabled || remaining-- <= 0) return undefined
		const requestId = randomUUID()
		const started = Date.now()
		return async (stage, response) => {
			try {
				write(
					JSON.stringify({
						source: "openai-oauth-responses-diagnostic",
						timestamp: new Date().toISOString(),
						requestId,
						stage,
						status: response.status,
						durationMs: Date.now() - started,
						rejection: response.ok ? undefined : await readSummary(response),
					}),
				)
			} catch {
				/* Diagnostics must not affect the request. */
			}
			return response
		}
	}
}
