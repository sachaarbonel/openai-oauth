import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { type ClientRequest, type IncomingMessage, request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { startOpenAIOAuthServer } from "../src/index.js"
import type { RunningOpenAIOAuthServer } from "../src/types.js"

const model = "gpt-6-astra"
const initialChunk = Buffer.from(": synthetic keepalive\n\n")
const deferred = <T>() => {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

const bounded = async <T>(promise: Promise<T>): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Fixture timed out")), 2000)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

describe("Node HTTP cancellation", () => {
	let root: string
	let running: RunningOpenAIOAuthServer | undefined
	const clients: ClientRequest[] = []
	const cleanups: Array<() => void> = []

	beforeEach(async () => {
		vi.stubGlobal("fetch", () => {
			throw new Error("Offline fixture: external fetch is forbidden")
		})
		root = await mkdtemp(join(tmpdir(), "openai-oauth-cancellation-"))
		await writeFile(
			join(root, "auth.json"),
			JSON.stringify({
				tokens: {
					access_token: "inert-offline-fixture",
					account_id: "inert-offline-fixture",
				},
			}),
			{ mode: 0o600 },
		)
	})

	afterEach(async () => {
		for (const client of clients.splice(0)) client.destroy()
		for (const cleanup of cleanups.splice(0)) cleanup()
		running?.server.closeAllConnections()
		await running?.close()
		running = undefined
		await rm(root, { recursive: true, force: true })
		vi.unstubAllGlobals()
	})

	const connect = async (
		upstream: (signal: AbortSignal) => Response | Promise<Response>,
	) => {
		const started = deferred<AbortSignal>()
		let requestCount = 0
		running = await startOpenAIOAuthServer({
			host: "127.0.0.1",
			port: 0,
			models: [model],
			authFilePath: join(root, "auth.json"),
			ensureFresh: false,
			codexVersion: "0.144.1",
			fetch: async (url, init) => {
				const pathname = new URL(String(url)).pathname
				if (pathname === "/backend-api/codex/models") {
					return Response.json({ models: [{ slug: model }] })
				}
				expect(pathname).toBe("/backend-api/codex/responses")
				expect(++requestCount).toBe(1)
				if (!init?.signal) throw new Error("Missing upstream signal")
				started.resolve(init.signal)
				return upstream(init.signal)
			},
		})
		const closed = deferred<void>()
		running.server.once("request", (_req, res) => {
			res.once("close", () => closed.resolve())
		})
		const received = deferred<IncomingMessage>()
		const client = request(`${running.url}/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
		})
		clients.push(client)
		client.on("error", () => {}) // Expected when a fixture destroys its socket.
		client.once("response", received.resolve)
		client.end(
			JSON.stringify({ model, input: "Synthetic input", stream: true }),
		)
		return { client, started, received, closed }
	}

	const stalledBody = (
		sendInitialChunk: boolean,
		rejectCancellation = false,
	) => {
		let controller: ReadableStreamDefaultController<Uint8Array>
		const cancel = vi.fn(() => {
			if (rejectCancellation)
				return Promise.reject(new Error("Fixture cleanup"))
		})
		const body = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value
				if (sendInitialChunk) controller.enqueue(initialChunk)
			},
			cancel,
		})
		cleanups.push(() => {
			// Also releases the old, broken implementation when a regression fails.
			try {
				controller.close()
			} catch {}
		})
		return {
			body,
			cancel,
			response: new Response(body, {
				headers: { "content-type": "text/event-stream" },
			}),
		}
	}

	test("disconnect aborts a request still waiting for upstream headers", async () => {
		const pending = deferred<Response>()
		cleanups.push(() => pending.resolve(new Response(null)))
		const { client, started } = await connect((signal) => {
			signal.addEventListener("abort", () => pending.reject(signal.reason), {
				once: true,
			})
			return pending.promise
		})
		const signal = await bounded(started.promise)
		expect(signal.aborted).toBe(false)
		client.destroy()
		await vi.waitFor(() => expect(signal.aborted).toBe(true))
		expect(signal.reason.name).toBe("AbortError")
	})

	test.each([
		{ name: "before the first byte", sendInitialChunk: false, reject: false },
		{ name: "mid-stream", sendInitialChunk: true, reject: false },
		{ name: "with rejecting cleanup", sendInitialChunk: true, reject: true },
	])("disconnect $name aborts fetch and cancels the stalled body", async (scenario) => {
		const fixture = stalledBody(scenario.sendInitialChunk, scenario.reject)
		const { client, started, received } = await connect(() => fixture.response)
		const signal = await bounded(started.promise)
		if (scenario.sendInitialChunk) {
			const response = await bounded(received.promise)
			await bounded(
				new Promise<void>((resolve) => response.once("data", resolve)),
			)
		}
		expect(signal.aborted).toBe(false)
		client.destroy()
		await vi.waitFor(() => {
			expect(signal.aborted).toBe(true)
			expect(fixture.cancel).toHaveBeenCalledExactlyOnceWith(signal.reason)
			expect(fixture.body.locked).toBe(false)
		})
	})

	test("cancels a response body that arrives after the client disconnects", async () => {
		const pending = deferred<Response>()
		const fixture = stalledBody(false)
		cleanups.push(() => pending.resolve(fixture.response))
		const { client, started, closed } = await connect(() => pending.promise)
		const signal = await bounded(started.promise)
		client.destroy()
		await bounded(closed.promise)
		pending.resolve(fixture.response)
		await vi.waitFor(() => {
			expect(signal.aborted).toBe(true)
			expect(fixture.cancel).toHaveBeenCalledExactlyOnceWith(signal.reason)
			expect(fixture.body.locked).toBe(false)
		})
	})

	test("normal request and response completion preserves bytes without aborting", async () => {
		const bytes = Buffer.from(
			'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n',
		)
		const cancel = vi.fn()
		const pending = deferred<Response>()
		cleanups.push(() => pending.resolve(new Response(null)))
		const { started, received, closed } = await connect(() => pending.promise)
		const signal = await bounded(started.promise)
		// Reading the complete incoming POST closes IncomingMessage normally.
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(signal.aborted).toBe(false)
		pending.resolve(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(bytes.subarray(0, 17))
						controller.enqueue(bytes.subarray(17))
						controller.close()
					},
					cancel,
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
		)
		const response = await bounded(received.promise)
		const chunks: Buffer[] = []
		await bounded(
			(async () => {
				for await (const chunk of response) chunks.push(Buffer.from(chunk))
			})(),
		)
		await bounded(closed.promise)
		expect(response.statusCode).toBe(200)
		expect(Buffer.concat(chunks)).toEqual(bytes)
		expect(signal.aborted).toBe(false)
		expect(cancel).not.toHaveBeenCalled()
	})
})
