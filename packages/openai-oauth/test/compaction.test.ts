import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "vitest"
import { createOpenAIOAuthFetchHandler } from "../src/index.js"

const opaque = {
	type: "compaction",
	id: "cmp_fixture",
	encrypted_content: "opaque-fixture",
}
async function fixture(
	run: (
		handler: (request: Request) => Promise<Response>,
		calls: Array<{ url: string; init?: RequestInit }>,
	) => Promise<void>,
	status = 200,
	output: unknown[] = [opaque],
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-compact-"))
	const authFilePath = path.join(root, "auth.json")
	await fs.writeFile(
		authFilePath,
		JSON.stringify({
			tokens: { access_token: "fixture-access", account_id: "fixture-account" },
		}),
	)
	const calls: Array<{ url: string; init?: RequestInit }> = []
	const handler = createOpenAIOAuthFetchHandler({
		authFilePath,
		ensureFresh: false,
		codexVersion: "0.144.1",
		fetch: async (input, init) => {
			const url = String(input)
			if (url.includes("/models?"))
				return Response.json({
					models: [{ slug: "gpt-6-luna", use_responses_lite: true }],
				})
			calls.push({ url, init })
			if (status !== 200)
				return Response.json({ error: { code: "unavailable" } }, { status })
			return new Response(
				`event: response.completed\ndata: ${JSON.stringify({
					type: "response.completed",
					response: {
						id: "resp_fixture",
						object: "response",
						created_at: 1,
						status: "completed",
						output,
						usage: { input_tokens: 55, output_tokens: 12, total_tokens: 67 },
					},
				})}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			)
		},
	})
	try {
		await run(handler, calls)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}
const request = (body: unknown, signal?: AbortSignal) =>
	new Request("http://fixture.invalid/v1/responses/compact", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	})

test("returns a native compaction window through the authenticated V2 Responses transport", async () => {
	await fixture(async (handler, calls) => {
		const controller = new AbortController()
		const input = [
			{ role: "user", content: "Keep my correction" },
			{ role: "assistant", content: "Noted" },
		]
		const req = request(
			{ model: "gpt-6-luna", input, instructions: "Current policy" },
			controller.signal,
		)
		const response = await handler(req)
		expect(response.status).toBe(200)
		expect(response.headers.get("cache-control")).toBe("no-store")
		expect(await response.json()).toMatchObject({
			object: "response.compaction",
			output: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Keep my correction" }],
				},
				opaque,
			],
			usage: { input_tokens: 55, output_tokens: 12 },
		})
		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		)
		const sent = JSON.parse(String(calls[0]?.init?.body))
		expect(sent.input.at(-1)).toEqual({ type: "compaction_trigger" })
		expect(
			sent.input.some((item: { role?: string }) => item.role === "user"),
		).toBe(true)
		expect(sent.store).toBe(false)
		expect(sent.parallel_tool_calls).toBe(false)
		expect(sent.tools ?? []).toEqual([])
		expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
			"Bearer fixture-access",
		)
		expect(calls[0]?.init?.signal).toBe(req.signal)
	})
})

test.each([
	{},
	{ model: "gpt-6-luna", input: [] },
	{ model: "gpt-6-luna", input: "x", previous_response_id: "resp_old" },
	{ model: "gpt-6-luna", input: [{ type: "item_reference", id: "old" }] },
	{ model: "gpt-6-luna", input: [{ type: "compaction_trigger" }] },
	{ model: "gpt-6-luna", input: "x", tools: [{ type: "function" }] },
])("rejects unsafe or incomplete requests without a model call: %j", async (body) => {
	await fixture(async (handler, calls) => {
		expect((await handler(request(body))).status).toBe(400)
		expect(calls).toHaveLength(0)
	})
})

test("preserves provider failures without retrying", async () => {
	await fixture(async (handler, calls) => {
		const response = await handler(request({ model: "gpt-6-luna", input: "x" }))
		expect(response.status).toBe(429)
		expect(await response.json()).toEqual({ error: { code: "unavailable" } })
		expect(calls).toHaveLength(1)
	}, 429)
})

test("rejects ordinary text instead of pretending it is native compaction", async () => {
	await fixture(
		async (handler) => {
			const response = await handler(
				request({ model: "gpt-6-luna", input: "x" }),
			)
			expect(response.status).toBe(502)
			expect(await response.json()).toMatchObject({
				error: { type: "compaction_failed" },
			})
		},
		200,
		[
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Summary" }],
			},
		],
	)
})

test("repeated native compaction retains original user corrections in its complete working window", async () => {
	await fixture(async (handler) => {
		const first = await handler(
			request({
				model: "gpt-6-luna",
				input: [
					{ role: "user", content: "Correction: Indigo-91 replaces Amber." },
					{ role: "assistant", content: "Noted" },
				],
			}),
		)
		const firstWindow = await first.json()
		const second = await handler(
			request({
				model: "gpt-6-luna",
				input: [
					...firstWindow.output,
					{ role: "user", content: "Continue unrelated background work." },
					{ role: "assistant", content: "Long assistant history" },
				],
			}),
		)
		expect(second.status).toBe(200)
		const secondWindow = await second.json()
		expect(secondWindow.output).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "Correction: Indigo-91 replaces Amber." },
				],
			},
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "Continue unrelated background work." },
				],
			},
			opaque,
		])
	})
})
