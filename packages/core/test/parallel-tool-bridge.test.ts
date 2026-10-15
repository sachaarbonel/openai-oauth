import { describe, expect, test } from "vitest"
import {
	adaptParallelInput,
	adaptParallelResponsesSse,
	parallelToolDefinition,
} from "../src/parallel-tool-bridge.js"
import { iterateServerSentEvents, normalizeResponsesSse } from "../src/sse.js"

const batch = {
	type: "function_call",
	id: "fc_parent",
	call_id: "call_parent",
	name: "__openai_oauth_parallel",
	status: "completed",
	arguments: JSON.stringify({
		calls: [
			{ name: "read_palette", arguments: {} },
			{ name: "read_layout", arguments: {} },
		],
	}),
}
const message = {
	type: "message",
	id: "msg_after",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text: "Reading done", annotations: [] }],
}
const event = (value: Record<string, unknown>) =>
	`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
const upstream = (...items: Record<string, unknown>[]) =>
	new Response(
		[
			event({
				type: "response.created",
				response: { id: "resp_batch", status: "in_progress", output: [] },
			}),
			...items.map(event),
			event({
				type: "response.completed",
				response: { id: "resp_batch", status: "completed", output: [] },
			}),
			"data: [DONE]\n\n",
		].join(""),
	).body as ReadableStream<Uint8Array>
const read = async (stream: ReadableStream<Uint8Array>) => {
	const values: Record<string, unknown>[] = []
	for await (const frame of iterateServerSentEvents(stream)) {
		if (frame.data === "[DONE]") continue
		values.push(JSON.parse(frame.data ?? ""))
	}
	return values
}

const continuation = (parent = batch.call_id): Record<string, unknown>[] => {
	const id = (value: string, index: number) =>
		`__openai_oauth_batch_${btoa(value).replace(/=+$/, "")}_${index}_2`
	return [
		...["read_palette", "read_layout"].map((name, index) => ({
			type: "function_call",
			id: id(batch.id, index),
			call_id: id(parent, index),
			name,
			arguments: "{}",
		})),
		...["blue", "grid"].map((output, index) => ({
			type: "function_call_output",
			call_id: id(parent, index),
			output,
		})),
	]
}

describe("Responses Lite parallel tool bridge", () => {
	test("advertises only one model-facing batch function", () => {
		const definition = parallelToolDefinition([
			{
				type: "function",
				name: "read_palette",
				description: "Read palette",
				parameters: { type: "object" },
			},
			{
				type: "function",
				name: "read_layout",
				description: "Read layout",
				parameters: { type: "object" },
			},
		])
		expect(definition.name).toBe("__openai_oauth_parallel")
		expect(
			definition.parameters.properties.calls.items.properties.name.enum,
		).toEqual(["read_palette", "read_layout"])
	})

	test("expands batch calls in SSE, shifts following indexes, and recombines results", async () => {
		const frames = await read(
			adaptParallelResponsesSse(
				normalizeResponsesSse(
					upstream(
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { ...batch, status: "in_progress", arguments: "" },
						},
						{
							type: "response.function_call_arguments.delta",
							output_index: 0,
							item_id: batch.id,
							delta: batch.arguments,
						},
						{
							type: "response.function_call_arguments.done",
							output_index: 0,
							item_id: batch.id,
							arguments: batch.arguments,
						},
						{ type: "response.output_item.done", output_index: 0, item: batch },
						{
							type: "response.output_item.added",
							output_index: 1,
							item: { ...message, status: "in_progress", content: [] },
						},
						{
							type: "response.output_item.done",
							output_index: 1,
							item: message,
						},
					),
				),
				new Set(["read_palette", "read_layout"]),
			),
		)
		const done = frames.filter(
			(frame) => frame.type === "response.output_item.done",
		)
		expect(done.map((frame) => frame.output_index)).toEqual([0, 1, 2])
		expect(
			done.map((frame) => (frame.item as Record<string, unknown>).name),
		).toEqual(["read_palette", "read_layout", undefined])
		const output = (
			frames.find((frame) => frame.type === "response.completed")
				?.response as Record<string, unknown>
		).output as Record<string, unknown>[]
		expect(output.map((item) => item.type)).toEqual([
			"function_call",
			"function_call",
			"message",
		])
		const [first, second] = output
		expect(first.call_id).not.toBe(second.call_id)
		const normalized = adaptParallelInput([
			first,
			second,
			{
				type: "function_call_output",
				call_id: first.call_id,
				output: "blue",
				status: "completed",
			},
			{
				type: "function_call_output",
				call_id: second.call_id,
				output: "permission denied",
				status: "incomplete",
			},
			{
				type: "function_call",
				id: "fc_other",
				call_id: "call_other",
				name: "ordinary",
				arguments: "{}",
			},
			{
				type: "function_call_output",
				call_id: "call_other",
				output: "unchanged",
			},
		]) as Record<string, unknown>[]
		expect(normalized).toHaveLength(4)
		expect(normalized[0]).toMatchObject({
			id: batch.id,
			call_id: batch.call_id,
			name: batch.name,
		})
		expect(JSON.parse(normalized[0].arguments as string)).toEqual(
			JSON.parse(batch.arguments),
		)
		expect(JSON.parse(normalized[1].output as string).results).toEqual([
			{ name: "read_palette", output: "blue", status: "completed" },
			{
				name: "read_layout",
				output: "permission denied",
				status: "incomplete",
			},
		])
		expect(normalized[2]).toMatchObject({
			call_id: "call_other",
			name: "ordinary",
		})
		expect(normalized[3]).toMatchObject({
			call_id: "call_other",
			output: "unchanged",
		})
	})

	test.each([
		"missing",
		"rewritten",
		"malformed",
		"mismatched",
		"conflicting",
	])("groups by call_id when SDK item IDs are %s", (mode) => {
		const input = continuation()
		const ids = input.slice(0, 2).map((call) => call.id)
		for (const [index, call] of input.slice(0, 2).entries()) {
			if (mode === "missing") delete call.id
			if (mode === "rewritten") call.id = `fc_sdk_${index}`
			if (mode === "malformed") call.id = "__openai_oauth_batch_invalid"
			if (mode === "mismatched") call.id = ids[1 - index]
			if (mode === "conflicting")
				call.id = `__openai_oauth_batch_${btoa(`fc_${index}`).replace(/=+$/, "")}_${index}_2`
		}
		const folded = adaptParallelInput(input) as Record<string, unknown>[]
		expect(folded).toHaveLength(2)
		expect(folded[0]).toMatchObject({
			id: `fc_${btoa(batch.call_id).replace(/=+$/, "")}`,
			call_id: batch.call_id,
			name: batch.name,
		})
		expect(JSON.parse(folded[0].arguments as string)).toEqual(
			JSON.parse(batch.arguments),
		)
		expect(folded[1].call_id).toBe(batch.call_id)
		// Reordering the child calls does not change the reconstructed parent.
		expect(adaptParallelInput([input[1], input[0], ...input.slice(2)])).toEqual(
			folded,
		)
	})

	test.each(
		[
			[],
			[{ type: "input_text", text: "blue" }],
			[
				{ type: "input_text", text: "blue" },
				{ type: "input_text", text: "\nsecond part" },
			],
		].map((parts) => ({ parts })),
	)("folds text content arrays losslessly: $parts", ({ parts }) => {
		const input = continuation()
		input[2].output = parts
		const folded = adaptParallelInput(input) as Record<string, unknown>[]
		expect(folded).toHaveLength(2)
		expect(JSON.parse(folded[1].output as string).results).toEqual([
			{ name: "read_palette", output: parts },
			{ name: "read_layout", output: "grid" },
		])
	})

	test.each(
		[
			[{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }],
			[
				{ type: "input_text", text: "Screenshot" },
				{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
			],
			[{ type: "input_file", file_id: "file_fixture" }],
			[{ type: "input_text", text: 123 }],
			{ structured: "result" },
			null,
		].map((output) => ({ output })),
	)("replays the whole group for non-text output: $output", ({ output }) => {
		const input = continuation()
		input[3].output = output
		const replayed = adaptParallelInput(input)
		expect(replayed).toEqual(input)
		for (const [index, item] of input.entries())
			expect(replayed[index]).toBe(item)
	})

	test.each([
		undefined,
		null,
		{},
		123,
		"invalid JSON",
		"[]",
		"null",
	])("replays the whole group for incompatible client arguments: %j", (args) => {
		const input = continuation()
		input[1].arguments = args
		expect(adaptParallelInput(input)).toEqual(input)
	})

	test("folds safe groups independently while preserving images and other history", () => {
		const imageGroup = continuation("call_image")
		imageGroup[2].output = [
			{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
		]
		const safeGroup = continuation("call_safe")
		const input = [message, ...imageGroup, ...safeGroup, message]
		expect(adaptParallelInput(input)).toEqual([
			message,
			...imageGroup,
			...adaptParallelInput(safeGroup),
			message,
		])
		expect(input).toHaveLength(10)
	})

	test("passes duplicate items and conflicting batch counts through unchanged", () => {
		const input = continuation()
		const duplicate = [...input, input[0], input[2]]
		expect(adaptParallelInput(duplicate)).toEqual(duplicate)
		input[1].call_id = String(input[1].call_id).replace(/_2$/, "_3")
		expect(adaptParallelInput(input)).toEqual(input)
	})

	test.each([
		"__openai_oauth_batch_invalid",
		"__openai_oauth_batch_!_0_1",
		"__openai_oauth_batch_YQ_1_1",
		"__openai_oauth_batch_YQ_0_17",
		"__openai_oauth_batch__w_0_1",
		`__openai_oauth_batch_${"YQ".repeat(600)}_0_1`,
	])("passes malformed child call IDs through unchanged: %s", (call_id) => {
		const input = [
			{ type: "function_call", call_id, name: "read_palette", arguments: "{}" },
			{ type: "function_call_output", call_id, output: "blue" },
		]
		expect(adaptParallelInput(input)).toEqual(input)
	})

	test("replays incomplete continuations without inventing tool results", async () => {
		const frames = await read(
			adaptParallelResponsesSse(
				normalizeResponsesSse(
					upstream(
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { ...batch, status: "in_progress", arguments: "" },
						},
						{ type: "response.output_item.done", output_index: 0, item: batch },
					),
				),
				new Set(["read_palette", "read_layout"]),
			),
		)
		const calls = frames
			.filter((frame) => frame.type === "response.output_item.done")
			.map((frame) => frame.item)
		const input = [
			...calls,
			{
				type: "function_call_output",
				call_id: (calls[0] as Record<string, unknown>).call_id,
				output: "blue",
			},
		]
		expect(adaptParallelInput(input)).toEqual(input)
	})

	test("preserves an upstream error after an unfinished batch call", async () => {
		const source = new Response(
			[
				event({
					type: "response.created",
					response: { id: "resp_failed", status: "in_progress", output: [] },
				}),
				event({
					type: "response.output_item.added",
					output_index: 0,
					item: { ...batch, status: "in_progress", arguments: "" },
				}),
				event({ type: "error", error: { message: "upstream failed" } }),
			].join(""),
		).body as ReadableStream<Uint8Array>
		const frames = await read(
			adaptParallelResponsesSse(
				source,
				new Set(["read_palette", "read_layout"]),
			),
		)
		expect(frames.map((frame) => frame.type)).toEqual([
			"response.created",
			"error",
		])
		expect(frames[1].error).toEqual({ message: "upstream failed" })
	})

	test("rejects a model call to an undeclared client tool", async () => {
		const invalid = {
			...batch,
			arguments: JSON.stringify({
				calls: [{ name: "unknown", arguments: {} }],
			}),
		}
		await expect(
			read(
				adaptParallelResponsesSse(
					normalizeResponsesSse(
						upstream(
							{
								type: "response.output_item.added",
								output_index: 0,
								item: { ...invalid, status: "in_progress", arguments: "" },
							},
							{
								type: "response.output_item.done",
								output_index: 0,
								item: invalid,
							},
						),
					),
					new Set(["read_palette"]),
				),
			),
		).rejects.toThrow("Invalid parallel tool name")
	})

	test("propagates downstream cancellation to the upstream stream", async () => {
		let canceled = false
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						event({
							type: "response.created",
							response: { id: "resp_cancel" },
						}),
					),
				)
			},
			cancel() {
				canceled = true
			},
		})
		const reader = adaptParallelResponsesSse(
			source,
			new Set(["read_palette"]),
		).getReader()
		await reader.read()
		await reader.cancel()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(canceled).toBe(true)
	})
})
