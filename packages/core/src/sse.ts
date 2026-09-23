import {
	CompletedResponseOutput,
	terminalResponseEvents,
} from "./responses-output.js"
import { isRecord } from "./utils.js"

const SSE_SEPARATOR = /\r?\n\r?\n/

export type ServerSentEvent = {
	event?: string
	data?: string
}

const parseEventBlock = (block: string): ServerSentEvent => {
	const event: ServerSentEvent = {}
	const dataLines: string[] = []

	for (const line of block.split(/\r?\n/)) {
		if (line.startsWith("event:")) {
			event.event = line.slice(6).trim()
			continue
		}

		if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trimStart())
		}
	}

	if (dataLines.length > 0) {
		event.data = dataLines.join("\n")
	}

	return event
}

export async function* iterateServerSentEvents(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let buffer = ""
	let reachedEnd = false

	try {
		while (true) {
			const { value, done } = await reader.read()
			if (done) {
				reachedEnd = true
				break
			}

			buffer += decoder.decode(value, { stream: true })
			const blocks = buffer.split(SSE_SEPARATOR)
			buffer = blocks.pop() ?? ""

			for (const block of blocks) {
				if (block.trim().length > 0) {
					yield parseEventBlock(block)
				}
			}
		}

		if (buffer.trim().length > 0) {
			yield parseEventBlock(buffer)
		}
	} finally {
		if (!reachedEnd) {
			void reader.cancel().catch(() => undefined)
		}
		reader.releaseLock()
	}
}

const parsePayload = (
	event: ServerSentEvent,
): Record<string, unknown> | undefined => {
	try {
		const parsed: unknown = JSON.parse(event.data ?? "")
		return isRecord(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/** Preserve event bytes except the repaired terminal data; no tee or read-ahead loop. */
export const normalizeResponsesSse = (
	stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> => {
	const output = new CompletedResponseOutput()
	const decoder = new TextDecoder("utf-8", { fatal: true })
	const encoder = new TextEncoder()
	const maxEventCharacters = 32 * 1024 * 1024
	let buffer = ""

	const normalizeBlock = (block: string): string => {
		if (block.length > maxEventCharacters)
			throw new Error("Responses SSE event size limit exceeded.")
		const event = parseEventBlock(block)
		const parsed = parsePayload(event)
		if (!parsed) return block
		const type = typeof parsed.type === "string" ? parsed.type : event.event
		const normalized = output.accept(type, parsed)
		if (normalized === parsed) return block
		let replaced = false
		return block
			.split(/\r?\n/)
			.flatMap((line) => {
				if (!line.startsWith("data:")) return [line]
				if (replaced) return []
				replaced = true
				return [`data: ${JSON.stringify(normalized)}`]
			})
			.join(block.includes("\r\n") ? "\r\n" : "\n")
	}

	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true })
				let match = SSE_SEPARATOR.exec(buffer)
				while (match !== null) {
					controller.enqueue(
						encoder.encode(
							normalizeBlock(buffer.slice(0, match.index)) + match[0],
						),
					)
					buffer = buffer.slice(match.index + match[0].length)
					match = SSE_SEPARATOR.exec(buffer)
				}
				if (buffer.length > maxEventCharacters)
					throw new Error("Responses SSE event size limit exceeded.")
			},
			flush(controller) {
				buffer += decoder.decode()
				// An unterminated frame is not evidence of a completed response.
				if (!output.terminal)
					throw new Error("Responses stream ended before a terminal response.")
				if (buffer) controller.enqueue(encoder.encode(buffer))
			},
		}),
	)
}

export const collectCompletedResponseFromSse = async (
	stream: ReadableStream<Uint8Array>,
): Promise<Record<string, unknown>> => {
	const output = new CompletedResponseOutput()

	for await (const event of iterateServerSentEvents(stream)) {
		const parsed = parsePayload(event)
		if (!parsed) continue
		const type = typeof parsed.type === "string" ? parsed.type : event.event
		if (type === "error")
			throw new Error("Responses stream returned an error event.")
		const normalized = output.accept(type, parsed)
		if (terminalResponseEvents.has(type ?? "") && isRecord(normalized.response))
			return normalized.response
	}

	throw new Error("No terminal response found in SSE stream.")
}
