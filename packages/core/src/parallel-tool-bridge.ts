import { isRecord } from "./utils.js"

export const PARALLEL_TOOL_FUNCTION = "__openai_oauth_parallel"
// Catalog size and simultaneous calls are separate resource limits.
const MAX_TOOL_DEFINITIONS = 128
const MAX_BATCH_CALLS = 16
const MAX_BATCH_DESCRIPTION = 64 * 1024
const MAX_PENDING_EVENT_CHARACTERS = 32 * 1024 * 1024
const childPrefix = "__openai_oauth_batch_"

export class ParallelToolBridgeError extends Error {}

const encodeId = (value: string): string => {
	const bytes = new TextEncoder().encode(value)
	if (bytes.length > 512)
		throw new ParallelToolBridgeError("Parallel tool ID exceeds the limit.")
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const decodeId = (value: string): string | undefined => {
	if (value.length > 1024) return
	try {
		const bytes = Uint8Array.from(
			atob(value.replace(/-/g, "+").replace(/_/g, "/")),
			(character) => character.charCodeAt(0),
		)
		if (bytes.length === 0 || bytes.length > 512) return
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
	} catch {}
}

const childId = (
	parent: string,
	index: number,
	total: number,
	parentId?: string,
): string =>
	`${childPrefix}${encodeId(parentId ? JSON.stringify([parent, parentId]) : parent)}_${index}_${total}`

const parseChildId = (value: unknown) => {
	if (typeof value !== "string" || !value.startsWith(childPrefix)) return
	const match = /^__openai_oauth_batch_([A-Za-z0-9_-]+)_(\d+)_(\d+)$/.exec(
		value,
	)
	if (!match) return
	const index = Number(match[2])
	const total = Number(match[3])
	if (
		!Number.isSafeInteger(index) ||
		!Number.isSafeInteger(total) ||
		total < 1 ||
		total > MAX_BATCH_CALLS ||
		index >= total
	)
		return
	const encoded = match[1]
	if (!encoded) return
	const decoded = decodeId(encoded)
	if (decoded === undefined) return
	let parent = decoded
	let parentId: string | undefined
	// New call IDs retain BOTH upstream IDs even if an SDK drops every item ID.
	// Keep decoding the original single-ID format for histories already in use.
	if (decoded.startsWith("[")) {
		try {
			const pair: unknown = JSON.parse(decoded)
			if (
				!Array.isArray(pair) ||
				pair.length !== 2 ||
				typeof pair[0] !== "string" ||
				!pair[0] ||
				typeof pair[1] !== "string" ||
				!pair[1]
			)
				return
			parent = pair[0]
			parentId = pair[1]
		} catch {
			return
		}
	}
	if (childId(parent, index, total, parentId) !== value) return
	return { parent, parentId, index, total }
}

export const parallelToolDefinition = (tools: Record<string, unknown>[]) => {
	if (tools.length === 0 || tools.length > MAX_TOOL_DEFINITIONS)
		throw new ParallelToolBridgeError(
			"Parallel tool catalog must contain between 1 and 128 definitions.",
		)
	const names = tools.map((tool) => tool.name)
	if (
		names.some(
			(name) =>
				typeof name !== "string" || !name || name === PARALLEL_TOOL_FUNCTION,
		) ||
		new Set(names).size !== names.length
	)
		throw new ParallelToolBridgeError(
			"Parallel tool names must be unique and cannot use the reserved batch name.",
		)
	const catalog = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}))
	const description = `Call one or more independent tools. Each calls[].arguments object must match that tool's parameters. The proxy forwards each call to the client separately. Available tools: ${JSON.stringify(catalog)}`
	if (description.length > MAX_BATCH_DESCRIPTION)
		throw new ParallelToolBridgeError(
			"Parallel tool definitions exceed the description limit.",
		)
	return {
		type: "function",
		name: PARALLEL_TOOL_FUNCTION,
		description,
		strict: false,
		parameters: {
			type: "object",
			properties: {
				calls: {
					type: "array",
					minItems: 1,
					maxItems: MAX_BATCH_CALLS,
					items: {
						type: "object",
						properties: {
							name: { type: "string", enum: names },
							arguments: { type: "object" },
						},
						required: ["name", "arguments"],
						additionalProperties: false,
					},
				},
			},
			required: ["calls"],
			additionalProperties: false,
		},
	}
}

type BatchCall = { name: string; arguments: string }

