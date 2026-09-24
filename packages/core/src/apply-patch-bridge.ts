import { isRecord } from "./utils.js"

export const APPLY_PATCH_FUNCTION = "__openai_oauth_apply_patch"

export const selectPatchFunctionName = (
	tools: unknown[],
	input: unknown[],
): string => {
	const declared = [
		...tools,
		...input.flatMap((item) =>
			isRecord(item) &&
			item.type === "additional_tools" &&
			Array.isArray(item.tools)
				? item.tools
				: [],
		),
	]
	const names = new Set(declared.filter(isRecord).map((tool) => tool.name))
	for (let suffix = 0; suffix < 1000; suffix++) {
		const name = suffix
			? `${APPLY_PATCH_FUNCTION}_${suffix}`
			: APPLY_PATCH_FUNCTION
		if (!names.has(name)) return name
	}
	throw new Error("No available internal apply_patch function name.")
}

// Responses Lite accepts developer additional_tools functions, but rejects the
// public apply_patch declaration. The caller still receives native patch items.
export const applyPatchFunction = (name: string) => ({
	type: "function",
	name,
	description:
		"Apply one file change. Set operation.type to create_file, update_file, or delete_file. Create and update require diff; update may set move_to.",
	strict: false,
	parameters: {
		type: "object",
		properties: {
			operation: {
				type: "object",
				properties: {
					type: {
						type: "string",
						enum: ["create_file", "update_file", "delete_file"],
					},
					path: { type: "string" },
					diff: { type: "string" },
					move_to: { type: "string" },
				},
				required: ["type", "path"],
				additionalProperties: false,
			},
		},
		required: ["operation"],
		additionalProperties: false,
	},
})

export const adaptPatchInput = (item: unknown, name: string): unknown => {
	if (!isRecord(item)) return item
	if (item.type === "apply_patch_call") {
		return {
			type: "function_call",
			id: item.id,
			call_id: item.call_id,
			name,
			status: item.status,
			arguments: JSON.stringify({ operation: item.operation }),
		}
	}
	if (item.type === "apply_patch_call_output") {
		// Native patch output is optional; Lite function output requires a string.
		return {
			type: "function_call_output",
			id: item.id,
			call_id: item.call_id,
			output: typeof item.output === "string" ? item.output : "",
			status: item.status,
		}
	}
	return item
}

const patchOperation = (value: unknown): Record<string, unknown> => {
	if (
		!isRecord(value) ||
		typeof value.type !== "string" ||
		typeof value.path !== "string" ||
		!value.path
	)
		throw new Error("Invalid adapted apply_patch operation.")
	if (value.type === "delete_file")
		return { type: value.type, path: value.path }
	if (
		(value.type === "create_file" || value.type === "update_file") &&
		typeof value.diff === "string"
	) {
		return {
			type: value.type,
			path: value.path,
			diff: value.diff,
			...(value.type === "update_file" &&
			typeof value.move_to === "string" &&
			value.move_to
				? { move_to: value.move_to }
				: {}),
		}
	}
	throw new Error("Invalid adapted apply_patch operation.")
}

const nativePatchCall = (item: Record<string, unknown>) => {
	if (
		typeof item.arguments !== "string" ||
		typeof item.call_id !== "string" ||
		!item.call_id ||
		(item.status !== undefined && item.status !== "completed")
	)
		throw new Error("Incomplete adapted apply_patch call.")
	let args: unknown
	try {
		args = JSON.parse(item.arguments)
	} catch {
		throw new Error("Invalid adapted apply_patch arguments.")
	}
	return {
		type: "apply_patch_call",
		id: item.id,
		call_id: item.call_id,
		status: item.status ?? "completed",
		operation: patchOperation(isRecord(args) ? args.operation : undefined),
	}
}

const separator = /\r?\n\r?\n/
const maxEventCharacters = 32 * 1024 * 1024

/** Translate only our reserved function. Pass all other SSE frames through. */
export const adaptPatchResponsesSse = (
	stream: ReadableStream<Uint8Array>,
	name: string,
) => {
	const decoder = new TextDecoder("utf-8", { fatal: true })
	const encoder = new TextEncoder()
	const patchIndexes = new Set<number>()
	let pending = ""
	const rewrite = (block: string): string => {
		const lines = block.split(/\r?\n/)
		const data = lines
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
		let value: unknown
		try {
			value = JSON.parse(data)
		} catch {
			return block
		}
		if (!isRecord(value)) return block
		const type = value.type
		const index = value.output_index
		const item = value.item
		const isPatch =
			isRecord(item) && item.type === "function_call" && item.name === name
		if (
			type === "response.output_item.added" &&
			isPatch &&
			typeof index === "number"
		) {
			patchIndexes.add(index)
			return ""
		}
		if (
			typeof index === "number" &&
			patchIndexes.has(index) &&
			typeof type === "string" &&
			type.startsWith("response.function_call_arguments.")
		)
			return ""
		if (
			type === "response.output_item.done" &&
			isPatch &&
			typeof index === "number"
		) {
			patchIndexes.delete(index)
			const native = nativePatchCall(item)
			const added = {
				...value,
				type: "response.output_item.added",
				item: { ...native, status: "in_progress" },
			}
			const done = { ...value, item: native }
			return `event: response.output_item.added\ndata: ${JSON.stringify(added)}\n\nevent: response.output_item.done\ndata: ${JSON.stringify(done)}`
		}
		if (
			type === "response.completed" &&
			isRecord(value.response) &&
			Array.isArray(value.response.output)
		) {
			const output = value.response.output.map((entry) =>
				isRecord(entry) && entry.type === "function_call" && entry.name === name
					? nativePatchCall(entry)
					: entry,
			)
			const rewritten = { ...value, response: { ...value.response, output } }
			return `event: response.completed\ndata: ${JSON.stringify(rewritten)}`
		}
		return block
	}
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				pending += decoder.decode(chunk, { stream: true })
				let match = separator.exec(pending)
				while (match) {
					const rewritten = rewrite(pending.slice(0, match.index))
					if (rewritten)
						controller.enqueue(encoder.encode(rewritten + match[0]))
					pending = pending.slice(match.index + match[0].length)
					match = separator.exec(pending)
				}
				if (pending.length > maxEventCharacters)
					throw new Error("Responses SSE event size limit exceeded.")
			},
			flush(controller) {
				pending += decoder.decode()
				if (pending) controller.enqueue(encoder.encode(rewrite(pending)))
			},
		}),
	)
}
