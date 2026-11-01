import { expect, test, vi } from "vitest"
import { handleResponsesRequest } from "../src/responses.js"

test("preserves cache routing identity but never forwards caller credentials", async () => {
	const request = vi.fn(async () => Response.json({ id: "fixture" }))
	await handleResponsesRequest(
		new Request("https://proxy.invalid/v1/responses", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"session-id": "chat-stable",
				"thread-id": "thread-stable",
				authorization: "Bearer caller",
				cookie: "private=1",
				"x-codex-turn-state": "stale-turn",
			},
			body: JSON.stringify({ model: "gpt-6.1-sol", input: "hello" }),
		}),
		{
			kind: "openai-compatible",
			baseURL: "https://proxy.invalid",
			fetch,
			request,
		},
	)
	const headers = new Headers(request.mock.calls[0]?.[1]?.headers)
	expect(headers.get("session-id")).toBe("chat-stable")
	expect(headers.get("thread-id")).toBe("thread-stable")
	expect(headers.has("authorization")).toBe(false)
	expect(headers.has("cookie")).toBe(false)
	expect(headers.has("x-codex-turn-state")).toBe(false)
})