const parseBatchCalls = (
	item: Record<string, unknown>,
	names: Set<string>,
): BatchCall[] => {
	if (
		typeof item.arguments !== "string" ||
		typeof item.call_id !== "string" ||
		!item.call_id ||
		typeof item.id !== "string" ||
		!item.id
	)
		throw new ParallelToolBridgeError("Incomplete parallel tool call.")
	let parsed: unknown
	try {
		parsed = JSON.parse(item.arguments)
	} catch {
		throw new ParallelToolBridgeError("Invalid parallel tool arguments.")
	}
	const calls = isRecord(parsed) ? parsed.calls : undefined
	if (
		!Array.isArray(calls) ||
		calls.length < 1 ||
		calls.length > MAX_BATCH_CALLS
	)
		throw new ParallelToolBridgeError("Invalid parallel tool call count.")
	return calls.map((call) => {
		if (
			!isRecord(call) ||
			typeof call.name !== "string" ||
			!names.has(call.name) ||
			(!isRecord(call.arguments) && typeof call.arguments !== "string")
		)
			throw new ParallelToolBridgeError(
				"Invalid parallel tool name or arguments.",
			)
		const argumentsText = isRecord(call.arguments)
			? JSON.stringify(call.arguments)
			: (call.arguments as string)
		try {
			const value = JSON.parse(argumentsText)
			if (!isRecord(value)) throw new Error("Expected object")
		} catch {
			throw new ParallelToolBridgeError("Invalid parallel tool arguments JSON.")
		}
		return { name: call.name, arguments: argumentsText }
	})
}

const expandCall = (item: Record<string, unknown>, names: Set<string>) => {
	const calls = parseBatchCalls(item, names)
	return calls.map((call, index) => ({
		type: "function_call",
		id: childId(item.id as string, index, calls.length),
		call_id: childId(
			item.call_id as string,
			index,
			calls.length,
			item.id as string,
		),
		name: call.name,
		arguments: call.arguments,
		status: item.status ?? "completed",
	}))
}

const parseClientArguments = (
	value: unknown,
): Record<string, unknown> | undefined => {
	if (typeof value !== "string") return
	try {
		const parsed: unknown = JSON.parse(value)
		if (isRecord(parsed)) return parsed
	} catch {}
}

// Lite's tool-output branch requires a string, unlike the public Responses
// content-array union. Do not send image data as text or leak synthetic children
// upstream just because one tool returned an image. Keep its neighboring text.
const liteToolOutput = (value: unknown): string => {
	if (typeof value === "string") return value
	if (!Array.isArray(value)) return JSON.stringify(value) ?? ""
	return value
		.map((part) => {
			if (
				isRecord(part) &&
				part.type === "input_text" &&
				typeof part.text === "string"
			)
				return part.text
			if (isRecord(part) && part.type === "input_image")
				return "[Image omitted: Responses Lite tool outputs support text only.]"
			if (isRecord(part) && part.type === "input_file")
				return "[File omitted: Responses Lite tool outputs support text only.]"
			return "[Unsupported tool output content omitted: Responses Lite tool outputs support text only.]"
		})
		.join("\n")
}

const isFunctionItemId = (value: unknown): value is string =>
	typeof value === "string" && /^fc_[A-Za-z0-9_-]+$/.test(value)

