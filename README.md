# image-relay-mcp

A tiny MCP server with one job: fetch an image from an allowed host
(Hugging Face Space outputs) server-side, and hand it back as inline
image content — so Claude gets the bytes directly through the MCP
connector, without going through its code-execution sandbox's
domain-restricted network.

Tested locally with `@modelcontextprotocol/sdk` v1.29 and Node 18+.

## Why this works

Claude's code-execution sandbox (the one used to build files) only has
outbound access to a small package-manager allowlist. Custom MCP
connectors are a *separate* path — they run on your own server, so they
have normal internet access. This tool exploits that: it does the
fetching on your infrastructure, then returns the result as an MCP
`image` content block, which Claude can read directly from the tool
result.

## Files

- `server.js` — the whole thing. One tool: `fetch_image({ url })`.
- `test-client.mjs` — local smoke test, talks to `localhost:3000/mcp`.
- `package.json` — two dependencies: `@modelcontextprotocol/sdk`, `express`.

## Security notes (read before deploying)

- **Host allowlist**: `ALLOWED_HOST_SUFFIXES` in `server.js` restricts
  which domains this will fetch from. It ships set to `.hf.space` and
  `huggingface.co`. Don't widen this to arbitrary URLs — an open
  fetch-any-URL relay is an SSRF vector.
- **Optional auth**: set the `RELAY_AUTH_TOKEN` env var on your host to
  require a `Authorization: Bearer <token>` header. Recommended once
  this is public, since anyone with the URL could otherwise call it.
- **Size cap**: hard-capped at 15MB per image (`MAX_BYTES`) so nothing
  huge gets base64-encoded into a response.
- Stateless by design (`sessionIdGenerator: undefined`) — no server-side
  session state to leak or clean up.

## Run locally

```bash
npm install
npm start
# listening on :3000, POST /mcp
node test-client.mjs   # optional smoke test
```

## Deploy (pick one — all have a free tier)

Any plain Node 18+ host works, since this only needs `express` + fetch.

**Render (easiest, free web service):**
1. Push this folder to a GitHub repo.
2. render.com → New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Once live, your MCP endpoint is `https://<your-app>.onrender.com/mcp`.

**Railway / Fly.io:** same idea — Node buildpack, expose `$PORT`, start
command `npm start`.

**Your own VPS:** `npm install --production && RELAY_AUTH_TOKEN=xxx npm start`
behind a reverse proxy (Caddy/nginx) for TLS.

## Connect it to Claude

1. claude.ai → Settings → Connectors → **Add custom connector**
2. URL: `https://<your-deployed-host>/mcp`
3. If you set `RELAY_AUTH_TOKEN`, add it as a header/auth value when the
   connector setup prompts for one.
4. In a chat: "use my image-relay connector to fetch <hf.space url>" —
   or just paste the url once it's a named tool Claude can see.

Note: custom connectors require a paid Claude plan (Pro or above).
