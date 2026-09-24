// Optional, entirely offline compatibility fixture. Dependencies stay outside this
// monorepo in the dependency directory passed as the first argument.
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { createOpenAIOAuthFetchHandler } from "../packages/openai-oauth/dist/index.js"

if (!process.argv[2])
	throw new Error(
		"Pass the directory containing the isolated SDK fixture dependencies.",
	)
const fixtureRoot = resolve(process.argv[2])
const fixtureRequire = createRequire(join(fixtureRoot, "package.json"))
for (const [name, version] of Object.entries({
	"@openai/agents": "0.18.0",
	openai: "7.15.0",
	zod: "4.6.2",
})) {
	const installed = JSON.parse(
		await readFile(
			join(fixtureRoot, "node_modules", name, "package.json"),
			"utf8",
		),
	)
	assert.equal(installed.version, version, `Use the pinned ${name} version`)
}

globalThis.fetch = async () => {
	throw new Error("Offline fixture: external fetch is forbidden")
}
const {
	Agent,
	OpenAIProvider,
	Runner,
	setTracingDisabled,
	tool,
	webSearchTool,
} = fixtureRequire("@openai/agents")
const { SandboxAgent, Manifest, shell, filesystem } = fixtureRequire(
	"@openai/agents/sandbox",
)
const { default: OpenAI } = fixtureRequire("openai")
const { z } = fixtureRequire("zod")
setTracingDisabled(true)

test(
	"Lite standalone search crosses the built proxy and Agents SDK once",
	{ timeout: 10000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "openai-oauth-search-fixture-"))
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
			let models = 0
			let searches = 0
			const finalText = "NASA source: https://science.nasa.gov/mission/webb/"
			const handler = createOpenAIOAuthFetchHandler({
				authFilePath,
				ensureFresh: false,
				standaloneSearch: true,
				codexVersion: "0.144.1",
				fetch: async (url, init) => {
					const pathname = new URL(String(url)).pathname
					if (pathname.endsWith("/models"))
						return Response.json({
							models: [{ slug: "gpt-6-astra", use_responses_lite: true }],
						})
					const body = JSON.parse(init.body)
					if (pathname.endsWith("/alpha/search")) {
						assert.equal(++searches, 1)
						assert.deepEqual(body.settings.filters, {
							allowed_domains: ["nasa.gov"],
						})
						return Response.json({
							output: "NASA evidence",
							results: [
								{
									type: "text_result",
									url: "https://science.nasa.gov/mission/webb/",
									title: "Webb",
								},
							],
						})
					}
					assert.equal(pathname, "/backend-api/codex/responses")
					assert.ok(++models <= 2)
					assert.equal(body.tools, undefined)
					const definition = body.input
						.flatMap((item) =>
							item.type === "additional_tools" ? item.tools : [],
						)
						.find((item) => item.name === "__openai_oauth_web_search")
					assert.ok(definition)
					if (models === 2)
						assert.ok(
							body.input.some(
								(item) =>
									item.type === "function_call_output" &&
									item.output.includes("NASA evidence"),
							),
						)
					const item =
						models === 1
							? {
									type: "function_call",
									id: "fc_search",
									call_id: "call_search",
									name: definition.name,
									status: "completed",
									arguments: JSON.stringify({ queries: ["NASA Webb"] }),
								}
							: {
									type: "message",
									id: "msg_search_answer",
									role: "assistant",
									status: "completed",
									content: [
										{ type: "output_text", text: finalText, annotations: [] },
									],
								}
					const response = {
						id: `resp_search_${models}`,
						object: "response",
						created_at: 1,
						model: "gpt-6-astra",
						status: "in_progress",
						output: [],
					}
					const events = [
						{ type: "response.created", response },
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { ...item, status: "in_progress" },
						},
					]
					if (models === 2)
						events.push({
							type: "response.output_text.delta",
							item_id: item.id,
							output_index: 0,
							content_index: 0,
							delta: finalText,
						})
					events.push({
						type: "response.output_item.done",
						output_index: 0,
						item,
					})
					events.push({
						type: "response.completed",
						response: {
							...response,
							status: "completed",
							output: [],
							usage: {
								input_tokens: 10,
								output_tokens: 5,
								total_tokens: 15,
								input_tokens_details: { cached_tokens: 0 },
								output_tokens_details: { reasoning_tokens: 0 },
							},
						},
					})
					return new Response(events.map(encodeEvent).join(""), {
						headers: { "content-type": "text/event-stream" },
					})
				},
			})
			const client = new OpenAI({
				apiKey: "inert-fixture",
				baseURL: "http://fixture.invalid/v1",
				maxRetries: 0,
				fetch: (url, init) => handler(new Request(url, init)),
			})
			const runner = new Runner({
				modelProvider: new OpenAIProvider({ openAIClient: client }),
				tracingDisabled: true,
			})
			const agent = new Agent({
				name: "Search fixture",
				model: "gpt-6-astra",
				tools: [webSearchTool({ filters: { allowedDomains: ["nasa.gov"] } })],
				modelSettings: {
					store: false,
					toolChoice: "required",
					providerData: { include: ["web_search_call.action.sources"] },
				},
			})
			const stream = await runner.run(agent, "Search NASA once", {
				stream: true,
				maxTurns: 1,
			})
			let observedSearch = false
			for await (const event of stream) {
				if (
					event.type === "raw_model_stream_event" &&
					event.data.type === "model" &&
					event.data.event.type === "response.output_item.done" &&
					event.data.event.item.type === "web_search_call"
				) {
					observedSearch = true
					assert.equal(event.data.event.item.status, "completed")
					assert.equal(
						event.data.event.item.action.sources[0].url,
						"https://science.nasa.gov/mission/webb/",
					)
				}
			}
			await stream.completed
			assert.equal(stream.finalOutput, finalText)
			assert.equal(stream.state.usage.totalTokens, 30)
			assert.equal(observedSearch, true)
			assert.equal(models, 2)
			assert.equal(searches, 1)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)

