# openai-oauth

[Docs](https://github.com/EvanZhouDev/openai-oauth#dev-proxy) | [GitHub](https://github.com/EvanZhouDev/openai-oauth) | [npm](https://www.npmjs.com/package/openai-oauth)

Turn your ChatGPT account into an OpenAI-compatible local API.

```bash
> npx openai-oauth

OpenAI-compatible endpoint ready at http://127.0.0.1:10531/v1
Use this as your OpenAI base URL. No API key is required.
Available Models: gpt-5.6-sol, gpt-5.6-terra, gpt-image-2, ...

[d] Run in background  [q] Quit
```

Press `d` to keep it running in the background or `q` to quit. You can also manage it directly:

```bash
npx openai-oauth --detach
npx openai-oauth status
npx openai-oauth logs --follow
npx openai-oauth stop
```

## Package Notes

`openai-oauth` exposes an OpenAI-compatible local endpoint backed by your ChatGPT account.

Supported endpoints:

- `/v1/responses`
- `/v1/responses/compact`
- `/v1/chat/completions`
- `/v1/images/generations`
- `/v1/images/edits`
- `/v1/models`

Native compaction accepts `model`, complete conversation `input`, and optional `instructions`. It uses the authenticated Codex V2 Responses transport with a `compaction_trigger`, requires a completed response containing one encrypted compaction item, and returns retained user/system/developer messages plus the encrypted state as the complete output window with usage under `object: "response.compaction"`. Replay that output window in the next Responses request and retain the original transcript separately. Server-side response references, caller-supplied triggers and tools are rejected; provider failures are returned without automatic retries or text-summary substitution.

Image generation uses JSON requests. Image editing uses the standard OpenAI multipart request with one or more `image` fields. Both return base64 image data and usage metadata.

```bash
curl http://127.0.0.1:10531/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"A tiny house in a forest","quality":"low"}'
```

Common flags:

| Config | Flag | Default |
| --- | --- | --- |
| Host binding | `--host` | `127.0.0.1` |
| Port | `--port` | `10531` |
| Model allowlist | `--models` | Account-specific Codex models discovered from ChatGPT |
| Auth file path | `--oauth-file` | `$CODEX_HOME/auth.json` or `~/.codex/auth.json` |
| Open browser | `--open` / `--no-open` | `--open` |
| Login timeout | `--login-timeout-ms` | `300000` |

Binding `--host` beyond loopback exposes the proxy to your network. Anyone who can reach that port can make requests with your ChatGPT account.

Login listens on loopback and uses `http://localhost:1455/auth/callback`, the local callback URL accepted by OpenAI OAuth.

The CLI pins the tested Codex protocol version (0.144.1); it never looks up npm latest in the request path. Advanced flags also exist for overriding it, the upstream Codex base URL, OAuth client id, and OAuth token URL.

## More

[Learn more in the openai-oauth README.](https://github.com/EvanZhouDev/openai-oauth#readme)

Model metadata is loaded before the CLI listens, even with a configured model list. Known models use an immutable last-good snapshot for up to 24 hours while stale metadata refreshes in the background. Refreshes are single-flight, time out after five seconds, and retry with exponential backoff (one to sixty seconds). A failed refresh preserves the last good protocol metadata. Cold or unknown-model requests require valid metadata and fail explicitly rather than guessing a wire format. Each transport isolates caches by upstream configuration and account/FedRAMP scope.
