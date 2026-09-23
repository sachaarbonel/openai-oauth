import type { OpenAIOAuthTransport } from "@openai-oauth/core"
import type { ResponseDiagnostic } from "./responses-diagnostics.js"
import { copyUpstreamResponse, isRecord, toErrorResponse } from "./shared.js"

const usesServerReplayState = (body: Record<string, unknown>): boolean =>
	typeof body.previous_response_id === "string" ||
	(Array.isArray(body.input) &&
		body.input.some(
			(item) =>
				isRecord(item) &&
				item.type === "item_reference" &&
				typeof item.id === "string",
		))

export const handleResponsesRequest = async (
	request: Request,
	client: OpenAIOAuthTransport,
	diagnostic?: ResponseDiagnostic,
): Promise<Response> => {
	const record = diagnostic ?? (async (_stage, response) => response)
	let body: unknown
	try {
		body = await request.json()
	} catch (error) {
		await record("proxy_validation", new Response(null, { status: 500 }))
		throw error
	}
	if (!isRecord(body)) {
		return record(
			"proxy_validation",
			toErrorResponse("Request body must be a JSON object."),
		)
	}

	if (usesServerReplayState(body)) {
		return record(
			"proxy_validation",
			toErrorResponse(
				"Stateless Codex responses endpoint does not support `previous_response_id` or `item_reference`. Replay the full conversation history in `input` on each request.",
			),
		)
	}

	let upstream: Response
	try {
		upstream = await client.request("/responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: request.signal,
		})
	} catch (error) {
		await record("transport_or_auth", new Response(null, { status: 500 }))
		throw error
	}
	await record("upstream_response", upstream)
	return copyUpstreamResponse(upstream)
}
