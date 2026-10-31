import type { OpenAIOAuthTransport } from "@openai-oauth/core"
import { afterEach, expect, test, vi } from "vitest"
import { handleResponsesRequest } from "../src/responses.js"
import { withResponsesHeartbeat } from "../src/responses-heartbeat.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
function fixture(signal = new AbortController().signal) {
	let upstream!: ReadableStreamDefaultController<Uint8Array>
	const cancel = vi.fn()
	const response = withResponsesHeartbeat(
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					upstream = controller
				},
				cancel,
			}),
			{ headers: { "content-type": "text/event-stream" } },
		),
		signal,
	)
	if (!response.body) throw new Error("Missing fixture stream")
	return { response, upstream, cancel, reader: response.body.getReader() }
}
async function next(reader: ReadableStreamDefaultReader<Uint8Array>) {
	const result = await reader.read()
	return result.done ? undefined : decoder.decode(result.value)
}
afterEach(() => vi.useRealTimers())

test("keeps a quiet response alive past the proxy idle timeout and preserves its events", async () => {
	vi.useFakeTimers()
	const { reader, upstream } = fixture()
	expect(await next(reader)).toBe(": keep-alive\n")
	for (let i = 0; i < 10; i++) {
		const waiting = next(reader)
		await vi.advanceTimersByTimeAsync(15_000)
		expect(await waiting).toBe(": keep-alive\n")
	}
	const event =
		'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n'
	upstream.enqueue(encoder.encode(event))
	upstream.close()
	expect(await next(reader)).toBe(event)
	expect(await next(reader)).toBeUndefined()
	expect(vi.getTimerCount()).toBe(0)
})

test.each([
	"\n",
	"\r\n",
	"\r",
])("inserts comments only between complete SSE lines (%j)", async (newline) => {
	vi.useFakeTimers()
	const { reader, upstream } = fixture()
	await next(reader)
	const first = `event: response.output_text.delta${newline}data: {"delta":"café"}`
	const bytes = encoder.encode(first)
	// Deliberately split UTF-8 and the final CRLF across chunks.
	const split = bytes.indexOf(0xc3) + 1
	upstream.enqueue(bytes.slice(0, split))
	expect(await next(reader)).toBe(`event: response.output_text.delta${newline}`)
	const waiting = next(reader)
	await vi.advanceTimersByTimeAsync(15_000)
	expect(await waiting).toBe(": keep-alive\n")
	upstream.enqueue(bytes.slice(split))
	upstream.enqueue(encoder.encode(newline[0]))
	if (newline.length === 2) upstream.enqueue(encoder.encode(newline[1]))
	upstream.enqueue(encoder.encode(`${newline}data: [DONE]${newline}${newline}`))
	upstream.close()
	let tail = ""
	for (;;) {
		const chunk = await next(reader)
		if (chunk === undefined) break
		tail += chunk
	}
	expect(tail).toBe(
		`data: {"delta":"café"}${newline}${newline}data: [DONE]${newline}${newline}`,
	)
	expect(vi.getTimerCount()).toBe(0)
})

test("bounds queued keep-alives when a reader is paused", async () => {
	vi.useFakeTimers()
	const { reader, upstream } = fixture()
	await vi.advanceTimersByTimeAsync(600_000)
	expect(await next(reader)).toBe(": keep-alive\n")
	upstream.close()
	expect(await next(reader)).toBeUndefined()
	expect(vi.getTimerCount()).toBe(0)
})

test.each([
	"abort",
	"cancel",
])("cancels upstream and timers on %s", async (kind) => {
	vi.useFakeTimers()
	const controller = new AbortController()
	const { reader, cancel } = fixture(controller.signal)
	await next(reader)
	if (kind === "abort") {
		const waiting = reader.read()
		controller.abort(new Error("fixture cancelled"))
		await expect(waiting).rejects.toThrow("fixture cancelled")
	} else await reader.cancel("fixture cancelled")
	expect(cancel).toHaveBeenCalledTimes(1)
	expect(vi.getTimerCount()).toBe(0)
})

test("preserves midstream errors without a retry or a synthetic completed event", async () => {
	vi.useFakeTimers()
	const { reader, upstream } = fixture()
	await next(reader)
	const waiting = reader.read()
	upstream.error(new Error("fixture transport failed"))
	await expect(waiting).rejects.toThrow("fixture transport failed")
	expect(vi.getTimerCount()).toBe(0)
})

test("rejects an unbounded partial SSE line", async () => {
	vi.useFakeTimers()
	const { reader, upstream, cancel } = fixture()
	await next(reader)
	upstream.enqueue(encoder.encode(`data: ${"x".repeat(8 * 1024 * 1024)}`))
	await expect(reader.read()).rejects.toThrow("transport limit")
	expect(cancel).toHaveBeenCalledTimes(1)
	expect(vi.getTimerCount()).toBe(0)
})

test.each([
	200, 429,
])("leaves JSON and original HTTP status %s unchanged", async (status) => {
	const request = vi.fn(async () =>
		Response.json({ fixture: true }, { status }),
	)
	const response = await handleResponsesRequest(
		new Request("https://fixture.invalid/v1/responses", {
			method: "POST",
			body: JSON.stringify({ model: "fixture", stream: false, input: "test" }),
		}),
		{ request } as unknown as OpenAIOAuthTransport,
	)
	expect(response.status).toBe(status)
	expect(await response.json()).toEqual({ fixture: true })
	expect(request).toHaveBeenCalledTimes(1)
})
