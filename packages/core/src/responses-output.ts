import { isRecord } from "./utils.js"

export const terminalResponseEvents = new Set([
	"response.completed",
	"response.failed",
	"response.cancelled",
	"response.canceled",
	"response.incomplete",
])

// Per-response limits, not a conversation cache. Never retain unbounded tool output.
const MAX_OUTPUT_ITEMS = 4096
const MAX_OUTPUT_CHARACTERS = 64 * 1024 * 1024

type OutputSlot = {
	id: string
	type: string
	callId?: string
	completed?: Record<string, unknown>
}

const sameJson = (left: unknown, right: unknown): boolean => {
	if (left === right) return true
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((value, index) => sameJson(value, right[index]))
		)
	}
	if (isRecord(left) && isRecord(right)) {
		const keys = Object.keys(left)
		return (
			keys.length === Object.keys(right).length &&
			keys.every(
				(key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]),
			)
		)
	}
	return false
}

/** Reconcile only empty successful terminal output, never deltas or inferred calls. */
export class CompletedResponseOutput {
	private readonly slots = new Map<number, OutputSlot>()
	private readonly itemIndexes = new Map<string, number>()
	private readonly callIndexes = new Map<string, number>()
	private responseId?: string
	private invalid = false
	private characters = 0
	terminal = false

	accept(
		type: string | undefined,
		payload: Record<string, unknown>,
	): Record<string, unknown> {
		if (this.terminal) return payload
		const response = payload.response
		if (isRecord(response) && typeof response.id === "string") {
			if (this.responseId !== undefined && response.id !== this.responseId)
				this.invalid = true
			this.responseId = response.id
		}

		if (
			type === "response.output_item.added" ||
			type === "response.output_item.done"
		) {
			this.collect(payload, type === "response.output_item.done")
		}
		if (type !== "error" && !terminalResponseEvents.has(type ?? ""))
			return payload
		this.terminal = true

		let result = payload
		if (
			type === "response.completed" &&
			isRecord(response) &&
			response.status === "completed" &&
			(response.output === undefined ||
				(Array.isArray(response.output) && response.output.length === 0)) &&
			(this.slots.size > 0 || this.invalid)
		) {
			const ordered = [...this.slots.entries()].sort(
				([left], [right]) => left - right,
			)
			if (
				this.invalid ||
				ordered.some(
					([index, slot], ordinal) => index !== ordinal || !slot.completed,
				)
			) {
				throw new Error(
					"Cannot reconstruct completed response output: unfinished or conflicting output items.",
				)
			}
			result = {
				...payload,
				response: {
					...response,
					output: ordered.map(([, slot]) => slot.completed),
				},
			}
		}
		this.slots.clear()
		this.itemIndexes.clear()
		this.callIndexes.clear()
		return result
	}

	private collect(payload: Record<string, unknown>, done: boolean): void {
		const { item, output_index: index } = payload
		if (
			typeof index !== "number" ||
			!Number.isSafeInteger(index) ||
			index < 0 ||
			!isRecord(item) ||
			typeof item.id !== "string" ||
			!item.id ||
			typeof item.type !== "string"
		) {
			this.invalid = true
			return
		}
		if (index >= MAX_OUTPUT_ITEMS)
			throw new Error("Responses output item limit exceeded.")
		const previousIndex = this.itemIndexes.get(item.id)
		const slot = this.slots.get(index)
		if (
			(previousIndex !== undefined && previousIndex !== index) ||
			(slot && (slot.id !== item.id || slot.type !== item.type))
		) {
			this.invalid = true
			return
		}
		this.itemIndexes.set(item.id, index)
		const current: OutputSlot = slot ?? { id: item.id, type: item.type }
		this.slots.set(index, current)
		if (current.callId !== undefined && item.call_id !== current.callId)
			this.invalid = true
		if (typeof item.call_id === "string") {
			current.callId = item.call_id
			const callIndex = this.callIndexes.get(item.call_id)
			if (callIndex !== undefined && callIndex !== index) this.invalid = true
			this.callIndexes.set(item.call_id, index)
		}
		if (!done) return
		if (item.status !== undefined && item.status !== "completed")
			this.invalid = true
		if (current.completed) {
			if (!sameJson(current.completed, item)) this.invalid = true
			return
		}
		this.characters += JSON.stringify(item).length
		if (this.characters > MAX_OUTPUT_CHARACTERS)
			throw new Error("Responses completed output size limit exceeded.")
		current.completed = item
	}
}