export const adaptParallelInput = (input: unknown[]): unknown[] => {
	const groups = new Map<
		string,
		{
			total: number
			valid: boolean
			calls: Map<number, Record<string, unknown>>
			outputs: Map<number, Record<string, unknown>>
			parentIds: Set<string>
		}
	>()
	for (const item of input) {
		if (
			!isRecord(item) ||
			(item.type !== "function_call" && item.type !== "function_call_output")
		)
			continue
		const child = parseChildId(item.call_id)
		if (!child) continue
		const group = groups.get(child.parent) ?? {
			total: child.total,
			valid: true,
			calls: new Map<number, Record<string, unknown>>(),
			outputs: new Map<number, Record<string, unknown>>(),
			parentIds: new Set<string>(),
		}
		if (child.parentId) group.parentIds.add(child.parentId)
		const destination =
			item.type === "function_call" ? group.calls : group.outputs
		if (group.total !== child.total || destination.has(child.index))
			group.valid = false
		destination.set(child.index, item)
		groups.set(child.parent, group)
	}
	const folded = new Map<
		string,
		{ call: Record<string, unknown>; output: Record<string, unknown> }
	>()
	for (const [parent, group] of groups) {
		if (
			parent.length > 64 ||
			!/^[A-Za-z0-9_-]+$/.test(parent) ||
			parent.startsWith(childPrefix) ||
			!group.valid ||
			group.calls.size !== group.total ||
			group.outputs.size !== group.total
		)
			continue
		const calls = []
		const results = []
		const parentIds = new Set(group.parentIds)
		for (let index = 0; index < group.total; index++) {
			const call = group.calls.get(index)
			const output = group.outputs.get(index)
			const args = parseClientArguments(call?.arguments)
			if (
				!call ||
				!output ||
				typeof call.name !== "string" ||
				!call.name ||
				!args
			)
				break
			calls.push({ name: call.name, arguments: args })
			results.push({
				name: call.name,
				output: liteToolOutput(output.output),
				...(output.status === undefined ? {} : { status: output.status }),
			})
			const id = parseChildId(call.id)
			if (
				!group.parentIds.size &&
				id?.index === index &&
				id.total === group.total
			)
				parentIds.add(id.parent)
		}
		// Decide for the whole group before replacing anything in the history.
		if (calls.length !== group.total) continue
		// call_id metadata is authoritative; legacy item IDs are only a hint.
		const parentId =
			parentIds.size === 1 ? parentIds.values().next().value : undefined
		folded.set(parent, {
			call: {
				type: "function_call",
				id: isFunctionItemId(parentId) ? parentId : `fc_${encodeId(parent)}`,
				call_id: parent,
				name: PARALLEL_TOOL_FUNCTION,
				status: "completed",
				arguments: JSON.stringify({ calls }),
			},
			output: {
				type: "function_call_output",
				call_id: parent,
				output: JSON.stringify({ results }),
			},
		})
	}
	const insertedCalls = new Set<string>()
	const insertedOutputs = new Set<string>()
	const reconstructed = input.flatMap((item) => {
		if (
			!isRecord(item) ||
			(item.type !== "function_call" && item.type !== "function_call_output")
		)
			return [item]
		const child = parseChildId(item.call_id)
		if (!child) return [item]
		const group = folded.get(child.parent)
		if (!group) return [item]
		if (item.type === "function_call") {
			if (insertedCalls.has(child.parent)) return []
			insertedCalls.add(child.parent)
			return [group.call]
		}
		if (insertedOutputs.has(child.parent)) return []
		insertedOutputs.add(child.parent)
		return [group.output]
	})
	// Incomplete/ambiguous legacy groups cannot be folded without inventing
	// results. Replay them with request-local, collision-free protocol IDs and
	// string outputs instead of passing proxy IDs and content arrays to Lite.
	const usedIds = new Set(
		reconstructed.flatMap((item) =>
			isRecord(item) ? [item.id, item.call_id] : [],
		),
	)
	const replacements = new Map<string, string>()
	let nextId = 0
	const replacement = (id: string) => {
		let mapped = replacements.get(id)
		if (mapped) return mapped
		do {
			mapped = `call_openai_oauth_${nextId++}`
		} while (usedIds.has(mapped) || usedIds.has(`fc_${mapped}`))
		replacements.set(id, mapped)
		return mapped
	}
	return reconstructed.map((item) => {
		if (
			!isRecord(item) ||
			(item.type !== "function_call" && item.type !== "function_call_output")
		)
			return item
		const synthetic =
			typeof item.call_id === "string" && item.call_id.startsWith(childPrefix)
		if (synthetic) {
			const callId = replacement(item.call_id as string)
			if (item.type === "function_call")
				return {
					...item,
					id: `fc_${callId}`,
					call_id: callId,
					arguments:
						typeof item.arguments === "string"
							? item.arguments
							: JSON.stringify(item.arguments ?? {}),
				}
			const { id: _id, ...output } = item
			return { ...output, call_id: callId, output: liteToolOutput(item.output) }
		}
		return item.type === "function_call_output" &&
			typeof item.output !== "string"
			? { ...item, output: liteToolOutput(item.output) }
			: item
	})
}

const separator = /\r?\n\r?\n/
const frame = (payload: Record<string, unknown>) =>
	`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`

