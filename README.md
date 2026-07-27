# nano-banana-mcp

A Cloudflare Worker exposing Google's Gemini 2.5 Flash Image model ("nano banana") as an MCP tool, for use as a custom connector in Claude.ai.

Exposes two tools: `generate_image(prompt, aspect_ratio?, num_images?)` and `edit_image(image, instruction, aspect_ratio?)`.

Connector URL format (once deployed):
```
https://nano-banana-mcp.<subdomain>.workers.dev/<MCP_AUTH_TOKEN>/mcp
```

See DEPLOY.md for first-time setup.

## Image URLs

Since Claude.ai doesn't render raw base64 image blocks from custom MCP connectors, `generate_image` also stores each generated image in a Workers KV namespace (`IMAGES`) and returns a public URL alongside the base64 content:

```
https://nano-banana-mcp.<subdomain>.workers.dev/<MCP_AUTH_TOKEN>/img/<id>
```

- Each image is available at its URL for **24 hours**, after which it expires from KV and the route returns a 404.
- The URL is auth-gated the same way as `/mcp`: the token must match `MCP_AUTH_TOKEN`.

## Editing

`edit_image` edits an existing image with a natural-language instruction, using the same Gemini 2.5 Flash Image model. The source `image` argument accepts either:

- a public HTTPS URL to an image, or
- the 8-character id from a previous `generate_image`/`edit_image` result (the trailing segment of its returned `/img/<id>` URL).

If `aspect_ratio` is omitted, the source image's framing is preserved. Source images are capped at ~6 MB. Like `generate_image`, results are stored in KV and returned as URL(s) + raw image content, so edited images can themselves be passed back into `edit_image` by id for further edits.

## MCP Apps (inline rendering)

The server implements [MCP Apps](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) (SEP-1865, extension id `io.modelcontextprotocol/ui`) so hosts that support it — including Claude.ai/Claude Desktop — render the generated image inline as an embedded HTML view, instead of (or alongside) the plain-text URL and base64 fallback:

- The server advertises the extension in `initialize` (`capabilities.extensions["io.modelcontextprotocol/ui"]`) and declares `resources: {}`.
- `generate_image` and `edit_image` both link to a predeclared `ui://nano-banana-mcp/generate-image-view` resource via `_meta.ui.resourceUri` on the tool definition.
- `resources/list` and `resources/read` serve that resource as a small static `text/html;profile=mcp-app` page with no external dependencies. The page performs the `ui/initialize` handshake over `postMessage`, then listens for the host's `ui/notifications/tool-result` notification and renders whatever image URL(s) it finds in the result's text content.
- Hosts that don't support MCP Apps simply ignore `_meta` and fall back to the plain-text URL + base64 image content, unchanged.
