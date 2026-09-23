# Responses terminal output compatibility

## Failure and scope

A downstream capture on 2026-09-23 contained completed message and function-call
items in `response.output_item.done`, followed by `response.completed` with an
empty `response.output`. The Agents SDK consumed the terminal array, dispatched
no tool, and requested another response. The capture does not identify whether
the upstream service or an earlier adapter originally produced the empty array.

This fork previously reconstructed output only for non-streaming requests. The
shared core transport now applies the same completed-item reconciliation to SSE
responses. There is no model-, tool-name-, application-, or prompt-specific rule.
OAuth, model settings, runtime dependencies, and the existing cancellation patch
(`a6db455`) are unchanged.

The event contract is described in OpenAI's
[streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses)
and [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling).
The compatibility regression itself is established by the capture and the offline
SDK reproduction, not by an assumption about the OAuth upstream's implementation.

### Follow-up: valid null options rejected by a consumer

After this repair was deployed, the separately approved live test at
2026-09-23 16:42 UTC received both completed items in terminal output, and the SDK
normalized two items. It still stopped before command execution after one HTTP
200 response (1,293 reported tokens). The consumer's harness did not retain its
stopping exception, so that live failure's exact cause remains unconfirmed.

Offline investigation reproduced a concrete **consumer-side** failure in
Norilu's `SdkTurnEvents`: its `exec_command` event parser accepts omitted
`workdir` but throws a Zod validation error for `workdir: null`. The SDK's strict
tool schema permits that representation. OpenAI's
[strict-mode documentation](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)
describes nullable types for optional function fields.

The native Agents SDK handles these null options correctly before executing its
tool, but `run_item_stream_event.item.rawItem.arguments` still contains the wire
arguments. A consumer inspecting those raw events must accept their wire schema:

```ts
const args = z.object({
  cmd: z.string(),
  workdir: z.string().nullish(),
}).parse(JSON.parse(raw.arguments));
// Retain the existing working-directory fallback for omitted or null values.
const cwd = args.workdir ?? defaultWorkingDirectory;
```

This repair is now applied and tested locally in **Norilu**, not in the proxy.
Removing nulls globally in the proxy could destroy intentionally nullable domain
values or violate a tool's required-field schema. The transport must preserve
tool names, argument strings and call IDs; execution normalization belongs to
the schema-aware SDK or consumer adapter.

The new offline tests verify raw null preservation for streaming/non-streaming
responses and a complete native `SandboxAgent` tool round trip with nullable
options. The SDK receives nulls in the raw event, invokes the stub exactly once
with the optional values normalized, then sends the matching result and returns
a final answer. Before the consumer fix, the local Norilu reproduction recorded
`sdkPhase: events`, `failureKind: validation`, one approved command proposal and
zero executions. After the fix, the network-disabled Docker/Python fixture
completed with one proposal, one execution, two synthetic Responses calls and
no SDK failures. That establishes a real parser defect and an offline repair,
**not proof that the unretained live arguments contained nulls**. No new inference
request was made for this follow-up.

This follow-up adds regressions and investigation notes, not another proxy runtime
rewrite. Pull it to run the offline checks; a proxy restart alone cannot fix the
consumer's parser. Norilu's harness now retains its existing safe failure
classification and command-proposal count, without logging message text,
credentials or raw arguments. Neither application was deployed by this follow-up.

Initial repair verification on 2026-09-23: 182 repository tests passed (three live
tests skipped), plus both isolated Agents SDK fixtures. Lint, typecheck, full build, browser-bundle
checks, and release-artifact checks passed. No live model request or deployment
was performed for this patch.

Nullable-options follow-up verification: 184 repository tests passed (three live
tests skipped), plus all three isolated Agents SDK fixtures. Lint, typecheck and
the full build passed. This follow-up changes tests and documentation only.

## Repair policy

- Reconstruct only a successful `response.completed` with empty or absent output.
- Use only full `response.output_item.done` items. Never infer calls from text or
  concatenate argument deltas into an executable item.
