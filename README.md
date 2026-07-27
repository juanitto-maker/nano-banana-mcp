# nano-banana-mcp

A Cloudflare Worker exposing Google's Gemini 2.5 Flash Image model ("nano banana") as an MCP tool, for use as a custom connector in Claude.ai.

Exposes one tool: `generate_image(prompt, aspect_ratio?, num_images?)`.

Connector URL format (once deployed):
```
https://nano-banana-mcp.<subdomain>.workers.dev/<MCP_AUTH_TOKEN>/mcp
```

See DEPLOY.md for first-time setup.
