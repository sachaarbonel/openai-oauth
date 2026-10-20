import type { OpenAIOAuthTransport } from "@openai-oauth/core"
import {
	copyUpstreamResponse,
	isRecord,
	toErrorResponse,
	toJsonResponse,
} from "./shared.js"

/** The Codex V2 protocol compacts through the regular Responses transport. */
export const handleCompactionRequest = async (
	request: Request,
	client: OpenAIOAuthTransport,
): Promise<Response> => {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return toErrorResponse("Request body must be valid JSON.")
	}
	if (
		!isRecord(body) ||
		typeof body.model !== "string" ||
		!body.model.trim() ||
		!(
			(typeof body.input === "string" && body.input.trim().length > 0) ||
			(Array.isArray(body.input) && body.input.length > 0)
		) ||
		(body.instructions !== undefined && typeof body.instructions !== "string")
	)
		return toErrorResponse(
			"Compaction requires a model and nonempty input, with optional instructions.",
		)
	if (
		Object.keys(body).some(
			(key) => !["model", "input", "instructions"].includes(key),
		)
	)
		return toErrorResponse(
			"Stateless compaction accepts only model, input and instructions. Replay context in input.",
		)
	const input =
		typeof body.input === "string"
			? [{ role: "user", content: body.input }]
			: body.input
	if (
		!Array.isArray(input) ||
		input.some(
			(item) =>
				!isRecord(item) ||
				item.type === "item_reference" ||
				item.type === "compaction_trigger",
		)
	)
		return toErrorResponse(
			"Compaction requires complete input items without server references or trigger items.",
		)
	const upstream = await client.request("/responses", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: body.model,
			input: [...input, { type: "compaction_trigger" }],
			instructions: body.instructions ?? "",
			store: false,
			stream: false,
			tools: [],
			parallel_tool_calls: false,
		}),
		signal: request.signal,
	})
	if (!upstream.ok) return copyUpstreamResponse(upstream)
	const value: unknown = await upstream.json()
	if (
		!isRecord(value) ||
		!Array.isArray(value.output) ||
		value.output.filter(
			(item) =>
				isRecord(item) &&
				item.type === "compaction" &&
				typeof item.encrypted_content === "string" &&
				item.encrypted_content.length > 0,
		).length !== 1 ||
		value.output.some(
			(item) =>
				!isRecord(item) ||
				!["message", "reasoning", "compaction"].includes(String(item.type)),
		) ||
		value.status !== "completed"
	)
		return toErrorResponse(
			"Upstream did not return a completed native compaction window.",
			502,
			"compaction_failed",
		)
	const response = toJsonResponse({
		id: value.id,
		object: "response.compaction",
		created_at: value.created_at,
		output: value.output,
		usage: value.usage,
	})
	response.headers.set("Cache-Control", "no-store")
	return response
}
