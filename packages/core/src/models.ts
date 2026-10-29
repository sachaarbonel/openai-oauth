import { isRecord } from "./utils.js"

export const DEFAULT_CODEX_CLIENT_VERSION = "0.164.0"

type FetchLike = typeof fetch

export type CodexModelInfo = {
	slug: string
	visibility?: string
	supportedInApi?: boolean
	minimalClientVersion?: string
	useResponsesLite?: boolean
	preferWebsockets?: boolean
	supportVerbosity?: boolean
	defaultVerbosity?: string
	defaultReasoningLevel?: string
	defaultReasoningSummary?: string
	supportsParallelToolCalls?: boolean
	availableInPlans?: string[]
	raw: Record<string, unknown>
}

export type ResolveCodexClientVersionOptions = {
	codexVersion?: string
	fetchImpl?: FetchLike
	onWarning?: (message: string) => void
}

export type FetchCodexModelCatalogOptions = ResolveCodexClientVersionOptions

export type CodexModelCatalogClient = {
	request(path: string, init?: RequestInit): Promise<Response>
}

const normalizeVersion = (value: unknown): string | undefined => {
	if (typeof value !== "string") {
		return undefined
	}

	return value.trim().match(/\b\d+\.\d+\.\d+\b/)?.[0]
}

const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined

const optionalBoolean = (value: unknown): boolean | undefined =>
	typeof value === "boolean" ? value : undefined

const optionalStrings = (value: unknown): string[] | undefined =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: undefined

const toCodexModelInfo = (value: unknown): CodexModelInfo | undefined => {
	if (!isRecord(value)) {
		return undefined
	}

	const slug = optionalString(value.slug)
	if (!slug) {
		return undefined
	}

	return {
		slug,
		visibility: optionalString(value.visibility),
		supportedInApi: optionalBoolean(value.supported_in_api),
		minimalClientVersion: optionalString(value.minimal_client_version),
		useResponsesLite: optionalBoolean(value.use_responses_lite),
		preferWebsockets: optionalBoolean(value.prefer_websockets),
		supportVerbosity: optionalBoolean(value.support_verbosity),
		defaultVerbosity: optionalString(value.default_verbosity),
		defaultReasoningLevel: optionalString(value.default_reasoning_level),
		defaultReasoningSummary: optionalString(value.default_reasoning_summary),
		supportsParallelToolCalls: optionalBoolean(
			value.supports_parallel_tool_calls,
		),
		availableInPlans: optionalStrings(value.available_in_plans),
		raw: value,
	}
}

const toUpstreamErrorMessage = (bodyText: string): string => {
	if (!bodyText) {
		return "Failed to load models from Codex."
	}

	try {
		const parsed = JSON.parse(bodyText)
		if (isRecord(parsed)) {
			if (typeof parsed.detail === "string" && parsed.detail.length > 0) {
				return parsed.detail
			}
			if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
				return parsed.error.message
			}
		}
	} catch {}

	return bodyText
}

/** Override explicitly only after testing the corresponding Codex wire protocol. */
export const resolveCodexClientVersion = async (
	options: ResolveCodexClientVersionOptions = {},
): Promise<string> =>
	normalizeVersion(options.codexVersion) ?? DEFAULT_CODEX_CLIENT_VERSION

/** Retained for consumers which reset the former discovery cache. */
export const resetCodexClientVersionCache = (): void => {}

export const fetchCodexModelCatalog = async (
	client: CodexModelCatalogClient,
	options: FetchCodexModelCatalogOptions = {},
): Promise<CodexModelInfo[]> => {
	const clientVersion = await resolveCodexClientVersion(options)
	const response = await client.request(
		`/models?client_version=${encodeURIComponent(clientVersion)}`,
	)
	const bodyText = await response.text()

	if (!response.ok) {
		throw new Error(toUpstreamErrorMessage(bodyText))
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(bodyText)
	} catch {
		throw new Error("Codex returned an invalid models response.")
	}

	if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
		throw new Error("Codex returned a malformed models response.")
	}

	const models = parsed.models
		.map(toCodexModelInfo)
		.filter((model): model is CodexModelInfo => model !== undefined)
	if (models.length === 0) {
		throw new Error("Codex returned an empty models list.")
	}

	return models
}

export const isPublicCodexModel = (model: CodexModelInfo): boolean =>
	model.supportedInApi !== false &&
	(model.visibility === undefined || model.visibility === "list")
