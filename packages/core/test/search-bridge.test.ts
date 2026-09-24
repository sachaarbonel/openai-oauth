import { describe, expect, test, vi } from "vitest"
import { createOpenAIOAuthTransport } from "../src/runtime.js"
import { SEARCH_FUNCTION } from "../src/search-tool.js"
import { iterateServerSentEvents } from "../src/sse.js"

type Json = Record<string, unknown>
const model = "gpt-6-astra"
const usage = {
	input_tokens: 10,
	output_tokens: 5,
	total_tokens: 15,
	input_tokens_details: { cached_tokens: 4 },
	output_tokens_details: { reasoning_tokens: 2 },
}
const call = (
	ordinal = 1,
	args = JSON.stringify({ queries: ["NASA Webb overview"] }),
) => ({
	type: "function_call",
	name: SEARCH_FUNCTION,
	id: `fc_${ordinal}`,
	call_id: `call_${ordinal}`,
	status: "completed",
	arguments: args,
})
const message = (ordinal = 1) => ({
	type: "message",
	id: `msg_${ordinal}`,
	role: "assistant",
	status: "completed",
	content: [
		{
			type: "output_text",
			text: "NASA: https://science.nasa.gov/mission/webb/",
			annotations: [],
		},
	],
})
function sse(
	items: Json[],
	ordinal = 1,
	options: {
		status?: string
		missingUsage?: boolean
		emptyOutput?: boolean
		terminalOnly?: boolean
		doneOnly?: boolean
	} = {},
) {
	const response = {
		id: `resp_${ordinal}`,
		model,
		object: "response",
		created_at: 1,
		output: [],
		status: "in_progress",
	}
	const events: Json[] = [{ type: "response.created", response }]
	if (!options.terminalOnly)
		for (const [output_index, item] of items.entries()) {
			events.push({
				type: "response.output_item.added",
				output_index,
				item: { ...item, status: "in_progress" },
			})
			if (item.type === "function_call")
				events.push({
					type: "response.function_call_arguments.delta",
					item_id: item.id,
					output_index,
					delta: item.arguments,
				})
			else
				events.push({
					type: "response.output_text.delta",
					item_id: item.id,
					output_index,
					content_index: 0,
					delta: "NASA",
				})
			events.push({ type: "response.output_item.done", output_index, item })
		}
	events.push({
		type: `response.${options.status ?? "completed"}`,
		response: {
			...response,
			status: options.status ?? "completed",
			output: options.emptyOutput ? [] : items,
			...(!options.missingUsage ? { usage } : {}),
		},
	})
	return new Response(
		events
			.filter(
				(event) =>
					!options.doneOnly || event.type !== "response.output_item.added",
			)
			.map(
				(event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	)
}

function fixture(
	options: {
		model?: (
			n: number,
			body: Json,
			signal?: AbortSignal | null,
		) => Response | Promise<Response>
		search?: (
			body: Json,
			signal?: AbortSignal | null,
		) => Response | Promise<Response>
		enabled?: boolean
		lite?: boolean
	} = {},
) {
	const requests: {
		path: string
		body: Json
		headers: Headers
		signal?: AbortSignal | null
	}[] = []
	let models = 0
	const client = createOpenAIOAuthTransport({
		auth: { accessToken: "inert-access", accountId: "inert-account" },
		codexVersion: "0.144.1",
		standaloneSearch: options.enabled ?? true,
		responsesState: false,
		fetch: vi.fn(async (url, init) => {
			const path = new URL(String(url)).pathname
			if (path.endsWith("/models"))
				return Response.json({
					models: [{ slug: model, use_responses_lite: options.lite ?? true }],
				})
			const body = JSON.parse(String(init?.body))
			requests.push({
				path,
				body,
				headers: new Headers(init?.headers),
				signal: init?.signal,
			})
			if (path.endsWith("/responses"))
				return options.model
					? options.model(++models, body, init?.signal)
					: sse(++models === 1 ? [call()] : [message(2)], models)
			expect(path).toBe("/backend-api/codex/alpha/search")
			return options.search
				? options.search(body, init?.signal)
				: Response.json({
						output: "NASA source text",
						encrypted_output: "PRIVATE_ENCRYPTED",
						results: [
							{
								type: "text_result",
								ref_id: "turn0search0",
								title: "Webb",
								url: "https://science.nasa.gov/mission/webb/",
							},
						],
					})
		}),
	})
	const request = (overrides: Json = {}, signal?: AbortSignal) =>
		client.request("/responses", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer caller-must-not-reach-upstream",
			},
			signal,
			body: JSON.stringify({
				model,
				stream: true,
				store: false,
				tools: [
					{
						type: "web_search",
						filters: { allowed_domains: ["nasa.gov"] },
						external_web_access: false,
					},
				],
				input: "Search NASA.",
				tool_choice: "required",
				...overrides,
			}),
		})
	return { request, requests }
}

