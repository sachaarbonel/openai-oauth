import { afterEach, expect, test, vi } from "vitest"
import {
	createModelCatalogCache,
	ModelMetadataError,
} from "../src/model-catalog-cache.js"
import type { CodexModelInfo } from "../src/models.js"

const models: CodexModelInfo[] = [
	{ slug: "fixture", useResponsesLite: true, raw: {} },
]
const tick = async () => {
	for (let n = 0; n < 10; n++) await Promise.resolve()
}
afterEach(() => vi.useRealTimers())

test("100 requests use the same last-good snapshot while a single refresh is stalled", async () => {
	vi.useFakeTimers()
	let release: ((value: CodexModelInfo[]) => void) | undefined
	const load = vi.fn(async () => models)
	const resolve = createModelCatalogCache<string>((auth) => auth, load)
	const first = await resolve("one", "fixture")
	load.mockImplementation(
		() =>
			new Promise((done) => {
				release = done
			}),
	)
	vi.advanceTimersByTime(300_001)
	const results = await Promise.all(
		Array.from({ length: 100 }, () => resolve("one", "fixture")),
	)
	expect(load).toHaveBeenCalledTimes(2)
	expect(results.every((value) => value === first)).toBe(true)
	expect(first[0]?.useResponsesLite).toBe(true)
	release?.([{ slug: "fixture", useResponsesLite: false, raw: {} }])
	await tick()
	expect((await resolve("one", "fixture"))[0]?.useResponsesLite).toBe(false)
	// The earlier request keeps its original snapshot.
	expect(first[0]?.useResponsesLite).toBe(true)
})

test("refresh failures preserve good protocol metadata, back off, then recover", async () => {
	vi.useFakeTimers()
	const load = vi.fn(async () => models)
	const resolve = createModelCatalogCache<string>((auth) => auth, load)
	await resolve("one", "fixture")
	load.mockRejectedValue(new Error("offline"))
	vi.advanceTimersByTime(300_001)
	await resolve("one", "fixture")
	await tick()
	await resolve("one", "fixture")
	expect(load).toHaveBeenCalledTimes(2)
	vi.advanceTimersByTime(1_001)
	expect((await resolve("one", "fixture"))[0]?.useResponsesLite).toBe(true)
	await tick()
	expect(load).toHaveBeenCalledTimes(3)
	load.mockResolvedValue([
		{ slug: "fixture", useResponsesLite: false, raw: {} },
	])
	vi.advanceTimersByTime(2_001)
	await resolve("one", "fixture")
	await tick()
	expect((await resolve("one", "fixture"))[0]?.useResponsesLite).toBe(false)
})

test("cold start is single-flight, times out independently of callers, and rejects late results", async () => {
	vi.useFakeTimers()
	let release: ((value: CodexModelInfo[]) => void) | undefined
	let signal: AbortSignal | undefined
	const load = vi.fn((_auth: string, controller: AbortSignal) => {
		signal = controller
		return new Promise<CodexModelInfo[]>((done) => {
			release = done
		})
	})
	const resolve = createModelCatalogCache<string>((auth) => auth, load)
	const requests = Promise.allSettled([resolve("one"), resolve("one")])
	await tick()
	await vi.advanceTimersByTimeAsync(5_000)
	expect((await requests).every((result) => result.status === "rejected")).toBe(
		true,
	)
	expect(signal?.aborted).toBe(true)
	expect(load).toHaveBeenCalledTimes(1)
	release?.(models)
	await tick()
	await expect(resolve("one")).rejects.toMatchObject({
		code: "model_metadata_unavailable",
	})
})

test("expired and unknown-model snapshots cannot guess a wire protocol", async () => {
	vi.useFakeTimers()
	const load = vi.fn(async () => models)
	const resolve = createModelCatalogCache<string>((auth) => auth, load)
	await resolve("one")
	await expect(resolve("one", "missing")).rejects.toMatchObject({
		status: 400,
		code: "model_not_available",
	})
	expect(load).toHaveBeenCalledTimes(1)
	load.mockRejectedValue(new Error("offline"))
	vi.advanceTimersByTime(24 * 60 * 60 * 1_000)
	await expect(resolve("one", "fixture")).rejects.toBeInstanceOf(
		ModelMetadataError,
	)
})

test("accounts and effective FedRAMP partitions bootstrap separately", async () => {
	const load = vi.fn(async () => models)
	const resolve = createModelCatalogCache<string>((auth) => auth, load)
	await Promise.all([
		resolve("one:false"),
		resolve("one:true"),
		resolve("two:false"),
	])
	expect(load).toHaveBeenCalledTimes(3)
})
