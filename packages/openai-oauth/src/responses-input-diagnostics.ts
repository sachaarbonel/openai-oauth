import { isRecord } from "./shared.js"

// Finite protocol vocabulary only: never emit IDs, tool names, content, or
// arbitrary type/field values supplied by clients or echoed by upstream.
const inputTypes = new Set([
	"message",
	"additional_tools",
	"reasoning",
	"compaction",
	"item_reference",
	"function_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
	"apply_patch_call",
	"apply_patch_call_output",
	"shell_call",
	"shell_call_output",
	"local_shell_call",
	"local_shell_call_output",
	"computer_call",
	"computer_call_output",
	"web_search_call",
	"file_search_call",
	"code_interpreter_call",
	"image_generation_call",
	"mcp_call",
	"mcp_list_tools",
	"mcp_approval_request",
	"mcp_approval_response",
])
export const diagnosticInputType = (item: unknown): string =>
	isRecord(item) && typeof item.type === "string" && inputTypes.has(item.type)
		? item.type
		: isRecord(item) && item.type === undefined && typeof item.role === "string"
			? "message"
			: "unknown"

const shape = (value: unknown) =>
	value === null ? "null" : Array.isArray(value) ? "array" : typeof value

export const summarizeRequestInput = (
	body: Record<string, unknown>,
	lite: boolean,
) => {
	if (!Array.isArray(body.input)) return { shape: shape(body.input) }
	const issues: {
		index: number
		type: string
		field: string
		reason: string
		shape: string
	}[] = []
	let issueCount = 0
	const types: Record<string, number> = {}
	for (const [index, item] of body.input.entries()) {
		const type = diagnosticInputType(item)
		types[type] = (types[type] ?? 0) + 1
		if (!isRecord(item)) continue
		const issue = (
			field: "id" | "call_id" | "arguments" | "output",
			reason: string,
		) => {
			issueCount++
			if (issues.length < 16)
				issues.push({ index, type, field, reason, shape: shape(item[field]) })
		}
		if (type !== "function_call" && type !== "function_call_output") continue
		if (typeof item.call_id !== "string" || !item.call_id)
			issue("call_id", "expected_nonempty_string")
		else if (item.call_id.startsWith("__openai_oauth_batch_"))
			issue("call_id", "synthetic_bridge_id")
		else if (item.call_id.length > 64) issue("call_id", "exceeds_64_characters")
		else if (lite && !/^[A-Za-z0-9_-]+$/.test(item.call_id))
			issue("call_id", "invalid_characters")
		if (type === "function_call") {
			if (
				lite &&
				(typeof item.id !== "string" || !/^fc_[A-Za-z0-9_-]+$/.test(item.id))
			)
				issue("id", "expected_function_item_id")
			if (typeof item.arguments !== "string")
				issue("arguments", "expected_string")
		} else if (lite && typeof item.output !== "string")
			issue("output", "lite_requires_string")
	}
	return {
		shape: "array",
		count: body.input.length,
		types,
		issues,
		issuesTruncated: issueCount > issues.length,
	}
}

// Take locations only from reserved input-path syntax; never retain free-form
// upstream prose or a client-defined field name. Unknown suffixes are discarded.
export const rejectionInputLocations = (
	values: unknown[],
	typeAt: (index: number) => string | undefined,
) => {
	const locations = new Map<
		string,
		{ index: number; type: string; field?: string }
	>()
	for (const value of values) {
		if (typeof value !== "string") continue
		// Credentials can coincidentally contain reserved path syntax too.
		const text = value.replace(
			/\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=][^\r\n]*/gi,
			"",
		)
		for (const match of text.matchAll(
			/\binput(?:\[(\d{1,6})\]|\.(\d{1,6}))((?:\.[a-z_]+){0,3})/g,
		)) {
			const index = Number(match[1] ?? match[2])
			const parts = (match[3] ?? "").split(".").filter(Boolean)
			const field = parts.find((part) =>
				[
					"id",
					"call_id",
					"arguments",
					"output",
					"content",
					"type",
					"name",
					"status",
				].includes(part),
			)
			const type =
				typeAt(index) ?? parts.find((part) => inputTypes.has(part)) ?? "unknown"
			locations.set(`${index}:${field ?? ""}`, {
				index,
				type,
				...(field ? { field } : {}),
			})
			if (locations.size === 16) return [...locations.values()]
		}
	}
	return locations.size ? [...locations.values()] : undefined
}
