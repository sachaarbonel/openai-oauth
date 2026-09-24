# Responses Lite search rejection — 2026-09-24

## Evidence and limits

- Norilu's outgoing request guard verified exactly one `web_search` tool,
  `tool_choice: "required"`, streaming, and requested source evidence.
- The matching proxy diagnostic at 08:59:45.747 UTC reports an upstream HTTP
  400, `invalid_request_error`, `unsupported_value`, parameter `tools`.
- Its redacted outline says “only supports function tools custom tools and
  [redacted]”. The full message and final upstream tool list were not retained.
  **We cannot reconstruct the third allowed type.**
- Commit `a70a1f8` preserves hosted tools at the top level for Lite models.
  Its positive mock only checked that `tools` existed; it did not establish
  that the real upstream accepted `web_search`.

## Why a type rename is not an established fix

The [public Responses API guide](https://developers.openai.com/api/docs/guides/tools-web-search)
supports `web_search`. Its legacy `web_search_preview` type lacks domain
filters and some other controls. That public API contract is not proof of
compatibility with the ChatGPT OAuth Responses Lite route. Silently renaming
the tool or dropping filters would change the caller's requested behavior.

The inspected official Codex source is pinned to
`e269f2164cbb9f499e4f22301c393500e2a831f3` (September 17):

- [Lite tests](https://github.com/openai/codex/blob/e269f2164cbb9f499e4f22301c393500e2a831f3/codex-rs/core/tests/suite/responses_lite.rs):
  `responses_lite_uses_standalone_web_search_and_image_generation` expects
  **no top-level tools**, a namespaced `web.run` tool in `additional_tools`,
  and no hosted `web_search` tool.
- [Search tool executor](https://github.com/openai/codex/blob/e269f2164cbb9f499e4f22301c393500e2a831f3/codex-rs/ext/web-search/src/tool.rs):
  exposes a function schema, executes the selected commands, records search
  activity, and returns results to the model.
- [Search client](https://github.com/openai/codex/blob/e269f2164cbb9f499e4f22301c393500e2a831f3/codex-rs/codex-api/src/endpoint/search.rs):
  sends a separate authenticated POST to `alpha/search`.

This provides a concrete architecture to investigate, not proof that the
current account has access to that endpoint. Merely declaring a `web.run`
function does not execute searches. This proxy does not implement that executor.

## Changes in this branch

Opt-in diagnostics (`CODEX_OPENAI_RESPONSES_DIAGNOSTICS=1`) now report:

- `request.tools`: incoming top-level and `additional_tools` type summaries.
- `upstreamRequest`: actual post-normalization tool summaries and whether
  the Responses Lite header was set. This is captured immediately before fetch,
  not inferred by running a second copy of normalization.
- Public tool enum vocabulary in rejection outlines, including legacy search
  identifiers and the plural word `namespaces`. Unknown prose remains redacted.

Request-local async context isolates concurrent requests. No tool names,
schemas, arguments, queries, filters, input text, URLs, or credentials are
logged. Only allowlisted protocol type names, counts, and booleans are retained.
Body inspection is limited to existing string bodies of at most 1 Mi characters;
tool lists/input scanning are bounded. Unavailable/truncated capture is explicit.
The existing eight-request diagnostic cap and 16 KiB/one-second error inspection
limits remain. Successful SSE bodies are untouched. Transport and cancellation
signals are unchanged. No additional requests or automatic retries are added.

The new negative fixture exercises the actual core normalization and returns
synthetic `unsupported_value` / `tools` rejection fields. It verifies failure
propagation, request correlation, redaction, and a single model transport call.
It **does not simulate a successful live search or establish an allowed list**.

## Next step / deployment

Offline validation: `LIVE_CODEX_E2E=0 vitest run packages` passed 187 tests;
three live tests were skipped. Core build, CLI typecheck/build, targeted Biome
checks, and `git diff --check` passed. The root-wide Vitest invocation also
picked up two browser-extension suites that require `bun:test`; those cannot
run under Vitest, and Bun is not installed in this environment. They were not
claimed as passing. No live model/search requests were initiated.

Pull this branch on the Mac, rebuild core and the CLI using the existing build
procedure, and restart the existing proxy with opt-in diagnostics if a new
approved capture is needed. This commit does not restart the Mac or send a
live request. Restarting resets the diagnostic cap.

The functional search fix needs a separately tested executor/adapter, based on
the standalone route above or another explicitly configured search service.
It must preserve search restrictions, cancellation, budgets, source evidence,
and combined usage accounting across model/tool/model steps. Do not silently
drop the requested tool, remove `tool_choice`, swap models, or treat generic
HTTP fetching as a verified hosted search. Live endpoint access and an end-to-end
search still require an explicitly approved bounded test.

Rollback: revert this diagnostics commit and rebuild/restart. Request/tool
normalization is deliberately unchanged in this investigation.