const model = "gpt-6-astra"
const label = "café 🐈"
const command = "inert-fixture-command" // The stub below never launches a shell.
const encodeEvent = (event) =>
	`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const message = (text, phase) => ({
	type: "message",
	id: `msg_${phase}`,
	role: "assistant",
	status: "completed",
	phase,
	content: [{ type: "output_text", text, annotations: [] }],
})

const responseStream = (ordinal, native, nullableOptions) => {
	const call = {
		type: "function_call",
		id: "fc_fixture",
		call_id: "call_fixture",
		status: "completed",
		name: native ? "exec_command" : "read_fixture",
		arguments: JSON.stringify(
			native
				? {
						cmd: command,
						login: false,
						...(nullableOptions
							? {
									workdir: null,
									shell: null,
									tty: false,
									yield_time_ms: 1000,
									max_output_tokens: null,
								}
							: {}),
					}
				: { label },
		),
	}
	const items =
		ordinal === 1
			? [message("Reading fixture.", "commentary"), call]
			: [message(`fixture:${label}`, "final_answer")]
	const response = {
		id: `resp_${ordinal}`,
		object: "response",
		created_at: 1,
		model,
		status: "in_progress",
		output: [],
	}
	const events = [{ type: "response.created", response }]
	for (const [output_index, item] of items.entries()) {
		events.push({
			type: "response.output_item.added",
			output_index,
			item: {
				...item,
				status: "in_progress",
				...(item.type === "function_call"
					? { arguments: "" }
					: { content: [] }),
			},
		})
		if (item.type === "function_call") {
			events.push({
				type: "response.function_call_arguments.delta",
				output_index,
				item_id: item.id,
				delta: item.arguments,
			})
			events.push({
				type: "response.function_call_arguments.done",
				output_index,
				item_id: item.id,
				arguments: item.arguments,
			})
		} else {
			events.push({
				type: "response.output_text.delta",
				output_index,
				item_id: item.id,
				content_index: 0,
				delta: item.content[0].text,
				logprobs: [],
			})
		}
		events.push({ type: "response.output_item.done", output_index, item })
	}
	// This is the mismatch observed downstream: real done items, empty final output.
	events.push({
		type: "response.completed",
		response: {
			...response,
			status: "completed",
			output: [],
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
		},
	})
	const bytes = new TextEncoder().encode(
		events
			.map((event, sequence_number) =>
				encodeEvent({ ...event, sequence_number }),
			)
			.join(""),
	)
	let offset = 0
	return new Response(
		new ReadableStream({
			pull(controller) {
				if (offset === bytes.length) return controller.close()
				controller.enqueue(bytes.slice(offset, offset + 13))
				offset = Math.min(offset + 13, bytes.length)
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	)
}

for (const { native, nullableOptions } of [
	{ native: false, nullableOptions: false },
	{ native: true, nullableOptions: false },
	{ native: true, nullableOptions: true },
]) {
	test(
		`${native ? "SandboxAgent exec_command" : "Agent function tool"}${nullableOptions ? " with nullable options" : ""}: completed items survive the HTTP handler and execute once`,
		{ timeout: 10000 },
		async () => {
			const root = await mkdtemp(join(tmpdir(), "openai-oauth-sdk-fixture-"))
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
				let calls = 0
				let requests = 0
				const handler = createOpenAIOAuthFetchHandler({
					authFilePath,
					ensureFresh: false,
					codexVersion: "0.144.1",
					models: [model],
					fetch: async (url, init) => {
						const pathname = new URL(String(url)).pathname
						if (pathname === "/backend-api/codex/models")
							return Response.json({ models: [{ slug: model }] })
						assert.equal(pathname, "/backend-api/codex/responses")
						assert.ok(
							++requests <= 2,
							"No retries or additional model requests",
						)
						const body = JSON.parse(init.body)
						assert.equal(body.model, model)
						assert.equal(body.stream, true)
						assert.equal(body.store, false)
						assert.equal(body.service_tier, undefined)
						assert.equal(body.previous_response_id, undefined)
						if (requests === 2) {
							assert.equal(
								calls,
								1,
								"A completed function call must execute before requesting another response",
							)
							const call = body.input.find(
								(item) => item.type === "function_call",
							)
							assert.equal(call?.call_id, "call_fixture")
							if (nullableOptions) {
								// Wire nulls remain intact. Only the SDK tool's schema-aware
								// parser may translate optional nulls to omitted values.
								const args = JSON.parse(call.arguments)
								assert.equal(args.workdir, null)
								assert.equal(args.shell, null)
								assert.equal(args.max_output_tokens, null)
							}
							const result = body.input.find(
								(item) => item.type === "function_call_output",
							)
							assert.equal(result?.call_id, "call_fixture")
							assert.match(JSON.stringify(result.output), /fixture:café/)
						}
						return responseStream(requests, native, nullableOptions)
					},
				})
				const client = new OpenAI({
					apiKey: "inert-fixture",
					baseURL: "http://fixture.invalid/v1",
					maxRetries: 0,
					fetch: async (url, init) => {
						assert.equal(String(url), "http://fixture.invalid/v1/responses")
						const headers = new Headers(init.headers)
						headers.delete("authorization")
						return handler(new Request(url, { ...init, headers }))
					},
				})
				const config = {
					name: "Offline fixture",
					model,
					instructions: "Use the fixture once and return its result.",
					modelSettings: { store: false },
				}
				const agent = native
					? new SandboxAgent({
							...config,
							capabilities: [shell(), filesystem()],
						})
					: new Agent({
							...config,
							tools: [
								tool({
									name: "read_fixture",
									description: "Read an inert fixture",
									parameters: z.object({ label: z.string() }),
									execute: async (args) => {
										assert.deepEqual(args, { label })
										assert.equal(++calls, 1)
										return `fixture:${args.label}`
									},
								}),
							],
						})
				const session = {
					state: { manifest: new Manifest(), workspaceReady: true },
					supportsPty: () => false,
					execCommand: async (args) => {
						assert.equal(args.cmd, command)
						if (nullableOptions) {
							assert.equal(args.workdir, undefined)
							assert.equal(args.shell, undefined)
							assert.equal(args.maxOutputTokens, undefined)
						}
						assert.equal(++calls, 1)
						return `fixture:${label}`
					},
					createEditor: () => ({
						createFile: async () => {
							throw new Error("File writes forbidden in this fixture")
						},
						updateFile: async () => {
							throw new Error("File writes forbidden in this fixture")
						},
						deleteFile: async () => {
							throw new Error("File writes forbidden in this fixture")
						},
					}),
				}
				const runner = new Runner({
					modelProvider: new OpenAIProvider({ openAIClient: client }),
					tracingDisabled: true,
				})
				const result = await runner.run(agent, "Read the fixture.", {
					stream: true,
					maxTurns: 2,
					signal: AbortSignal.timeout(5000),
					...(native ? { sandbox: { session } } : {}),
				})
				const textDeltas = []
				let nullableCallEvents = 0
				for await (const event of result) {
					if (
						nullableOptions &&
						event.type === "run_item_stream_event" &&
						event.name === "tool_called"
					) {
						const args = JSON.parse(event.item.rawItem.arguments)
						assert.equal(args.workdir, null)
						assert.equal(args.shell, null)
						nullableCallEvents++
					}
					if (
						event.type === "raw_model_stream_event" &&
						event.data.type === "output_text_delta"
					)
						textDeltas.push(event.data.delta)
				}
				await result.completed
				assert.equal(calls, 1)
				assert.equal(requests, 2)
				assert.equal(result.finalOutput, `fixture:${label}`)
				assert.equal(nullableCallEvents, nullableOptions ? 1 : 0)
				assert.ok(
					textDeltas.includes("Reading fixture."),
					"Text remains streamed",
				)
			} finally {
				await rm(root, { recursive: true, force: true })
			}
		},
	)
}
