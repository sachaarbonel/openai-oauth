import { describe, expect, test, vi } from "vitest"
import { adaptPatchResponsesSse } from "../src/apply-patch-bridge.js"
import { createOpenAIOAuthTransport } from "../src/runtime.js"

const patchCall = {
	type: "function_call",
	id: "fc_patch_fixture",
	call_id: "call_patch_fixture",
	name: "__openai_oauth_apply_patch",
	status: "completed",
	arguments: JSON.stringify({
		operation: { type: "create_file", path: "fixture.txt", diff: "+fixture" },
	}),
}
const event = (value: Record<string, unknown>) =>
	`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
const stream = () =>
	new Response(
		[
			event({
				type: "response.output_item.added",
				output_index: 0,
				item: { ...patchCall, status: "in_progress", arguments: "" },
			}),
			event({
				type: "response.function_call_arguments.delta",
				output_index: 0,
				item_id: patchCall.id,
				delta: patchCall.arguments,
			}),
			event({
				type: "response.function_call_arguments.done",
				output_index: 0,
				item_id: patchCall.id,
				arguments: patchCall.arguments,
			}),
			event({
				type: "response.output_item.done",
				output_index: 0,
				item: patchCall,
			}),
			event({
				type: "response.completed",
				response: {
					id: "resp_patch_fixture",
					status: "completed",
					output: [],
				},
			}),
		].join(""),
		{ headers: { "content-type": "text/event-stream" } },
	)

describe("Responses Lite apply_patch compatibility", () => {
	test("adapts a rejected native declaration and returns a native patch call", async () => {
		const upstream = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				if (String(url).includes("/models?"))
					return Response.json({
						models: [{ slug: "gpt-6-astra", use_responses_lite: true }],
					})
				const body = JSON.parse(String(init?.body))
				const definitions = [
					...(body.tools ?? []),
					...body.input.flatMap((item: { type: string; tools?: unknown[] }) =>
						item.type === "additional_tools" ? (item.tools ?? []) : [],
					),
				]
				if (
					definitions.some(
						(tool: { type: string }) => tool.type === "apply_patch",
					)
				)
					return Response.json(
						{ error: "Unsupported tool type: apply_patch" },
						{ status: 400 },
					)
				expect(body.tools).toBeUndefined()
				expect(definitions.map((tool: { type: string }) => tool.type)).toEqual([
					"function",
					"function",
					"function",
					"function",
					"function",
				])
				expect(definitions.at(-1)).toMatchObject({
					type: "function",
					name: "__openai_oauth_apply_patch",
				})
				return stream()
			},
		)
		const transport = createOpenAIOAuthTransport({
			auth: { accessToken: "inert", accountId: "inert" },
			codexVersion: "0.144.1",
			responsesState: false,
			fetch: upstream,
		})
		const response = await transport.request("/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-6-astra",
				stream: true,
				input: [
					{ role: "user", content: [{ type: "input_text", text: "fixture" }] },
				],
				tools: [
					...Array.from({ length: 4 }, (_, index) => ({
						type: "function",
						name: `tool_${index}`,
						parameters: { type: "object", properties: {} },
					})),
					{ type: "apply_patch" },
				],
			}),
		})
		expect(response.status).toBe(200)
		const lines = (await response.text())
			.split("\n")
			.filter((line) => line.startsWith("data: "))
		const events = lines.map((line) => JSON.parse(line.slice(6)))
		const done = events.find(
			(value) => value.type === "response.output_item.done",
		)
		expect(done.item).toMatchObject({
			type: "apply_patch_call",
			call_id: patchCall.call_id,
			operation: { type: "create_file", path: "fixture.txt", diff: "+fixture" },
		})
		expect(events.at(-1).response.output).toEqual([done.item])
		expect(
			events.some(
				(value) => value.type === "response.function_call_arguments.delta",
			),
		).toBe(false)
		expect(upstream).toHaveBeenCalledTimes(2)
	})

	test("avoids collisions with caller functions and keeps patch calls available with existing additional_tools", async () => {
		const upstream = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				if (String(url).includes("/models?"))
					return Response.json({
						models: [{ slug: "gpt-6-astra", use_responses_lite: true }],
					})
				const body = JSON.parse(String(init?.body))
				const definitions = body.input.find(
					(item: { type: string }) => item.type === "additional_tools",
				).tools
				expect(definitions.map((item: { name: string }) => item.name)).toEqual([
					"__openai_oauth_apply_patch",
					"__openai_oauth_apply_patch_1",
				])
				expect(body.tools).toBeUndefined()
				return new Response(null)
			},
		)
		const transport = createOpenAIOAuthTransport({
			auth: { accessToken: "inert", accountId: "inert" },
			codexVersion: "0.144.1",
			responsesState: false,
			fetch: upstream,
		})
		await transport.request("/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-6-astra",
				stream: true,
				input: [
					{
						type: "additional_tools",
						role: "developer",
						tools: [{ type: "function", name: "__openai_oauth_apply_patch" }],
					},
				],
				tools: [{ type: "apply_patch" }],
			}),
		})
	})

	test("cancelling an adapted stream releases its upstream body", async () => {
		const cancel = vi.fn()
		const upstream = vi.fn(async (url: RequestInfo | URL) => {
			if (String(url).includes("/models?"))
				return Response.json({
					models: [{ slug: "gpt-6-astra", use_responses_lite: true }],
				})
			return new Response(new ReadableStream<Uint8Array>({ cancel }), {
				headers: { "content-type": "text/event-stream" },
			})
		})
		const transport = createOpenAIOAuthTransport({
			auth: { accessToken: "inert", accountId: "inert" },
			codexVersion: "0.144.1",
			responsesState: false,
			fetch: upstream,
		})
		const response = await transport.request("/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-6-astra",
				stream: true,
				tools: [{ type: "apply_patch" }],
			}),
		})
		await response.body?.cancel()
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
	})

	test("rejects malformed adapted patch operations before emitting a native tool call", async () => {
		const unsafe = {
			...patchCall,
			arguments: JSON.stringify({
				operation: { type: "create_file", path: "fixture.txt" },
			}),
		}
		const source = new Response(
			event({
				type: "response.output_item.done",
				output_index: 0,
				item: unsafe,
			}),
		)
		if (!source.body) throw new Error("Missing fixture body")
		await expect(
			new Response(adaptPatchResponsesSse(source.body, unsafe.name)).text(),
		).rejects.toThrow("Invalid adapted apply_patch operation")
	})

	test("returns a native patch item when the caller requests a JSON response", async () => {
		const upstream = vi.fn(async (url: RequestInfo | URL) =>
			String(url).includes("/models?")
				? Response.json({
						models: [{ slug: "gpt-6-astra", use_responses_lite: true }],
					})
				: stream(),
		)
		const transport = createOpenAIOAuthTransport({
			auth: { accessToken: "inert", accountId: "inert" },
			codexVersion: "0.144.1",
			responsesState: false,
			fetch: upstream,
		})
		const response = await transport.request("/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-6-astra",
				stream: false,
				tools: [{ type: "apply_patch" }],
			}),
		})
		expect(response.headers.get("content-type")).toBe("application/json")
		expect(await response.json()).toMatchObject({
			status: "completed",
			output: [
				{ type: "apply_patch_call", operation: { type: "create_file" } },
			],
		})
	})
})