- Preserve all item fields, including ids, call ids, arguments, message phase,
  reasoning metadata, and native/custom tool data. Order by `output_index`.
- Deduplicate identical done events. Fail closed on conflicting identities or
  content, duplicate call ids, missing indices, or unfinished items.
- Leave nonempty terminal output authoritative; do not append to a partially
  populated array. Failed/incomplete/cancelled responses are not reconstructed.
- EOF is not a substitute for a terminal response. Non-streaming errors no longer
  return previously collected items as if they were completed output.
- Forward text and other events incrementally. Only a repaired terminal event's
  data is rewritten; unrelated frames, comments, and event metadata are retained.
- The stream transform propagates cancellation/backpressure without a new tee.
  The existing optional in-memory replay-state capture remains separate; the
  HTTP server still disables replay state.
- Bound per-response accumulation to 4,096 output slots and 64 Mi characters of
  completed item JSON; the streaming frame buffer is limited to 32 Mi characters.
  Exceeding a limit errors the stream; it does not drop items and continue.

## Offline verification

Run from the repository root with Bun 1.3.11 and Node 20 or newer:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run turbo run build --filter=openai-oauth
bun run format-and-lint
bun run test
```

Typecheck builds workspace dependencies first; a clean checkout's React tests need
the web package built. Live tests stay skipped unless explicitly enabled. The
normal suite includes item ordering, native/custom items, duplicate/conflicting
events, UTF-8 and CRLF fragmentation, early text delivery, failure/EOF behavior,
backpressure, and the existing Node HTTP cancellation regressions.

### Exact Agents SDK fixture

Keep these compatibility-only dependencies outside the monorepo; do not upgrade
the proxy's OpenAI/Vercel SDK or Zod dependencies to run this test:

```sh
sdk_fixture_dir=$(mktemp -d)
npm install --prefix "$sdk_fixture_dir" --ignore-scripts --no-audit --no-fund \
  @openai/agents@0.18.0 @openai/agents-core@0.18.0 \
  @openai/agents-openai@0.18.0 openai@7.15.0 zod@4.6.2
node scripts/test-agents-sdk-responses.mjs "$sdk_fixture_dir"
```

Alternatively pass an existing project directory containing those versions.
The script uses the built HTTP fetch handler and the actual SDK decoder/runner
for a regular `Agent` and a `SandboxAgent` with native `exec_command`, including
nullable optional fields in the wire arguments.
Upstream responses, credentials, and sandbox execution are inert fixtures.
Global external fetch is forbidden and tracing is disabled. Each test permits at
most two mocked Responses requests and uses a five-second run abort deadline.
No actual shell command, model generation, account, or external connection is used.

The original two fixtures failed against the preceding build: no tool executed
before the second request. With the repaired build, all three invoke a stub once,
send the matching call result in stateless history, and reach the final answer. This is
an offline protocol check, not a claim that the live workflow has been completed.

## Mac deployment handoff

This commit does not restart or deploy the running proxy. After reviewing and
approving deployment in the Mac task:

1. Inspect the existing checkout and preserve any uncommitted work. Record the
   deployed commit, launch command, and process supervisor for rollback.
2. Fast-forward `codex/responses-sdk-compatibility` from the fork. Do not force
   reset local changes or replace the fork with the published npm package.
3. Install the unchanged lockfile, rebuild the CLI and its core dependencies, and
   run the offline checks above.
4. Restart only the existing fork-backed proxy on `127.0.0.1:10531`, preserving
   its authentication store and launch options. Keep the tunnel, OAuth settings,
   Cloudflare configuration, and hostname unchanged.
5. Check health and model listing without generating a response. Record the
   deployed commit so the server-side task knows which build is running.

A new live test needs separate approval. Suggested limit: one read-only fixture,
two Responses requests maximum, zero client retries, a 60-second request deadline,
and no connections, generated images, or external writes. If it fails, stop and
retain structural event metadata; do not start an automatic retry loop.

Rollback: restore the previously recorded fork build and restart it with the same
launch command. Do not remove the cancellation fix or change authentication as a
rollback shortcut.
