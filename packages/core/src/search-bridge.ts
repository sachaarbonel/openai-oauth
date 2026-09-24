import {
	CompletedResponseOutput,
	terminalResponseEvents,
} from "./responses-output.js"
import {
	readSearchResult,
	SEARCH_FUNCTION,
	SearchBridgeError,
	searchFunction,
	searchQueries,
	searchSettings,
	searchSources,
} from "./search-tool.js"
import { iterateServerSentEvents } from "./sse.js"
import { isRecord } from "./utils.js"

type Json = Record<string, unknown>
type Send = (
	path: "responses" | "alpha/search",
	body: Json,
	signal: AbortSignal,
) => Promise<Response>

class Usage {
	private values: Json[] = []
	missing = false
	complete(count: number) {
		return !this.missing && this.values.length === count
	}
	add(value: unknown) {
		if (
			!isRecord(value) ||
			![value.input_tokens, value.output_tokens, value.total_tokens].every(
				(v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
			) ||
			Number(value.total_tokens) !==
				Number(value.input_tokens) + Number(value.output_tokens)
		) {
			this.missing = true
			return
		}
		this.values.push(value)
	}
	sum() {
		const sum = (field: string) =>
			this.values.reduce((n, u) => n + Number(u[field]), 0)
		const details = (field: string, key: string) => {
			const values = this.values.map((u) =>
				isRecord(u[field]) ? u[field][key] : undefined,
			)
			return values.every(
				(n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
			)
				? { [key]: values.reduce<number>((n, v) => n + Number(v), 0) }
				: undefined
		}
		return {
			input_tokens: sum("input_tokens"),
			output_tokens: sum("output_tokens"),
			total_tokens: sum("total_tokens"),
			input_tokens_details: details("input_tokens_details", "cached_tokens"),
			output_tokens_details: details(
				"output_tokens_details",
				"reasoning_tokens",
			),
		}
	}
}

function prepare(body: Json) {
	const tools = Array.isArray(body.tools) ? body.tools : []
	const searches = tools.filter(
		(tool) => isRecord(tool) && tool.type === "web_search",
	)
	if (searches.length !== 1 || !isRecord(searches[0]))
		throw new SearchBridgeError(
			"unsupported_search_options",
			"Declare exactly one web search tool.",
		)
	const settings = searchSettings(searches[0])
	const choice = body.tool_choice
	const searchRequired =
		isRecord(choice) &&
		choice.type === "web_search" &&
		Object.keys(choice).length === 1
	if (
		choice !== undefined &&
		!["auto", "none", "required"].includes(String(choice)) &&
		!searchRequired
	)
		throw new SearchBridgeError(
			"unsupported_search_options",
			"This search bridge supports auto, none, required, or a web_search tool choice.",
		)
	if (body.background === true)
		throw new SearchBridgeError(
			"unsupported_search_options",
			"Background search is not supported by this bridge.",
		)
	const originalInput: unknown[] = Array.isArray(body.input)
		? structuredClone(body.input)
		: []
	const remaining = tools.filter(
		(tool) => !isRecord(tool) || tool.type !== "web_search",
	)
	const additional = originalInput.filter(
		(item) => isRecord(item) && item.type === "additional_tools",
	)
	const declared = [
		...remaining,
		...additional.flatMap((item) =>
			isRecord(item) && Array.isArray(item.tools) ? item.tools : [],
		),
	]
	if (
		declared.some(
			(tool) =>
				!isRecord(tool) ||
				!["function", "custom", "namespace"].includes(String(tool.type)),
		)
	)
		throw new SearchBridgeError(
			"unsupported_search_options",
			"Other hosted tools cannot be combined with standalone search.",
		)
	if (JSON.stringify(declared).includes(SEARCH_FUNCTION))
		throw new SearchBridgeError(
			"search_tool_collision",
			"The bridge's search function name is reserved.",
		)
	const input = originalInput
		.filter((item) => !isRecord(item) || item.type !== "additional_tools")
		.map((item) => {
			// Our synthetic public search item has no server-side replay state. Keep
			// its evidence as assistant history, not an unresolved hosted tool item.
			if (
				isRecord(item) &&
				item.type === "web_search_call" &&
				typeof item.id === "string" &&
				item.id.startsWith("ws_oauth_")
			)
				return {
					role: "assistant",
					content: [
						{
							type: "output_text",
							text: JSON.stringify({
								previous_search: item.action,
								status: item.status,
							}),
						},
					],
				}
			return item
		})
	if (choice !== "none")
		input.unshift({
			type: "additional_tools",
			role: "developer",
			tools: [...declared, searchFunction],
		})
	// Lite doesn't accept hosted tool_choice. Enforce the caller's requirement
	// on observed calls below; an instruction alone is not enforcement.
	if (searchRequired || choice === "required")
		input.push({
			role: "developer",
			content: [
				{
					type: "input_text",
					text: searchRequired
						? `Call ${SEARCH_FUNCTION} before answering.`
						: "Call a tool before answering.",
				},
			],
		})
	const modelBody: Json = { ...body, input }
	delete modelBody.tools
	delete modelBody.tool_choice
	// Source evidence comes from alpha/search, not the internal model request.
	if (Array.isArray(modelBody.include))
		modelBody.include = modelBody.include.filter(
			(field) => field !== "web_search_call.action.sources",
		)
	return {
		modelBody,
		settings,
		searchRequired,
		required: choice === "required",
		disabled: choice === "none",
	}
}

/** Opt-in Lite adapter: at most 3 model calls, 2 searches, 60 seconds; no retries.
 * The standalone wire contract follows Codex's SearchClient and SearchSettings.
 * Only query search is exposed initially; no arbitrary URL fetch or shell fallback.
 */
export async function standaloneSearchResponse(
	body: Json,
	send: Send,
	parent?: AbortSignal | null,
): Promise<Response> {
	let prepared: ReturnType<typeof prepare>
	try {
		prepared = prepare(body)
	} catch (error) {
		return Response.json(
			{
				error: {
					type: "invalid_request_error",
					code:
						error instanceof SearchBridgeError
							? error.code
							: "unsupported_search_options",
					param: "tools",
					message:
						error instanceof SearchBridgeError
							? error.message
							: "Invalid standalone search configuration.",
				},
			},
			{ status: 400 },
		)
	}
	const controller = new AbortController()
	const abort = () => controller.abort(parent?.reason)
	parent?.addEventListener("abort", abort, { once: true })
	if (parent?.aborted) abort()
	const timeout = setTimeout(
		() => controller.abort(new Error("Search bridge deadline exceeded.")),
		60_000,
	)
	const cleanup = () => {
		clearTimeout(timeout)
		parent?.removeEventListener("abort", abort)
	}
	const signal = controller.signal
	const fetch = async (path: "responses" | "alpha/search", request: Json) => {
		signal.throwIfAborted()
		const response = await send(path, request, signal)
		return response.body
			? new Response(
					response.body.pipeThrough(new TransformStream(), { signal }),
					{
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					},
				)
			: response
	}
	let first: Response
	try {
		first = await fetch("responses", prepared.modelBody)
	} catch (error) {
		cleanup()
		throw error
	}
	if (!first.ok) {
		cleanup()
		return first
	}
	const sessionId = crypto.randomUUID()
	const id = `resp_${sessionId.replaceAll("-", "")}`
	const output: Json[] = []
	const modelUsage = new Usage()
	const searchUsage = new Usage()
	let modelCalls = 1
	let searchCalls = 0
	let sequence = 0
	const executedCalls = new Set<string>()
	const base = {
		id,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		model: body.model,
	}
	const result = (status: string, error?: Json) => ({
		...base,
		status,
		output,
		error: error ?? null,
		// Standalone search has no documented usage field. Do not invent zero or
		// billable totals: report model usage and explicitly mark search accounting.
		usage: modelUsage.complete(modelCalls) ? modelUsage.sum() : null,
		openai_oauth: {
			execution: "standalone_search",
			model_requests: modelCalls,
			search_requests: searchCalls,
			usage_scope: "model_requests",
			search_usage:
				searchCalls && searchUsage.complete(searchCalls)
					? searchUsage.sum()
					: null,
			model_usage_complete: modelUsage.complete(modelCalls),
		},
	})
	const emit = (event: Json) =>
		new TextEncoder().encode(
			`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`,
		)
	async function* run(): AsyncGenerator<Uint8Array> {
		let activeSearch: Json | undefined
		try {
			yield emit({
				type: "response.created",
				response: { ...base, status: "in_progress", output: [] },
			})
			let response = first
			let externalCalls = 0
			while (true) {
				if (!response.ok || !response.body) {
					await response.body?.cancel()
					throw new SearchBridgeError(
						"search_model_error",
						`Search model returned HTTP ${response.status}.`,
					)
				}
				const collector = new CompletedResponseOutput()
				let terminal: Json | undefined
				const indexes = new Map<number, number>()
				const functions = new Map<number, Json[]>()
				const forward = (event: Json): Json | undefined => {
					if (typeof event.output_index !== "number") return event
					const index = event.output_index
					if (
						(isRecord(event.item) && event.item.type === "function_call") ||
						String(event.type).startsWith("response.function_call_arguments.")
					) {
						if (!functions.has(index)) functions.set(index, [])
					}
					if (functions.has(index)) {
						functions.get(index)?.push(event)
						return undefined
					}
					const mapped = indexes.get(index) ?? output.length
					indexes.set(index, mapped)
					if (isRecord(event.item)) output[mapped] = event.item
					return { ...event, output_index: mapped }
				}
				let bytes = 0
				const bounded = response.body.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, c) {
							bytes += chunk.byteLength
							if (bytes > 8 * 1024 * 1024)
								throw new SearchBridgeError(
									"search_model_size_limit",
									"Search model response exceeded the size limit.",
								)
							c.enqueue(chunk)
						},
					}),
					{ signal },
				)
				for await (const chunk of iterateServerSentEvents(bounded)) {
					if (!chunk.data || chunk.data === "[DONE]") continue
					const event: unknown = JSON.parse(chunk.data)
					if (!isRecord(event)) continue
					const value = collector.accept(String(event.type), event)
					if (event.type === "error")
						throw new SearchBridgeError(
							"search_model_error",
							"The search model stream failed.",
						)
					if (terminalResponseEvents.has(String(event.type))) {
						if (!isRecord(value.response)) throw new Error()
						terminal = value.response
						break
					}
					if (isRecord(event.response)) continue // Only one public response lifecycle.
					const mapped = forward(event)
					if (mapped) yield emit(mapped)
				}
				if (!terminal)
					throw new SearchBridgeError(
						"search_model_error",
						"Search model stream ended before completion.",
					)
				modelUsage.add(terminal.usage)
				if (!Array.isArray(terminal.output)) throw new Error()
				const calls: Json[] = []
				for (const [index, item] of terminal.output.entries()) {
					if (!isRecord(item)) throw new Error()
					if (item.type === "function_call" && item.name === SEARCH_FUNCTION) {
						calls.push(item)
						continue
					}
					if (item.type === "function_call" || item.type === "custom_tool_call")
						externalCalls++
					const buffered = functions.get(index)
					if (buffered) {
						functions.delete(index)
						for (const event of buffered) {
							// Bypass buffering now that the completed name is known.
							const mappedIndex = indexes.get(index) ?? output.length
							indexes.set(index, mappedIndex)
							if (isRecord(event.item)) output[mappedIndex] = event.item
							yield emit({ ...event, output_index: mappedIndex })
						}
					} else if (!indexes.has(index)) {
						indexes.set(index, output.length)
						output.push(item)
						yield emit({
							type: "response.output_item.added",
							output_index: output.length - 1,
							item,
						})
						yield emit({
							type: "response.output_item.done",
							output_index: output.length - 1,
							item,
						})
					}
				}
				if (terminal.status !== "completed")
					throw new SearchBridgeError(
						"search_model_error",
						"Search model did not complete successfully.",
					)
				if (!calls.length) {
					if (prepared.disabled && externalCalls)
						throw new SearchBridgeError(
							"unexpected_tool_call",
							"The model called a tool despite tool_choice none.",
						)
					if (
						(prepared.searchRequired && !searchCalls) ||
						(prepared.required && !searchCalls && !externalCalls)
					)
						throw new SearchBridgeError(
							"required_search_not_called",
							"The model did not perform the required tool call.",
						)
					yield emit({
						type: "response.completed",
						response: result("completed"),
					})
					return
				}
				if (prepared.disabled || externalCalls)
					throw new SearchBridgeError(
						"unsupported_search_sequence",
						"Search cannot be executed alongside an unresolved caller-owned tool call.",
					)
				if (modelCalls >= 3 || searchCalls + calls.length > 2)
					throw new SearchBridgeError(
						"search_budget_exceeded",
						"Standalone search reached its request limit.",
					)
				const replay = prepared.modelBody.input
				if (!Array.isArray(replay)) throw new Error()
				// Raw internal calls exist only in this bounded request's replay.
				replay.push(...terminal.output)
				for (const call of calls) {
					if (
						typeof call.call_id !== "string" ||
						!call.call_id ||
						(call.status !== undefined && call.status !== "completed") ||
						executedCalls.has(String(call.call_id))
					)
						throw new SearchBridgeError(
							"invalid_search_call",
							"Search call did not complete with an identifier.",
						)
					const queries = searchQueries(call.arguments)
					executedCalls.add(String(call.call_id))
					activeSearch = {
						type: "web_search_call",
						id: `ws_oauth_${crypto.randomUUID().replaceAll("-", "")}`,
						status: "in_progress",
						action: { type: "search", query: queries[0], queries },
					}
					const index = output.length
					output.push(activeSearch)
					yield emit({
						type: "response.output_item.added",
						output_index: index,
						item: activeSearch,
					})
					yield emit({
						type: "response.web_search_call.searching",
						output_index: index,
						item_id: activeSearch.id,
					})
					searchCalls++
					const found = await readSearchResult(
						await fetch("alpha/search", {
							id: sessionId,
							model: body.model,
							commands: {
								search_query: queries.map((q) => ({ q })),
								response_length: "short",
							},
							settings: prepared.settings,
							max_output_tokens: 4000,
						}),
					)
					searchUsage.add(found.usage)
					const sources = searchSources(found)
					activeSearch = {
						...activeSearch,
						status: "completed",
						action: {
							type: "search",
							query: queries[0],
							queries,
							...(Array.isArray(found.results) ? { sources } : {}),
						},
					}
					output[index] = activeSearch
					yield emit({
						type: "response.web_search_call.completed",
						output_index: index,
						item_id: activeSearch.id,
					})
					yield emit({
						type: "response.output_item.done",
						output_index: index,
						item: activeSearch,
					})
					activeSearch = undefined
					replay.push({
						type: "function_call_output",
						call_id: call.call_id,
						output: `${found.output}\n\nSource URLs: ${JSON.stringify(sources)}`,
					})
				}
				modelCalls++
				response = await fetch("responses", prepared.modelBody)
			}
		} catch (error) {
			if (activeSearch) {
				const index = output.findIndex((item) => item.id === activeSearch?.id)
				output[index] = { ...activeSearch, status: "failed" }
				yield emit({
					type: "response.output_item.done",
					output_index: index,
					item: output[index],
				})
			}
			yield emit({
				type: "response.failed",
				response: result("failed", {
					code: signal.aborted
						? "search_cancelled"
						: error instanceof SearchBridgeError
							? error.code
							: "search_bridge_error",
					message: signal.aborted
						? "Standalone search was cancelled or timed out."
						: error instanceof SearchBridgeError
							? error.message
							: "Standalone search could not complete.",
				}),
			})
		} finally {
			cleanup()
		}
	}
	const iterator = run()
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(c) {
				try {
					const next = await iterator.next()
					if (next.done) c.close()
					else c.enqueue(next.value)
				} catch (error) {
					cleanup()
					c.error(error)
				}
			},
			async cancel(reason) {
				controller.abort(reason)
				await iterator.return(undefined)
				cleanup()
			},
		}),
		{
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			},
		},
	)
}
