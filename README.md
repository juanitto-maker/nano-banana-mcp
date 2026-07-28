# nano-banana-mcp

A Cloudflare Worker exposing Google's Gemini 2.5 Flash Image model ("nano banana") as an MCP tool, for use as a custom connector in Claude.ai.

Exposes two tools: `generate_image(prompt, aspect_ratio?, count?, seed?, temperature?)` and `edit_image(image, instruction, aspect_ratio?, seed?, temperature?)`.

Connector URL format (once deployed):
```
https://nano-banana-mcp.<subdomain>.workers.dev/<MCP_AUTH_TOKEN>/mcp
```

See DEPLOY.md for first-time setup.

## Parameters

### `generate_image`

| Param | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `prompt` | string | yes | — | Description of the image. Style direction belongs here. |
| `aspect_ratio` | enum | no | `1:1` | One of `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`. |
| `count` | integer | no | `1` | 1–4. Each variation is a separate billed generation with its own URL. |
| `seed` | integer | no | random | int32. Same prompt + ratio + temperature + seed reproduces the same image. With `count > 1` the seed is incremented per variation (`seed`, `seed+1`, …). |
| `temperature` | number | no | model default | 0–2. Lower is more literal, higher more inventive. |

`num_images` is still accepted as a deprecated alias for `count`, so clients holding a cached copy of the old tool definition keep working.

### `edit_image`

| Param | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `image` | string | yes | — | Public HTTPS URL, or the 8-character id from a previous result. |
| `instruction` | string | yes | — | The edit to perform, e.g. "make it dusk". |
| `aspect_ratio` | enum | no | source framing | Same values as above. Omit to leave the framing alone. |
| `seed` | integer | no | random | int32, as above. |
| `temperature` | number | no | model default | 0–2, as above. |

An invalid enum value or an out-of-range number comes back as an `isError` result naming the valid values, without spending a Gemini call.

### How the parameters reach Gemini

All of them go into `generationConfig` on the `generateContent` body — the aspect ratio specifically into `generationConfig.imageConfig.aspectRatio`:

```json
{
  "contents": [...],
  "generationConfig": {
    "temperature": 0.9,
    "seed": 4821,
    "responseModalities": ["TEXT", "IMAGE"],
    "imageConfig": { "aspectRatio": "16:9" }
  }
}
```

`temperature` and `seed` are omitted from the body entirely when not supplied, so the model's own defaults apply. Earlier versions of this server instead appended `(aspect ratio 16:9)` to the prompt text, which left the ratio a suggestion the model was free to ignore — that is why 16:9 requests kept coming back square. `count` is handled as sequential `generateContent` calls rather than one call asking for N images, which the model answers inconsistently.

### Settings echo

Every image comes back as its own text content block: the URL on the first line, then the settings it was actually produced under, so the chat side can report them and reuse them in a follow-up request.

```
https://nano-banana-mcp.<subdomain>.workers.dev/<token>/img/8be62d09
variant 2/3 · 1376×768 (16:9) · seed 101 · temp 0.9
```

The resolution is read from the returned image's own header rather than assumed from the requested ratio, so if the model ignores the aspect ratio the line says so:

```
1024×1024 (16:9) ⚠ model returned a different aspect ratio than the requested 16:9
```

If a variation fails partway through a `count > 1` batch, the images already generated are still returned, with a trailing note naming the variation that failed and why.

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

If `aspect_ratio` is omitted, no `imageConfig` is sent at all and the source image's framing is preserved. Source images are capped at ~6 MB. Like `generate_image`, results are stored in KV and returned as URL(s) + raw image content, so edited images can themselves be passed back into `edit_image` by id for further edits.

## MCP Apps (inline rendering)

The server implements [MCP Apps](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) (SEP-1865, extension id `io.modelcontextprotocol/ui`) so hosts that support it — including Claude.ai/Claude Desktop — render the generated image inline as an embedded HTML view, instead of (or alongside) the plain-text URL and base64 fallback:

- The server advertises the extension in `initialize` (`capabilities.extensions["io.modelcontextprotocol/ui"]`) and declares `resources: {}`.
- `generate_image` and `edit_image` both link to a predeclared `ui://nano-banana-mcp/image-view/<VIEW_VERSION>/app.html` resource via `_meta.ui.resourceUri` on the tool definition. Hosts cache view HTML by URI, so `VIEW_VERSION` must be bumped whenever the view changes. The old unversioned URI (`ui://nano-banana-mcp/generate-image-view`) is still answered by `resources/read` for clients holding a stale reference.
- `resources/list` and `resources/read` serve that resource as a small static `text/html;profile=mcp-app` page with no external dependencies. The page performs the `ui/initialize` handshake over `postMessage`, then listens for the host's `ui/notifications/tool-result` notification and renders whatever image URL(s) it finds in the result's text content.
- Hosts that don't support MCP Apps simply ignore `_meta` and fall back to the plain-text URL + base64 image content, unchanged.

### Diagnostic overlay (`v5`)

The Claude Android client clamps the inline iframe to a fixed height and ignores our `ui/notifications/size-changed`, so the view currently ships as a self-measuring diagnostic: it reports the box it was actually given rather than trying to change it. Over the full-bleed image it draws a viewport/document/DPR readout (top-left, sampled on load, on resize, and every 500 ms for the first 5 s), a 50 px grid to count against when text is clipped, a 6 px magenta frame that reveals which edges are cut off, and four bottom-pinned 40 px swatches that show how much of the bottom edge is lost. Once the real dimensions are known, the overlay comes out and the layout gets designed to fit them.
