# nano-banana-mcp

A Cloudflare Worker exposing Google's Gemini 2.5 Flash Image model ("nano banana") as an MCP tool, for use as a custom connector in Claude.ai.

Exposes one tool: `generate_image(prompt, aspect_ratio?, num_images?)`.

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
