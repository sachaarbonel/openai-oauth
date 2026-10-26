import type { CodexModelInfo } from "./models.js"

const FRESH_MS = 5 * 60 * 1000
const MAX_STALE_MS = 24 * 60 * 60 * 1000
const REFRESH_TIMEOUT_MS = 5_000

export class ModelMetadataError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message)
	}
}

type Snapshot = {
	models: readonly CodexModelInfo[]
	loadedAt: number
}
type Entry = {
	snapshot?: Snapshot
	inflight?: Promise<Snapshot>
	failures: number
	retryAt: number
}

/**
 * Each transport owns its cache (base URL, pinned client version and fetch policy).
 * Account/FedRAMP scopes never share snapshots. A request keeps one snapshot for
 * its entire normalization; a failed refresh cannot change its wire protocol.
 */
export function createModelCatalogCache<Auth>(
	key: (auth: Auth) => string,
	load: (auth: Auth, signal: AbortSignal) => Promise<CodexModelInfo[]>,
) {
	const entries = new Map<string, Entry>()

	const refresh = (auth: Auth, entry: Entry): Promise<Snapshot> => {
		if (entry.inflight) return entry.inflight
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout>
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort()
				reject(new Error("Model metadata refresh timed out."))
			}, REFRESH_TIMEOUT_MS)
		})
		entry.inflight = Promise.race([
			Promise.resolve().then(() => load(auth, controller.signal)),
			timeout,
		])
			.then((models) => {
				if (!models.length) throw new Error("Empty model metadata.")
				const snapshot: Snapshot = {
					models: Object.freeze(models.map((model) => Object.freeze(model))),
					loadedAt: Date.now(),
				}
				entry.snapshot = snapshot
				entry.failures = 0
				entry.retryAt = 0
				return snapshot
			})
			.catch((error: unknown) => {
				entry.failures += 1
				entry.retryAt =
					Date.now() +
					Math.min(60_000, 1_000 * 2 ** Math.min(entry.failures - 1, 6))
				throw error
			})
			.finally(() => {
				clearTimeout(timer)
				entry.inflight = undefined
			})
		return entry.inflight
	}

	return async (
		auth: Auth,
		requiredModel?: string,
	): Promise<readonly CodexModelInfo[]> => {
		const scope = key(auth)
		let entry = entries.get(scope)
		if (!entry) {
			entry = { failures: 0, retryAt: 0 }
			entries.set(scope, entry)
		}
		const age = entry.snapshot ? Date.now() - entry.snapshot.loadedAt : Infinity
		const known =
			!requiredModel ||
			entry.snapshot?.models.some((model) => model.slug === requiredModel)

		if (entry.snapshot && age < MAX_STALE_MS && known) {
			if (age >= FRESH_MS && Date.now() >= entry.retryAt)
				void refresh(auth, entry).catch(() => {
					/* Keep the last good snapshot. */
				})
			return entry.snapshot.models
		}
		// A fresh catalog is authoritative for an unknown model. Do not guess its protocol.
		if (entry.snapshot && age < FRESH_MS && !known)
			throw new ModelMetadataError(
				400,
				"model_not_available",
				"The requested model is not in this account's model catalog.",
			)

		if (Date.now() < entry.retryAt)
			throw new ModelMetadataError(
				503,
				"model_metadata_unavailable",
				"Model metadata is temporarily unavailable. Please retry shortly.",
			)

		let snapshot: Snapshot
		try {
			snapshot = await refresh(auth, entry)
		} catch {
			throw new ModelMetadataError(
				503,
				"model_metadata_unavailable",
				"Model metadata is temporarily unavailable. Please retry shortly.",
			)
		}
		if (
			requiredModel &&
			!snapshot.models.some((model) => model.slug === requiredModel)
		)
			throw new ModelMetadataError(
				400,
				"model_not_available",
				"The requested model is not in this account's model catalog.",
			)
		return snapshot.models
	}
}
