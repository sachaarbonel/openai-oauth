import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { startOpenAIOAuthServer } from "../src/index.js"

describe("node server runtime", () => {
	let close: (() => Promise<void>) | undefined
	let root: string | undefined
	afterEach(async () => {
		await close?.()
		close = undefined
		if (root) await rm(root, { recursive: true, force: true })
	})
	test("warms protocol metadata before listening even with a configured model list", async () => {
		root = await mkdtemp(join(tmpdir(), "oauth-bootstrap-"))
		const authFilePath = join(root, "auth.json")
		await writeFile(
			authFilePath,
			JSON.stringify({
				tokens: { access_token: "fixture", account_id: "fixture" },
			}),
		)
		const upstream = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				if (String(url).includes("/models?"))
					return Response.json({
						models: [{ slug: "gpt-5.4-mini", use_responses_lite: true }],
					})
				expect(
					new Headers(init?.headers).get(
						"x-openai-internal-codex-responses-lite",
					),
				).toBe("true")
				return Response.json(
					{ error: { message: "Synthetic upstream result" } },
					{ status: 400 },
				)
			},
		)
		const running = await startOpenAIOAuthServer({
			host: "127.0.0.1",
			port: 0,
			models: ["gpt-5.4-mini"],
			authFilePath,
			ensureFresh: false,
			fetch: upstream,
		})
		close = running.close
		expect(upstream).toHaveBeenCalledTimes(1)
		const response = await fetch(
			`http://${running.host}:${running.port}/health`,
		)
		expect(response.ok).toBe(true)
		await expect(response.json()).resolves.toEqual({
			ok: true,
			replay_state: "stateless",
		})
		await fetch(`${running.url}/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }),
		})
		// One metadata bootstrap, then the response request; no registry or second model lookup.
		expect(upstream).toHaveBeenCalledTimes(2)
	})
})
