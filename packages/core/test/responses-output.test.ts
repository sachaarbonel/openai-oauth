import { describe, expect, test, vi } from "vitest"
import { createOpenAIOAuthTransport } from "../src/runtime.js"
import { normalizeResponsesSse } from "../src/sse.js"

const model = "gpt-6-astra"
const call = {
	type: "function_call",
	id: "fc_fixture",
	call_id: "call_fixture",
	name: "read_fixture",
	arguments: '{"label":"café 🐈"}',
	status: "completed",
}
const message = {
	type: "message",
	id: "msg_fixture",
	role: "assistant",
	status: "completed",
	phase: "commentary",
	content: [
		{ type: "output_text", text: "Checking the fixture.", annotations: [] },
	],
}
const done = (item: Record<string, unknown>, output_index: number) => ({
	type: "response.output_item.done",
	output_index,
	item,
})
const terminal = (output: unknown[] = [], status = "completed") => ({
	type: `response.${status}`,
	response: {
		id: "resp_fixture",
		status,
		model,
		output,
		usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
	},
})
const encodeEvent = (event: Record<string, unknown>) =>
	`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const encodeEvents = (events: Record<string, unknown>[]) =>
	events.map(encodeEvent).join("")

const request = async (body: BodyInit, stream = true) => {
	const fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input))
		if (url.pathname.endsWith("/models")) {
			return Response.json({ models: [{ slug: model }] })
		}
		expect(url.pathname).toBe("/backend-api/codex/responses")
		return new Response(body, {
			headers: { "content-type": "text/event-stream" },
		})
	})
	const transport = createOpenAIOAuthTransport({
		auth: { accessToken: "inert-fixture", accountId: "inert-fixture" },
		codexVersion: "0.144.1",
		responsesState: false,
		fetch,
	})
	return transport.request("/responses", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, stream, input: "Synthetic fixture" }),
	})
}

const eventsFrom = async (response: Response) =>
	(await response.text())
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)))

describe("Responses terminal output compatibility", () => {
	test.each([
		true,
		false,
	])("preserves completed streamed items with stream=%s", async (stream) => {
		const input = [done(message, 0), done(call, 1), terminal()]
		const response = await request(encodeEvents(input), stream)
		const result = stream
			? (await eventsFrom(response)).at(-1).response
			: await response.json()
		expect(result).toEqual({ ...terminal().response, output: [message, call] })
	})

	test("does not replace or append to nonempty terminal output", async () => {
		const final = { ...message, phase: "final_answer" }
		const bytes = encodeEvents([
			done(message, 0),
			done(call, 1),
			terminal([final]),
		])
		expect(await (await request(bytes)).text()).toBe(bytes)
	})

	test.each([
		"failed",
		"incomplete",
		"cancelled",
		"canceled",
	])("does not reconstruct a %s response", async (status) => {
		const bytes = encodeEvents([done(call, 0), terminal([], status)])
		expect(await (await request(bytes)).text()).toBe(bytes)
		expect(await (await request(bytes, false)).json()).toEqual(
			terminal([], status).response,
		)
	})

	test("orders interleaved done items by output_index and deduplicates repeats", async () => {
		const reasoning = {
			type: "reasoning",
			id: "rs_fixture",
			summary: [],
			encrypted_content: "fixture-only",
		}
		const input = [
			done(call, 2),
			done(reasoning, 0),
			done(message, 1),
			done(call, 2),
			terminal(),
		]
		const result = (await eventsFrom(await request(encodeEvents(input)))).at(-1)
		expect(result.response.output).toEqual([reasoning, message, call])
	})

	test.each([
		[
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { ...call, status: "in_progress", arguments: "" },
			},
		],
		[done({ ...call, status: "incomplete" }, 0)],
		[done(call, 1)],
		[done(call, 0), done({ ...call, arguments: '{"different":true}' }, 0)],
		[done(call, 0), done({ ...call, id: "another_id" }, 0)],
		[done(call, 0), done(call, 1)],
		[done(call, 0), done({ ...call, id: "another_id" }, 1)],
		[
			{ type: "response.output_item.added", output_index: 0, item: call },
			done({ ...call, call_id: "changed_call" }, 0),
		],
	])("fails closed instead of repairing ambiguous/incomplete items (%#)", async (...items) => {
		const bytes = encodeEvents([...items, terminal()])
		const response = await request(bytes)
		await expect(response.text()).rejects.toThrow()
		await expect(request(bytes, false)).rejects.toThrow()
	})

	test("repairs absent output but leaves a genuinely empty response unchanged", async () => {
		const { output: _output, ...response } = terminal().response
		const input = [done(call, 0), { type: "response.completed", response }]
		const result = (await eventsFrom(await request(encodeEvents(input)))).at(-1)
		expect(result.response.output).toEqual([call])
		const empty = encodeEvent(terminal())
		expect(await (await request(empty)).text()).toBe(empty)
	})

	test("does not manufacture completion at EOF", async () => {
		const bytes = encodeEvents([
			{
				type: "response.created",
				response: { id: "resp_fixture", status: "in_progress" },
			},
			done(call, 0),
		])
		await expect(request(bytes, false)).rejects.toThrow()
		await expect((await request(bytes)).text()).rejects.toThrow()
	})

	test.each([
		1, 7, 53, 4096,
	])("handles UTF-8 and CRLF split into %s-byte chunks", async (size) => {
		const source = encodeEvents([done(call, 0), terminal()]).replaceAll(
			"\n",
			"\r\n",
		)
		const bytes = new TextEncoder().encode(source)
		let offset = 0
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset === bytes.length) return controller.close()
				controller.enqueue(bytes.slice(offset, offset + size))
				offset = Math.min(offset + size, bytes.length)
			},
		})
		const result = (await eventsFrom(await request(body))).at(-1)
		expect(result.response.output).toEqual([call])
	})

	test("preserves comments, ids, retry, multiline data, and all unrelated frames", async () => {
		const prefix = `: keepalive\n\nid: first\n${encodeEvent(done(call, 0))}`
		const last = terminal()
		const data = JSON.stringify(last, null, 2)
			.split("\n")
			.map((line) => `data: ${line}`)
			.join("\n")
		const response = await request(
			`${prefix}: terminal comment\nid: last\nretry: 1000\nevent: response.completed\n${data}\n\ndata: [DONE]\n\n`,
		)
		const result = await response.text()
		expect(result).toBe(
			`${prefix}: terminal comment\nid: last\nretry: 1000\nevent: response.completed\ndata: ${JSON.stringify({ ...last, response: { ...last.response, output: [call] } })}\n\ndata: [DONE]\n\n`,
		)
	})

	test("keeps native/custom tool items and optional metadata intact", async () => {
		const patch = {
			type: "apply_patch_call",
			id: "patch_fixture",
			call_id: "patch_call",
			status: "completed",
			operation: { type: "create_file", path: "fixture.txt", diff: "+fixture" },
		}
		const custom = {
			type: "custom_tool_call",
			id: "custom_fixture",
			call_id: "custom_call",
			name: "fixture",
			input: "raw fixture",
			status: "completed",
		}
		const result = (
			await eventsFrom(
				await request(
					encodeEvents([done(patch, 1), done(custom, 0), terminal()]),
				),
			)
		).at(-1)
		expect(result.response.output).toEqual([custom, patch])
	})

	test("accepts a duplicate done item whose JSON object keys are reordered", async () => {
		const reordered = Object.fromEntries(Object.entries(call).reverse())
		const result = (
			await eventsFrom(
				await request(
					encodeEvents([done(call, 0), done(reordered, 0), terminal()]),
				),
			)
		).at(-1)
		expect(result.response.output).toEqual([call])
	})

	test("does not join output from different response ids", async () => {
		const input = [
			{
				type: "response.created",
				response: { id: "resp_other", status: "in_progress" },
			},
			done(call, 0),
			terminal(),
		]
		await expect((await request(encodeEvents(input))).text()).rejects.toThrow(
			"conflicting",
		)
	})

	test("keeps error events and failed completion envelopes unchanged", async () => {
		for (const last of [
			{ type: "error", error: { message: "Synthetic failure" } },
			{ ...terminal(), response: { ...terminal().response, status: "failed" } },
		]) {
			const bytes = encodeEvents([done(call, 0), last])
			expect(await (await request(bytes)).text()).toBe(bytes)
		}
	})

	test("does not need terminal output to forward text and cancel a stalled upstream", async () => {
		const prefix = encodeEvent({
			type: "response.output_text.delta",
			delta: "Visible immediately",
		})
		const cancel = vi.fn()
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(prefix))
			},
			cancel,
		})
		const reader = normalizeResponsesSse(body).getReader()
		const chunk = await reader.read()
		expect(new TextDecoder().decode(chunk.value)).toBe(prefix)
		const pending = reader.read()
		const reason = new Error("Offline cancellation")
		await reader.cancel(reason)
		await expect(pending).resolves.toEqual({ done: true, value: undefined })
		await vi.waitFor(() => {
			expect(cancel).toHaveBeenCalledExactlyOnceWith(reason)
			expect(body.locked).toBe(false)
		})
		reader.releaseLock()
	})

	test("does not drain the upstream while the downstream is idle", async () => {
		let reads = 0
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				reads++
				controller.enqueue(new TextEncoder().encode(": keepalive\n\n"))
			},
		})
		const reader = normalizeResponsesSse(body).getReader()
		await reader.read()
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(reads).toBeLessThanOrEqual(4)
		await reader.cancel()
		reader.releaseLock()
	})

	test("cancels an upstream stream that exceeds the output item bound", async () => {
		const cancel = vi.fn()
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(encodeEvent(done(call, 4096))),
				)
			},
			cancel,
		})
		await expect((await request(body)).text()).rejects.toThrow("limit")
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
	})
})
