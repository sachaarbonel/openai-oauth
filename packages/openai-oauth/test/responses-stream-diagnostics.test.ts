import { describe, expect, test, vi } from "vitest"
import { createResponsesLifecycleTrace } from "../src/responses-lifecycle-diagnostics.js"
import {
	getResponsesStreamObserver,
	observeResponsesStream,
} from "../src/responses-stream-diagnostics.js"

const response = () =>
	new Response(new ReadableStream<Uint8Array>(), {
		headers: { "content-type": "text/event-stream" },
	})

describe("Responses stream diagnostics", () => {
	test("bounds lifecycle records and discards traces that were not selected", () => {
		const write = vi.fn()
		const trace = createResponsesLifecycleTrace("fixture-id", write)
		for (let count = 0; count < 40; count++)
			trace.record("upstream_first_byte", { bytes: count })
		expect(write).not.toHaveBeenCalled()
		trace.activate()
		expect(write).toHaveBeenCalledTimes(25)
		expect(JSON.parse(write.mock.calls.at(-1)?.[0])).toMatchObject({
			requestId: "fixture-id",
			event: "event_limit",
		})
		trace.record("upstream_body_end")
		expect(write).toHaveBeenCalledTimes(25)
		const discarded = createResponsesLifecycleTrace("discarded-id", write)
		discarded.record("upstream_headers")
		discarded.discard()
		discarded.activate()
		expect(write).toHaveBeenCalledTimes(25)
	})

	test("records terminal type and bounded metadata without logging content or custom names", async () => {
		const write = vi.fn()
		const upstream = response()
		expect(observeResponsesStream(upstream, "fixture-id", write)).toBe(upstream)
		const observer = getResponsesStreamObserver(upstream)
		const event = `event: PRIVATE_EVENT\ndata: PRIVATE_EVENT_BODY\n\nevent: response.completed\ndata: ${JSON.stringify(
			{
				response: {
					output: [
						{ type: "message", content: "PRIVATE_PROMPT" },
						{
							type: "function_call",
							name: "PRIVATE_TOOL",
							arguments: "PRIVATE_ARGS",
						},
						{ type: "apply_patch_call", name: "apply_patch" },
					],
				},
			},
		)}\n\n`
		const bytes = new TextEncoder().encode(event)
		observer?.chunk(bytes.subarray(0, 17))
		observer?.chunk(bytes.subarray(17))
		observer?.finish("forwarded")
		observer?.finish("client_closed")
		expect(write).toHaveBeenCalledTimes(1)
		const line = write.mock.calls[0][0]
		expect(JSON.parse(line)).toMatchObject({
			requestId: "fixture-id",
			outcome: "forwarded",
			terminal: "response.completed",
			itemTypes: ["message", "function_call", "apply_patch_call"],
			toolNames: ["apply_patch"],
			withheldToolNames: 1,
			outputSummary: "captured",
			firstEventType: "other",
			lastEventType: "response.completed",
			firstEventAt: expect.any(String),
			lastEventAt: expect.any(String),
			terminalAt: expect.any(String),
		})
		expect(line).not.toMatch(/PRIVATE/)
		expect(upstream.bodyUsed).toBe(false)
		await upstream.body?.cancel()
	})

	test("distinguishes a failed stream from close before any terminal event", async () => {
		const write = vi.fn()
		for (const [event, outcome] of [
			["response.failed", "forwarded"],
			["response.incomplete", "forwarded"],
			["error", "forwarded"],
			[undefined, "client_closed"],
		] as const) {
			const upstream = response()
			observeResponsesStream(upstream, "fixture-id", write)
			if (event)
				getResponsesStreamObserver(upstream)?.chunk(
					new TextEncoder().encode(
						`event: ${event}\ndata: {"error":"PRIVATE"}\n\n`,
					),
				)
			getResponsesStreamObserver(upstream)?.finish(outcome)
			await upstream.body?.cancel()
		}
		expect(write.mock.calls.map(([line]) => JSON.parse(line).terminal)).toEqual(
			["response.failed", "response.incomplete", "error", "not_observed"],
		)
		expect(write.mock.calls.map(([line]) => JSON.parse(line).outcome)).toEqual([
			"forwarded",
			"forwarded",
			"forwarded",
			"client_closed",
		])
		expect(write.mock.calls.flat().join(" ")).not.toContain("PRIVATE")
	})

	test("bounds oversized events and withholds arbitrary forwarding errors", async () => {
		const write = vi.fn()
		const upstream = response()
		observeResponsesStream(upstream, "fixture-id", write)
		const observer = getResponsesStreamObserver(upstream)
		observer?.chunk(
			new TextEncoder().encode(
				`event: response.completed\ndata: ${"PRIVATE".repeat(30_000)}\n\n`,
			),
		)
		observer?.finish("forward_error", new Error("PRIVATE_CREDENTIAL"))
		const line = write.mock.calls[0][0]
		expect(JSON.parse(line)).toMatchObject({
			outcome: "forward_error",
			terminal: "response.completed",
			outputSummary: "oversized_event",
			errorName: "Error",
		})
		expect(line).not.toContain("PRIVATE")
		await upstream.body?.cancel()
	})
})
