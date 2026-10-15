import { describe, expect, test } from "vitest"
import { createOpenAIOAuthTransport } from "../src/runtime.js"
import { collectCompletedResponseFromSse } from "../src/sse.js"

const batch = {
	type: "function_call",
	id: "fc_original_batch",
	call_id: "call_original_batch",
	name: "__openai_oauth_parallel",
	status: "completed",
	arguments: JSON.stringify({
		calls: [
			{ name: "exec_command", arguments: { cmd: "pwd" } },
			{ name: "view_image", arguments: { path: "fixture.png" } },
		],
	}),
}
const tools = ["exec_command", "view_image"].map((name) => ({
	type: "function",
	name,
	parameters: { type: "object" },
}))
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`

// Conservative Lite replay contract, checked independently at the actual fetch
// boundary. This covers function items, not the full public Responses schema.
const inputIssues = (input: Record<string, unknown>[]) =>
	input.flatMap((item, index) => {
		const issues: string[] = []
		if (item.type === "function_call") {
			if (typeof item.id !== "string" || !/^fc_[A-Za-z0-9_-]+$/.test(item.id))
				issues.push(`input[${index}].function_call.id`)
			if (typeof item.arguments !== "string")
				issues.push(`input[${index}].function_call.arguments`)
		}
		if (item.type === "function_call" || item.type === "function_call_output") {
			if (
				typeof item.call_id !== "string" ||
				!/^[A-Za-z0-9_-]{1,64}$/.test(item.call_id) ||
				item.call_id.startsWith("__openai_oauth_batch_")
			)
				issues.push(`input[${index}].${item.type}.call_id`)
		}
		if (item.type === "function_call_output" && typeof item.output !== "string")
			issues.push(`input[${index}].function_call_output.output`)
		return issues
	})

describe("Agents SDK parallel replay at the Lite transport boundary", () => {
	test.each([
		{ mode: "one missing", stream: true },
		{ mode: "all rewritten", stream: true },
		{ mode: "all missing", stream: true },
		{ mode: "all rewritten", stream: false },
		{ mode: "one missing", stream: true, legacy: true },
		{ mode: "all missing", stream: true, legacy: true },
	])("folds image output with $mode item IDs (stream=$stream)", async ({
		mode,
		stream,
		legacy,
	}) => {
		const bodies: Record<string, unknown>[] = []
		const transport = createOpenAIOAuthTransport({
			auth: { accessToken: "offline", accountId: "offline" },
			codexVersion: "0.144.1",
			fetch: async (url, init) => {
				if (String(url).includes("/models?"))
					return Response.json({
						models: [{ slug: "gpt-6.1-sol", use_responses_lite: true }],
					})
				expect(
					new Headers(init?.headers).get(
						"x-openai-internal-codex-responses-lite",
					),
				).toBe("true")
				bodies.push(JSON.parse(String(init?.body)))
				return new Response(
					frame({
						type: "response.output_item.done",
						output_index: 0,
						item: batch,
					}) +
						frame({
							type: "response.completed",
							response: {
								id: "resp_fixture",
								status: "completed",
								output: [batch],
							},
						}),
					{ headers: { "content-type": "text/event-stream" } },
				)
			},
		})
		const send = (input: unknown[], parallel = true) =>
			transport.request("responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "gpt-6.1-sol",
					instructions: "offline fixture",
					stream,
					parallel_tool_calls: parallel,
					tools: [...tools, { type: "custom", name: "apply_patch" }],
					input,
				}),
			})
		const first = await send([
			{ role: "user", content: "Inspect the screenshot" },
		])
		if (!first.body) throw new Error("Missing offline response body")
		const response = stream
			? await collectCompletedResponseFromSse(first.body)
			: await first.json()
		const expanded = response.output as Record<string, unknown>[]
		expect(expanded).toHaveLength(2)
		if (legacy)
			for (const [index, item] of expanded.entries())
				item.call_id = `__openai_oauth_batch_${btoa(batch.call_id).replace(/=+$/, "")}_${index}_2`
		if (mode === "one missing") delete expanded[1].id
		else if (mode === "all missing") for (const item of expanded) delete item.id
		else
			for (const [index, item] of expanded.entries())
				item.id = `fc_sdk_${index}`
		const history = [
			{ role: "user", content: "Inspect the screenshot" },
			...expanded,
			{
				type: "function_call_output",
				call_id: expanded[0].call_id,
				output: "fixture working directory",
			},
			{
				type: "function_call_output",
				call_id: expanded[1].call_id,
				output: [
					{ type: "input_text", text: "Screenshot from sandbox" },
					{
						type: "input_image",
						image_url: "data:image/png;base64,aW1hZ2U=",
						detail: "auto",
					},
				],
			},
		]
		await send(history)
		const input = bodies[1].input as Record<string, unknown>[]
		// On c5f6bcd this reports indexes 3/4 (id, call_id), 5/6
		// (call_id), and 6.output: the whole image group escaped folding.
		expect(inputIssues(input)).toEqual([])
		expect(bodies[1]).toEqual({
			model: "gpt-6.1-sol",
			instructions: "",
			stream: true,
			parallel_tool_calls: false,
			store: false,
			include: ["reasoning.encrypted_content"],
			reasoning: { context: "all_turns" },
			tools: [{ type: "custom", name: "apply_patch" }],
			input: [
				{
					type: "additional_tools",
					role: "developer",
					tools: (bodies[0].input as Record<string, unknown>[])[0].tools,
				},
				{
					role: "developer",
					content: [{ type: "input_text", text: "offline fixture" }],
				},
				{ role: "user", content: "Inspect the screenshot" },
				{
					...batch,
					id:
						legacy && mode === "all missing"
							? `fc_${btoa(batch.call_id).replace(/=+$/, "")}`
							: batch.id,
				},
				{
					type: "function_call_output",
					call_id: batch.call_id,
					output: JSON.stringify({
						results: [
							{ name: "exec_command", output: "fixture working directory" },
							{
								name: "view_image",
								output:
									"Screenshot from sandbox\n[Image omitted: Responses Lite tool outputs support text only.]",
							},
						],
					}),
				},
			],
		})
		// Replaying a previous parallel turn must also work after the caller
		// disables parallel calls, and alongside a custom apply_patch result.
		const patch = [
			{
				type: "custom_tool_call",
				id: "ctc_patch",
				call_id: "call_patch",
				name: "apply_patch",
				input: "*** Begin Patch\n*** End Patch",
			},
			{
				type: "custom_tool_call_output",
				call_id: "call_patch",
				output: "Done",
			},
		]
		await send([...patch, ...history], false)
		const replay = bodies[2].input as Record<string, unknown>[]
		expect(inputIssues(replay)).toEqual([])
		expect(replay.slice(2, 4)).toEqual(patch)
		expect(replay.slice(-2)).toEqual(input.slice(-2))
	})
	test.each([
		true,
		false,
	])("normalizes ordinary tool content arrays only on Lite (lite=%s)", async (lite) => {
		let forwarded: Record<string, unknown> = {}
		const transport = createOpenAIOAuthTransport({
			auth: { accessToken: "offline", accountId: "offline" },
			codexVersion: "0.144.1",
			fetch: async (url, init) => {
				if (String(url).includes("/models?"))
					return Response.json({
						models: [{ slug: "fixture", use_responses_lite: lite }],
					})
				forwarded = JSON.parse(String(init?.body))
				return new Response(
					frame({
						type: "response.completed",
						response: { id: "resp_fixture", output: [] },
					}),
				)
			},
		})
		const output = [
			{ type: "input_text", text: "Screenshot" },
			{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
		]
		await transport.request("responses", {
			method: "POST",
			body: JSON.stringify({
				model: "fixture",
				parallel_tool_calls: false,
				input: [
					{
						type: "function_call",
						id: "fc_ordinary",
						call_id: "call_ordinary",
						name: "view_image",
						arguments: "{}",
					},
					{ type: "function_call_output", call_id: "call_ordinary", output },
				],
			}),
		})
		const input = forwarded.input as Record<string, unknown>[]
		expect(input.at(-1)?.output).toEqual(
			lite
				? "Screenshot\n[Image omitted: Responses Lite tool outputs support text only.]"
				: output,
		)
		if (lite) expect(inputIssues(input)).toEqual([])
	})
})
