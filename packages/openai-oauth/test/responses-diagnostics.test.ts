import type { OpenAIOAuthTransport } from "@openai-oauth/core"
import { describe, expect, test, vi } from "vitest"
import { handleResponsesRequest } from "../src/responses.js"
import {
	createResponsesDiagnostics,
	summarizeRejection,
} from "../src/responses-diagnostics.js"

describe("bounded Responses diagnostics", () => {
	test("distinguishes proxy validation from one upstream rejection without retries", async () => {
		const write = vi.fn()
		const begin = createResponsesDiagnostics(true, write)
		const client = {
			request: vi.fn(async () =>
				Response.json(
					{
						detail: [
							{
								loc: ["body", "tools", 3, "type"],
								type: "union_tag_invalid",
								msg: "Input tag 'apply_patch' does not match any of the expected tags",
								input: "PRIVATE",
							},
						],
					},
					{ status: 400 },
				),
			),
		} as unknown as OpenAIOAuthTransport
		const request = (body: unknown) =>
			new Request("http://fixture.invalid/v1/responses", {
				method: "POST",
				body: JSON.stringify(body),
			})
		await handleResponsesRequest(
			request({ previous_response_id: "fixture" }),
			client,
			begin(),
		)
		expect(client.request).not.toHaveBeenCalled()
		const response = await handleResponsesRequest(
			request({ model: "fixture", input: "PRIVATE", stream: true }),
			client,
			begin(),
		)
		expect(client.request).toHaveBeenCalledTimes(1)
		expect(response.status).toBe(400)
		expect(JSON.parse(write.mock.calls[0][0]).stage).toBe("proxy_validation")
		expect(JSON.parse(write.mock.calls[1][0])).toMatchObject({
			stage: "upstream_response",
			rejection: {
				param: "tools[3].type",
				type: "union_tag_invalid",
				reason: "unsupported_tool_or_tag",
			},
		})
		expect(write.mock.calls[1][0]).not.toContain("PRIVATE")
	})
	test("requires opt-in and caps each runtime at eight requests", async () => {
		expect(createResponsesDiagnostics(false)()).toBeUndefined()
		const write = vi.fn()
		const begin = createResponsesDiagnostics(true, write)
		for (let i = 0; i < 10; i++)
			await begin()?.("proxy_validation", new Response(null, { status: 400 }))
		expect(write).toHaveBeenCalledTimes(8)
	})

	test("reports safe rejection identifiers without changing the response", async () => {
		const write = vi.fn()
		const body = { detail: "Unsupported parameter: 'service_tier'" }
		const response = Response.json(body, { status: 400 })
		const result = await createResponsesDiagnostics(true, write)()?.(
			"upstream_response",
			response,
		)
		expect(result).toBe(response)
		expect(await result?.json()).toEqual(body)
		expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({
			stage: "upstream_response",
			status: 400,
			rejection: {
				format: "json",
				reason: "unsupported_parameter",
				referencedFields: ["service_tier"],
			},
		})
	})

	test.each([
		{
			label: "JSON detail string",
			body: JSON.stringify({ detail: "Unsupported parameter: 'service_tier'" }),
			contentType: "application/json",
			format: "json",
			reason: "unsupported_parameter",
		},
		{
			label: "JSON error string",
			body: JSON.stringify({ error: "Unsupported tool type: 'apply_patch'" }),
			contentType: "application/json",
			format: "json",
			reason: "unsupported_tool_or_tag",
		},
		{
			label: "JSON string",
			body: JSON.stringify("Stream must be set to true."),
			contentType: "application/json",
			format: "json",
			reason: "requires_stream_true",
		},
		{
			label: "top-level validation array",
			body: JSON.stringify([
				{
					type: "union_tag_invalid",
					loc: ["body", "tools", 3, "type"],
					msg: "Input tag 'apply_patch' does not match any of the expected tags",
					input: "PRIVATE",
				},
			]),
			contentType: "application/json",
			format: "json",
			reason: "unsupported_tool_or_tag",
		},
		{
			label: "plain-text error",
			body: "Unsupported parameter: 'service_tier'",
			contentType: "text/plain",
			format: "text",
			reason: "unsupported_parameter",
		},
		{
			label: "JSON with unknown fields",
			body: JSON.stringify({ arbitrary: "PRIVATE" }),
			contentType: "application/json",
			format: "json",
			reason: "unrecognized_message_withheld",
		},
		{
			label: "JSON primitive",
			body: "42",
			contentType: "application/json",
			format: "json",
			reason: "unrecognized_message_withheld",
		},
		{
			label: "HTML error",
			body: "<html><body>PRIVATE</body></html>",
			contentType: "text/html",
			format: "html",
			reason: "unrecognized_message_withheld",
		},
		{
			label: "malformed JSON",
			body: '{"secret":"PRIVATE"',
			contentType: "application/json",
			format: "invalid_json",
			reason: "unrecognized_message_withheld",
		},
		{
			label: "unrecognized text",
			body: "PRIVATE",
			contentType: "text/plain",
			format: "text",
			reason: "unrecognized_message_withheld",
		},
	])("safely describes $label and preserves its body", async ({
		body,
		contentType,
		format,
		reason,
	}) => {
		const write = vi.fn()
		const response = new Response(body, {
			status: 400,
			headers: {
				"content-type": contentType,
				authorization: "Bearer PRIVATE",
				"set-cookie": "PRIVATE",
			},
		})
		expect(
			await createResponsesDiagnostics(true, write)()?.(
				"upstream_response",
				response,
			),
		).toBe(response)
		const log = write.mock.calls[0][0]
		const rejection = JSON.parse(log).rejection
		expect(rejection).toMatchObject({ format, reason })
		if (reason === "unrecognized_message_withheld") {
			expect(rejection.withheldBecause).toMatch(/credentials or private data/)
		}
		expect(log).not.toMatch(/PRIVATE|Bearer|set-cookie/)
		expect(log.length).toBeLessThan(2048)
		expect(await response.text()).toBe(body)
	})

	test("reports why a body already in use could not be inspected", async () => {
		const write = vi.fn()
		const response = new Response("PRIVATE", { status: 400 })
		await response.text()
		await createResponsesDiagnostics(true, write)()?.(
			"upstream_response",
			response,
		)
		expect(JSON.parse(write.mock.calls[0][0]).rejection).toEqual({
			format: "text",
			formatSource: "content-type",
			reason: "withheld",
			withheldBecause:
				"Response body is unavailable for diagnostic inspection.",
		})
		expect(write.mock.calls[0][0]).not.toContain("PRIVATE")
	})

	test("withholds private messages, credentials, cookies, codes and params", async () => {
		const write = vi.fn()
		const response = Response.json(
			{
				error: {
					message:
						"Private prompt and file: SECRET. Authorization: Bearer SECRET. Cookie: SECRET",
					type: "SECRET",
					code: "SECRET",
					param: "SECRET",
				},
			},
			{
				status: 403,
				headers: { "set-cookie": "SECRET", authorization: "Bearer SECRET" },
			},
		)
		await createResponsesDiagnostics(true, write)()?.(
			"upstream_response",
			response,
		)
		const log = write.mock.calls[0][0]
		expect(log).not.toMatch(/SECRET|Private prompt|Authorization|Cookie|Bearer/)
		expect(
			summarizeRejection({
				error: {
					type: "invalid_request_error",
					code: "invalid_function_parameters",
					param: "tools[0].parameters",
				},
			}),
		).toMatchObject({
			type: "invalid_request_error",
			code: "invalid_function_parameters",
			param: "tools[0].parameters",
		})
	})

	test("does not read successful streams, even with a broken log sink", async () => {
		const stream = new ReadableStream<Uint8Array>()
		const response = new Response(stream, {
			headers: { "content-type": "text/event-stream" },
		})
		expect(
			await createResponsesDiagnostics(true, () => {
				throw new Error("sink")
			})()?.("upstream_response", response),
		).toBe(response)
		expect(response.bodyUsed).toBe(false)
		await stream.cancel()
	})

	test("caps rejected bodies at 16 KiB while preserving the original body", async () => {
		const write = vi.fn()
		const response = new Response("x".repeat(20_000), { status: 400 })
		await createResponsesDiagnostics(true, write)()?.(
			"upstream_response",
			response,
		)
		expect(JSON.parse(write.mock.calls[0][0]).rejection).toEqual({
			format: "text",
			formatSource: "content-type",
			reason: "withheld",
			withheldBecause: "Response body exceeds the 16384-byte diagnostic limit.",
		})
		expect((await response.text()).length).toBe(20_000)
	})

	test("stops inspecting stalled rejected bodies after one second", async () => {
		const write = vi.fn()
		const response = new Response(new ReadableStream<Uint8Array>(), {
			status: 400,
		})
		await createResponsesDiagnostics(true, write)()?.(
			"upstream_response",
			response,
		)
		expect(JSON.parse(write.mock.calls[0][0]).rejection).toEqual({
			format: "unknown",
			formatSource: "content-type",
			reason: "withheld",
			withheldBecause:
				"Response body inspection exceeded the 1000-millisecond diagnostic limit.",
		})
		await response.body?.cancel()
	})
})
