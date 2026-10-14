// Offline SDK fixture for the proxy's Responses Lite parallel-tool bridge.
// Dependencies stay in the isolated directory passed as the first argument.
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { createOpenAIOAuthFetchHandler } from "../packages/openai-oauth/dist/index.js"

if (!process.argv[2])
	throw new Error("Pass the isolated SDK dependency directory")
const fixtureRoot = resolve(process.argv[2])
const fixtureRequire = createRequire(join(fixtureRoot, "package.json"))
for (const [name, version] of Object.entries({
	"@openai/agents": "0.18.0",
	openai: "7.15.0",
	zod: "4.6.2",
})) {
	const installed = JSON.parse(
		await readFile(join(fixtureRoot, "node_modules", name, "package.json")),
	)
	assert.equal(installed.version, version)
}
globalThis.fetch = async () => {
	throw new Error("Offline fixture: external fetch is forbidden")
}
const { Agent, OpenAIProvider, Runner, setTracingDisabled, tool } =
	fixtureRequire("@openai/agents")
const { default: OpenAI } = fixtureRequire("openai")
const { z } = fixtureRequire("zod")
setTracingDisabled(true)

const encode = (event) =>
	`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const stream = (number, item) => {
	const response = {
		id: `resp_batch_${number}`,
		object: "response",
		created_at: 1,
		model: "gpt-6.1-sol",
		status: "in_progress",
		output: [],
	}
	const events = [
		{ type: "response.created", response },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: {
				...item,
				status: "in_progress",
				...(item.type === "function_call"
					? { arguments: "" }
					: { content: [] }),
			},
		},
	]
	if (item.type === "function_call") {
		events.push({
			type: "response.function_call_arguments.delta",
			output_index: 0,
			item_id: item.id,
			delta: item.arguments,
		})
		events.push({
			type: "response.function_call_arguments.done",
			output_index: 0,
			item_id: item.id,
			arguments: item.arguments,
		})
	} else {
		events.push({
			type: "response.output_text.delta",
			output_index: 0,
			item_id: item.id,
			content_index: 0,
			delta: item.content[0].text,
		})
	}
	events.push({ type: "response.output_item.done", output_index: 0, item })
	events.push({
		type: "response.completed",
		response: {
			...response,
			status: "completed",
			output: [],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		},
	})
	return new Response(
		events
			.map((event, sequence_number) => encode({ ...event, sequence_number }))
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	)
}

for (const useStream of [true, false])
	test(`Lite batch bridge exposes concurrent SDK calls (stream=${useStream})`, async () => {
		const root = await mkdtemp(join(tmpdir(), "openai-oauth-batch-fixture-"))
		try {
			const authFilePath = join(root, "auth.json")
			await writeFile(
				authFilePath,
				JSON.stringify({
					tokens: {
						access_token: "inert-fixture",
						account_id: "inert-fixture",
					},
				}),
				{ mode: 0o600 },
			)
			let requests = 0
			const downstream = []
			const seen = []
			let releaseBoth
			const bothStarted = new Promise((resolve) => {
				releaseBoth = resolve
			})
			const handler = createOpenAIOAuthFetchHandler({
				authFilePath,
				ensureFresh: false,
				codexVersion: "0.144.1",
				fetch: async (url, init) => {
					const path = new URL(String(url)).pathname
					if (path.endsWith("/models"))
						return Response.json({
							models: [{ slug: "gpt-6.1-sol", use_responses_lite: true }],
						})
					assert.equal(path, "/backend-api/codex/responses")
					assert.ok(++requests <= 2)
					const body = JSON.parse(init.body)
					assert.equal(body.parallel_tool_calls, false)
					if (requests === 1) {
						assert.equal(body.tools, undefined)
						assert.equal(body.input[0].type, "additional_tools")
						assert.equal(body.input[0].tools.length, 1)
						assert.equal(body.input[0].tools[0].name, "__openai_oauth_parallel")
						return stream(1, {
							type: "function_call",
							id: "fc_batch",
							call_id: "call_batch",
							name: "__openai_oauth_parallel",
							status: "completed",
							arguments: JSON.stringify({
								calls: [
									{ name: "read_palette", arguments: {} },
									{ name: "read_layout", arguments: {} },
								],
							}),
						})
					}
					const call = body.input.find(
						(item) =>
							item.type === "function_call" && item.call_id === "call_batch",
					)
					assert.equal(call.name, "__openai_oauth_parallel")
					assert.deepEqual(JSON.parse(call.arguments).calls, [
						{ name: "read_palette", arguments: {} },
						{ name: "read_layout", arguments: {} },
					])
					const result = body.input.find(
						(item) =>
							item.type === "function_call_output" &&
							item.call_id === "call_batch",
					)
					assert.deepEqual(JSON.parse(result.output).results, [
						{ name: "read_palette", output: "blue", status: "completed" },
						{ name: "read_layout", output: "grid", status: "completed" },
					])
					return stream(2, {
						type: "message",
						id: "msg_batch",
						role: "assistant",
						status: "completed",
						content: [
							{ type: "output_text", text: "Both checked", annotations: [] },
						],
					})
				},
			})
			const client = new OpenAI({
				apiKey: "inert-fixture",
				baseURL: "http://fixture.invalid/v1",
				maxRetries: 0,
				fetch: (url, init) => {
					downstream.push(JSON.parse(init.body))
					return handler(new Request(url, init))
				},
			})
			const agent = new Agent({
				name: "Batch fixture",
				model: "gpt-6.1-sol",
				modelSettings: { store: false, parallelToolCalls: true },
				tools: [
					tool({
						name: "read_palette",
						description: "Read fixture palette",
						parameters: z.object({}),
						execute: async () => {
							seen.push("palette")
							if (seen.length === 2) releaseBoth()
							await bothStarted
							return "blue"
						},
					}),
					tool({
						name: "read_layout",
						description: "Read fixture layout",
						parameters: z.object({}),
						execute: async () => {
							seen.push("layout")
							if (seen.length === 2) releaseBoth()
							await bothStarted
							return "grid"
						},
					}),
				],
			})
			const runner = new Runner({
				modelProvider: new OpenAIProvider({ openAIClient: client }),
				tracingDisabled: true,
			})
			const result = await runner.run(agent, "Check both fixture values", {
				stream: useStream,
				maxTurns: 2,
				signal: AbortSignal.timeout(5000),
			})
			if (useStream) {
				for await (const _event of result) {
					/* Consume the SDK stream. */
				}
				await result.completed
			}
			assert.equal(result.finalOutput, "Both checked")
			assert.deepEqual(seen, ["palette", "layout"])
			assert.equal(requests, 2)
			assert.equal(downstream.length, 2)
			assert.equal(downstream[0].parallel_tool_calls, true)
			assert.equal(downstream[1].parallel_tool_calls, true)
			assert.deepEqual(
				downstream[1].input
					.filter((item) => item.type === "function_call")
					.map((item) => item.name),
				["read_palette", "read_layout"],
			)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