async function collect(response: Response) {
	const events = []
	if (!response.body) throw new Error("Missing SSE")
	for await (const event of iterateServerSentEvents(response.body))
		events.push(JSON.parse(event.data ?? "{}"))
	return { events, result: events.at(-1)?.response }
}

describe("opt-in standalone search bridge", () => {
	test("done-only function events never leak the internal function to clients", async () => {
		const f = fixture({
			model: (n) =>
				sse(n === 1 ? [call()] : [message()], n, {
					doneOnly: true,
					emptyOutput: true,
				}),
		})
		const { result, events } = await collect(await f.request())
		expect(result.status).toBe("completed")
		expect(result.output.map((item: Json) => item.type)).toEqual([
			"web_search_call",
			"message",
		])
		expect(JSON.stringify(events)).not.toContain(SEARCH_FUNCTION)
	})
	test("preserves bridge search evidence when the caller replays conversation history", async () => {
		const f = fixture({ model: () => sse([message()]) })
		await collect(
			await f.request({
				tool_choice: "auto",
				input: [
					{
						id: "ws_oauth_previous",
						type: "web_search_call",
						status: "completed",
						action: {
							type: "search",
							query: "previous query",
							sources: [{ type: "url", url: "https://nasa.gov" }],
						},
					},
				],
			}),
		)
		expect(JSON.stringify(f.requests[0].body.input)).not.toContain(
			'"type":"web_search_call"',
		)
		expect(JSON.stringify(f.requests[0].body.input)).toContain("previous query")
		expect(JSON.stringify(f.requests[0].body.input)).toContain(
			"https://nasa.gov",
		)
	})

	test("cancelling the returned stream aborts the in-flight model request", async () => {
		let active: AbortSignal | null | undefined
		const f = fixture({
			model: (_n, _body, signal) => {
				active = signal
				return new Response(new ReadableStream(), {
					headers: { "content-type": "text/event-stream" },
				})
			},
		})
		const response = await f.request()
		await response.body?.cancel()
		await vi.waitFor(() => expect(active?.aborted).toBe(true), {
			timeout: 1000,
			interval: 5,
		})
		expect(f.requests).toHaveLength(1)
	})

	test("a stalled search is aborted at the bridge deadline", async () => {
		vi.useFakeTimers()
		try {
			let active: AbortSignal | null | undefined
			const f = fixture({
				search: (_body, signal) => {
					active = signal
					return new Response(new ReadableStream())
				},
			})
			const done = collect(await f.request())
			await vi.waitFor(() => expect(f.requests).toHaveLength(2))
			await vi.advanceTimersByTimeAsync(60_000)
			expect((await done).result.error.code).toBe("search_cancelled")
			expect(active?.aborted).toBe(true)
			expect(f.requests).toHaveLength(2)
		} finally {
			vi.useRealTimers()
		}
	})

	test("a continuation HTTP failure does not misreport partial usage as complete", async () => {
		const f = fixture({
			model: (n) =>
				n === 1
					? sse([call()])
					: Response.json({ error: "PRIVATE" }, { status: 400 }),
		})
		const { result } = await collect(await f.request())
		expect(result.status).toBe("failed")
		expect(result.usage).toBeNull()
		expect(result.openai_oauth.model_usage_complete).toBe(false)
		expect(f.requests).toHaveLength(3)
	})

	test("repeated internal call IDs do not execute another search", async () => {
		const f = fixture({ model: (n) => sse([call()], n) })
		const { result } = await collect(await f.request())
		expect(result.error.code).toBe("invalid_search_call")
		expect(f.requests.filter((r) => r.path.endsWith("/search"))).toHaveLength(1)
	})

	test("terminal-only tool calls are executed without requiring fabricated deltas", async () => {
		const f = fixture({
			model: (n) =>
				sse(n === 1 ? [call()] : [message()], n, { terminalOnly: true }),
		})
		expect((await collect(await f.request())).result.status).toBe("completed")
		expect(f.requests).toHaveLength(3)
	})
	test("executes search, replays its actual result, emits evidence, and sums both model calls", async () => {
		const f = fixture()
		const { events, result } = await collect(await f.request())
		expect(f.requests.map((r) => r.path.split("/").at(-1))).toEqual([
			"responses",
			"search",
			"responses",
		])
		for (const request of f.requests) {
			expect(request.headers.get("authorization")).toBe("Bearer inert-access")
			expect(request.headers.get("chatgpt-account-id")).toBe("inert-account")
		}
		expect(f.requests[0].body.tools).toBeUndefined()
		expect(f.requests[0].body.tool_choice).toBeUndefined()
		expect(f.requests[1].body.id).toMatch(/^[a-f0-9-]{36}$/)
		expect(JSON.stringify(f.requests[0].body.input)).toContain(SEARCH_FUNCTION)
		expect(
			f.requests[1].headers.has("x-openai-internal-codex-responses-lite"),
		).toBe(false)
		expect(f.requests[1].body).toMatchObject({
			model,
			commands: { search_query: [{ q: "NASA Webb overview" }] },
			settings: {
				filters: { allowed_domains: ["nasa.gov"] },
				external_web_access: false,
				allowed_callers: ["direct"],
			},
		})
		expect(JSON.stringify(f.requests[2].body.input)).toContain(
			"NASA source text",
		)
		expect(result.status).toBe("completed")
		expect(result.output.map((item: Json) => item.type)).toEqual([
			"web_search_call",
			"message",
		])
		expect(result.output[0].action.sources).toEqual([
			{
				type: "url",
				url: "https://science.nasa.gov/mission/webb/",
				title: "Webb",
			},
		])
		expect(result.usage).toEqual({
			input_tokens: 20,
			output_tokens: 10,
			total_tokens: 30,
			input_tokens_details: { cached_tokens: 8 },
			output_tokens_details: { reasoning_tokens: 4 },
		})
		expect(result.openai_oauth).toMatchObject({
			model_requests: 2,
			search_requests: 1,
			usage_scope: "model_requests",
			search_usage: null,
		})
		expect(
			events.filter((event) => event.type === "response.created"),
		).toHaveLength(1)
		expect(
			events.filter((event) => event.type === "response.completed"),
		).toHaveLength(1)
		expect(
			events.some((event) => event.type === "response.output_text.delta"),
		).toBe(true)
		expect(events.map((event) => event.sequence_number)).toEqual(
			events.map((_, index) => index),
		)
		expect(JSON.stringify(events)).not.toMatch(
			/PRIVATE_ENCRYPTED|__openai_oauth_web_search|function_call_arguments/,
		)
	})

	test("works with non-streaming callers and empty terminal output repair", async () => {
		const f = fixture({
			model: (n) =>
				sse(n === 1 ? [call()] : [message(2)], n, { emptyOutput: true }),
		})
		const response = await f.request({ stream: false })
		expect(response.headers.get("content-type")).toBe("application/json")
		expect(
			(await response.json()).output.map((item: Json) => item.type),
		).toEqual(["web_search_call", "message"])
	})

	test.each([
		"auto",
		"none",
	])("does not force optional or disabled search (%s)", async (tool_choice) => {
		const f = fixture({ model: () => sse([message()]) })
		expect(
			(await collect(await f.request({ tool_choice }))).result.status,
		).toBe("completed")
		expect(f.requests).toHaveLength(1)
	})

	test("fails rather than pretending required search ran", async () => {
		const f = fixture({ model: () => sse([message()]) })
		const { result } = await collect(
			await f.request({ tool_choice: { type: "web_search" } }),
		)
		expect(result.error.code).toBe("required_search_not_called")
		expect(result.status).toBe("failed")
		expect(f.requests).toHaveLength(1)
	})

	test.each([
		400, 403, 429, 500,
	])("does not retry standalone HTTP %s or continue the model", async (status) => {
		const f = fixture({
			search: () =>
				Response.json({ error: { message: "PRIVATE" } }, { status }),
		})
		const { result } = await collect(await f.request())
		expect(result.status).toBe("failed")
		expect(result.output[0].status).toBe("failed")
		expect(result.error.code).toBe("search_upstream_error")
		expect(f.requests).toHaveLength(2)
		expect(JSON.stringify(result)).not.toContain("PRIVATE")
	})

	test("enforces a two-search / three-model ceiling", async () => {
		const f = fixture({ model: (n) => sse([call(n)], n) })
		const { result } = await collect(await f.request())
		expect(result.error.code).toBe("search_budget_exceeded")
		expect(result.openai_oauth).toMatchObject({
			model_requests: 3,
			search_requests: 2,
		})
		expect(f.requests).toHaveLength(5)
	})

	test.each([
		{ tools: [{ type: "web_search", return_token_budget: "unlimited" }] },
		{
			tools: [
				{
					type: "web_search",
					filters: { allowed_domains: ["https://nasa.gov"] },
				},
			],
		},
		{ tools: [{ type: "web_search", search_content_types: ["image"] }] },
		{ tools: [{ type: "web_search" }, { type: "mcp" }] },
		{
			tools: [
				{ type: "web_search" },
				{ type: "function", name: SEARCH_FUNCTION },
			],
		},
		{ tool_choice: { type: "function", name: "read" } },
		{ background: true },
	])("rejects unsupported options before a model request: %j", async (options) => {
		const f = fixture()
		const response = await f.request(options)
		expect(response.status).toBe(400)
		expect(f.requests).toHaveLength(0)
	})

	test("never executes model-supplied settings or arbitrary operations", async () => {
		const f = fixture({
			model: () =>
				sse([
					call(
						1,
						JSON.stringify({ queries: ["hello"], settings: { filters: {} } }),
					),
				]),
		})
		const { result } = await collect(await f.request())
		expect(result.status).toBe("failed")
		expect(f.requests).toHaveLength(1)
	})

	test("passes caller-owned function calls back without executing them", async () => {
		const f = fixture({ model: () => sse([{ ...call(), name: "read_file" }]) })
		const { result } = await collect(
			await f.request({
				tools: [
					{ type: "web_search" },
					{ type: "function", name: "read_file" },
				],
			}),
		)
		expect(result.status).toBe("completed")
		expect(result.output[0].name).toBe("read_file")
		expect(f.requests).toHaveLength(1)
	})

	test("does not bridge other models or opt-out requests", async () => {
		for (const options of [{ enabled: false }, { lite: false }]) {
			const f = fixture({ ...options, model: () => sse([message()]) })
			await collect(await f.request())
			expect(f.requests[0].body.tools).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "web_search" }),
				]),
			)
			expect(f.requests).toHaveLength(1)
		}
	})

	test("propagates cancellation while waiting for search; no follow-up model call", async () => {
		const abort = new AbortController()
		let searchSignal: AbortSignal | null | undefined
		const f = fixture({
			search: (_body, signal) => {
				searchSignal = signal
				abort.abort()
				return new Response(new ReadableStream())
			},
		})
		const { result } = await collect(await f.request({}, abort.signal))
		expect(searchSignal?.aborted).toBe(true)
		expect(result.error.code).toBe("search_cancelled")
		expect(f.requests).toHaveLength(2)
	})

	test("missing model usage is unknown, not a zero total", async () => {
		const f = fixture({
			model: (n) =>
				sse(n === 1 ? [call()] : [message(2)], n, { missingUsage: n === 2 }),
		})
		const { result } = await collect(await f.request())
		expect(result.usage).toBeNull()
		expect(result.openai_oauth.model_usage_complete).toBe(false)
	})

	test("only structured HTTP(S) sources become evidence", async () => {
		const f = fixture({
			search: () =>
				Response.json({
					output: "Prose https://invented.invalid is not source evidence",
					results: [
						{ url: "javascript:alert(1)" },
						{ url: "https://secret:token@example.com" },
						{ url: "https://nasa.gov", title: "NASA" },
					],
				}),
		})
		const { result } = await collect(await f.request())
		expect(result.output[0].action.sources).toEqual([
			{ type: "url", url: "https://nasa.gov", title: "NASA" },
		])
	})
})