/** Expand only the reserved batch function; never execute client tools in the proxy. */
export const adaptParallelResponsesSse = (
	stream: ReadableStream<Uint8Array>,
	names: Set<string>,
): ReadableStream<Uint8Array> => {
	const decoder = new TextDecoder("utf-8", { fatal: true })
	const encoder = new TextEncoder()
	let pending = ""
	let buffered: string[] | undefined
	let bufferedCharacters = 0
	let batchIndex: number | undefined
	let offset = 0
	let sequence = 0
	let sequenceEnabled = false
	const rewrite = (block: string): Record<string, unknown>[] => {
		const data = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
		let value: unknown
		try {
			value = JSON.parse(data)
		} catch {
			return []
		}
		if (!isRecord(value)) return []
		const type = value.type
		const index = value.output_index
		const item = value.item
		if (
			batchIndex !== undefined &&
			(type === "error" ||
				type === "response.failed" ||
				type === "response.incomplete" ||
				type === "response.cancelled" ||
				type === "response.canceled")
		) {
			batchIndex = undefined
			buffered = undefined
			return [value]
		}
		if (
			type === "response.output_item.added" &&
			isRecord(item) &&
			item.type === "function_call" &&
			item.name === PARALLEL_TOOL_FUNCTION &&
			typeof index === "number"
		) {
			if (batchIndex !== undefined)
				throw new ParallelToolBridgeError(
					"Interleaved parallel tool calls are unsupported.",
				)
			batchIndex = index
			buffered = []
			bufferedCharacters = 0
			return []
		}
		if (
			type === "response.output_item.done" &&
			isRecord(item) &&
			item.type === "function_call" &&
			item.name === PARALLEL_TOOL_FUNCTION &&
			typeof index === "number"
		) {
			if (batchIndex !== undefined && index !== batchIndex)
				throw new ParallelToolBridgeError("Conflicting parallel output index.")
			const children = expandCall(item, names)
			const start = index + offset
			const events = children.flatMap((child, position) => {
				const output_index = start + position
				return [
					{
						type: "response.output_item.added",
						output_index,
						item: { ...child, arguments: "", status: "in_progress" },
					},
					{
						type: "response.function_call_arguments.delta",
						output_index,
						item_id: child.id,
						delta: child.arguments,
					},
					{
						type: "response.function_call_arguments.done",
						output_index,
						item_id: child.id,
						arguments: child.arguments,
					},
					{ type: "response.output_item.done", output_index, item: child },
				]
			})
			offset += children.length - 1
			batchIndex = undefined
			return events
		}
		if (
			batchIndex !== undefined &&
			index === batchIndex &&
			typeof type === "string" &&
			type.startsWith("response.function_call_arguments.")
		)
			return []
		if (
			type === "response.completed" &&
			isRecord(value.response) &&
			Array.isArray(value.response.output)
		) {
			return [
				{
					...value,
					response: {
						...value.response,
						output: value.response.output.flatMap((entry) =>
							isRecord(entry) &&
							entry.type === "function_call" &&
							entry.name === PARALLEL_TOOL_FUNCTION
								? expandCall(entry, names)
								: [entry],
						),
					},
				},
			]
		}
		if (typeof index === "number")
			return [{ ...value, output_index: index + offset }]
		return [value]
	}
	const emit = (
		block: string,
		controller: TransformStreamDefaultController<Uint8Array>,
	) => {
		const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"))
		if (!data) {
			controller.enqueue(encoder.encode(`${block}\n\n`))
			return
		}
		if (data.trim() === "data: [DONE]") {
			if (batchIndex !== undefined)
				throw new ParallelToolBridgeError(
					"Parallel tool call ended before completion.",
				)
			controller.enqueue(encoder.encode(`${block}\n\n`))
			return
		}
		const before = batchIndex
		const events = rewrite(block)
		if (batchIndex !== undefined) {
			if (before !== undefined && events.length > 0) {
				if (!buffered)
					throw new ParallelToolBridgeError("Missing parallel SSE buffer.")
				buffered.push(block)
				bufferedCharacters += block.length
				if (bufferedCharacters > MAX_PENDING_EVENT_CHARACTERS)
					throw new ParallelToolBridgeError(
						"Parallel SSE buffer limit exceeded.",
					)
			}
			return
		}
		for (const event of events) {
			if (typeof event.sequence_number === "number") sequenceEnabled = true
			controller.enqueue(
				encoder.encode(
					frame({
						...event,
						...(sequenceEnabled ? { sequence_number: sequence++ } : {}),
					}),
				),
			)
		}
		if (before !== undefined && buffered) {
			const held = buffered
			buffered = undefined
			for (const item of held) emit(item, controller)
		}
	}
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				pending += decoder.decode(chunk, { stream: true })
				let match = separator.exec(pending)
				while (match) {
					emit(pending.slice(0, match.index), controller)
					pending = pending.slice(match.index + match[0].length)
					match = separator.exec(pending)
				}
				if (pending.length > MAX_PENDING_EVENT_CHARACTERS)
					throw new ParallelToolBridgeError(
						"Parallel SSE event size limit exceeded.",
					)
			},
			flush(controller) {
				pending += decoder.decode()
				if (pending) emit(pending, controller)
				if (batchIndex !== undefined)
					throw new ParallelToolBridgeError(
						"Parallel tool call ended before completion.",
					)
			},
		}),
	)
}
