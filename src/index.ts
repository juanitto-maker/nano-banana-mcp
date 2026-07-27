export interface Env {
  MCP_AUTH_TOKEN: string;
  GEMINI_API_KEY: string;
  IMAGES: KVNamespace;
}

const IMAGE_TTL_SECONDS = 86400;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}

// MCP Apps (SEP-1865, extension id "io.modelcontextprotocol/ui"): predeclared ui:// resource,
// linked from the tool via _meta.ui.resourceUri, rendered in a sandboxed iframe by the host.
const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
const UI_MIME_TYPE = "text/html;profile=mcp-app";
const UI_RESOURCE_URI = "ui://nano-banana-mcp/generate-image-view";

// Static view template: performs the ui/initialize handshake, then renders whatever image
// URL(s) or image content arrive from the host, tolerating several message shapes since hosts
// vary in how they deliver the tool result. No SDK dependency.
//
// Falls back to a small debug readout (last message methods received) if nothing rendered
// within 3s or the handshake itself is rejected, so delivery mismatches are diagnosable.
const UI_RESOURCE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: #0b0b0d; color: #e6e6e6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .wrap { padding: 12px; }
  img { display: block; width: 100%; height: auto; border-radius: 8px; margin-bottom: 8px; }
  .cap { display: block; font-size: 12px; color: #9aa0a6; text-decoration: none; word-break: break-all; margin-bottom: 14px; }
  .cap:hover { color: #c8cbcf; text-decoration: underline; }
  .empty { color: #9aa0a6; font-size: 13px; padding: 20px; text-align: center; }
  .debug { list-style: none; margin: 8px 12px 0; padding: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #7a8085; }
  .debug li { padding: 2px 0; border-bottom: 1px solid #1c1c1f; }
</style>
</head>
<body>
<div class="wrap" id="app"><div class="empty">Waiting for image...</div></div>
<script>
(function () {
  var nextId = 1;
  var pending = {};
  var recentMethods = [];
  var rendered = false;

  function send(method, params) {
    var id = nextId++;
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params || {} }, "*");
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
    });
  }

  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
  }

  function extractUrls(content) {
    var urls = [];
    (content || []).forEach(function (block) {
      if (block && block.type === "text" && typeof block.text === "string") {
        block.text.split("\\n").forEach(function (line) {
          line = line.trim();
          if (/^https?:\\/\\//.test(line)) urls.push(line);
        });
      }
    });
    return urls;
  }

  function extractImages(content) {
    var imgs = [];
    (content || []).forEach(function (block) {
      if (block && block.type === "image" && typeof block.data === "string") {
        imgs.push({ data: block.data, mimeType: block.mimeType || "image/png" });
      }
    });
    return imgs;
  }

  // Any object carrying a tool result may nest it directly as { content: [...] }, or
  // wrapped as { toolResult: { content: [...] } } depending on the host.
  function findContent(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (Array.isArray(obj.content)) return obj.content;
    if (obj.toolResult && Array.isArray(obj.toolResult.content)) return obj.toolResult.content;
    return null;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function logMessage(data) {
    var label = data.method
      ? data.method
      : data.id !== undefined
      ? "response(id=" + data.id + ")"
      : "unknown";
    recentMethods.push(label);
    if (recentMethods.length > 10) recentMethods.shift();
  }

  function showDebug() {
    if (rendered) return;
    var app = document.getElementById("app");
    var items = recentMethods.length
      ? recentMethods.map(function (m) { return "<li>" + escapeHtml(m) + "</li>"; }).join("")
      : "<li>(no messages received)</li>";
    app.innerHTML =
      '<div class="empty">No image received yet.<br>Last messages from host:</div>' +
      '<ul class="debug">' + items + "</ul>";
  }

  function render(urls) {
    var app = document.getElementById("app");
    app.innerHTML = "";
    urls.forEach(function (url) {
      var img = document.createElement("img");
      img.src = url;
      img.alt = "Generated image";
      var a = document.createElement("a");
      a.className = "cap";
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = url;
      app.appendChild(img);
      app.appendChild(a);
    });
    rendered = true;
  }

  function renderImages(imgs) {
    var app = document.getElementById("app");
    app.innerHTML = "";
    imgs.forEach(function (im) {
      var img = document.createElement("img");
      img.src = "data:" + im.mimeType + ";base64," + im.data;
      img.alt = "Generated image";
      app.appendChild(img);
    });
    rendered = true;
  }

  function handleContent(content) {
    var urls = extractUrls(content);
    if (urls.length) {
      render(urls);
      return;
    }
    var imgs = extractImages(content);
    if (imgs.length) renderImages(imgs);
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.jsonrpc !== "2.0") return;

    logMessage(data);

    if (data.id !== undefined && (data.result !== undefined || data.error !== undefined)) {
      var p = pending[data.id];
      if (p) {
        delete pending[data.id];
        if (data.error) p.reject(new Error(data.error.message || "error"));
        else p.resolve(data.result);
      }
      // Some hosts embed the tool result directly on the ui/initialize response
      // instead of (or in addition to) sending a separate tool-result notification.
      var resultContent = findContent(data.result);
      if (resultContent) handleContent(resultContent);
      return;
    }

    if (data.method === "ui/resource-teardown" && data.id !== undefined) {
      window.parent.postMessage({ jsonrpc: "2.0", id: data.id, result: {} }, "*");
      return;
    }

    // Accept the tool result regardless of the exact method name (e.g.
    // "ui/notifications/tool-result", "notifications/tool-result", "tools/result", ...) -
    // what matters is that params carry a content array.
    var paramsContent = findContent(data.params);
    if (paramsContent) handleContent(paramsContent);
  });

  send("ui/initialize", {
    capabilities: {},
    clientInfo: { name: "nano-banana-mcp-view", version: "1.0.0" },
    protocolVersion: "2026-01-26",
    appCapabilities: { availableDisplayModes: ["inline"] }
  }).then(
    function () {
      notify("ui/notifications/initialized", {});
    },
    function () {
      showDebug();
    }
  );

  setTimeout(showDebug, 3000);
})();
</script>
</body>
</html>
`;

const GEMINI_MODEL = "gemini-2.5-flash-image";
const GEMINI_URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: any;
}

function jsonRpcResult(id: string | number | null, result: any) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const TOOL_DEFINITION = {
  name: "generate_image",
  description:
    "Generate one or more images from a text prompt using Google's Gemini 2.5 Flash Image model (nano banana). " +
    "The result includes a publicly reachable URL for each image (valid for 24 hours) alongside the raw image content. " +
    "Each URL's trailing 8-character id can be passed to edit_image to make further edits to that image. " +
    "On hosts that support MCP Apps, the image also renders inline as an embedded HTML view.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the image to generate.",
      },
      aspect_ratio: {
        type: "string",
        enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
        description: "Desired aspect ratio. Defaults to 1:1.",
      },
      num_images: {
        type: "integer",
        minimum: 1,
        maximum: 4,
        description: "Number of images to generate (1-4). Defaults to 1.",
      },
    },
    required: ["prompt"],
  },
  _meta: {
    ui: {
      resourceUri: UI_RESOURCE_URI,
      visibility: ["model", "app"],
    },
  },
};

const EDIT_TOOL_DEFINITION = {
  name: "edit_image",
  description:
    "Edit an existing image with a natural-language instruction, using Google's Gemini 2.5 Flash Image model (nano banana). " +
    "The source image can be a public HTTPS URL or the 8-character id from a previous generate_image/edit_image result " +
    "(the trailing segment of its returned URL). The result includes a publicly reachable URL for each output image " +
    "(valid for 24 hours) alongside the raw image content. On hosts that support MCP Apps, the image also renders inline " +
    "as an embedded HTML view.",
  inputSchema: {
    type: "object",
    properties: {
      image: {
        type: "string",
        description:
          "A public HTTPS URL to the source image, or the 8-character id from a previous generate_image/edit_image result.",
      },
      instruction: {
        type: "string",
        description:
          'The edit to perform, e.g. "make it dusk", "remove the car", "change background to a beach".',
      },
      aspect_ratio: {
        type: "string",
        enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
        description: "Desired output aspect ratio. If omitted, the source image's framing is preserved.",
      },
    },
    required: ["image", "instruction"],
  },
  _meta: {
    ui: {
      resourceUri: UI_RESOURCE_URI,
      visibility: ["model", "app"],
    },
  },
};

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

async function callGeminiApi(env: Env, contents: any[]) {
  const resp = await fetch(GEMINI_URL(env.GEMINI_API_KEY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error (${resp.status}): ${errText}`);
  }

  const data: any = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const images = parts
    .filter((p: any) => p.inlineData?.data)
    .map((p: any) => ({
      type: "image",
      data: p.inlineData.data,
      mimeType: p.inlineData.mimeType || "image/png",
    }));

  if (images.length === 0) {
    throw new Error("Gemini returned no image data. Full response: " + JSON.stringify(data));
  }

  return images;
}

async function callGemini(env: Env, prompt: string, aspectRatio: string, numImages: number) {
  const fullPrompt =
    numImages > 1
      ? `Generate ${numImages} distinct variations. ${prompt} (aspect ratio ${aspectRatio})`
      : `${prompt} (aspect ratio ${aspectRatio})`;

  return callGeminiApi(env, [{ role: "user", parts: [{ text: fullPrompt }] }]);
}

async function callGeminiEdit(
  env: Env,
  source: { data: string; mimeType: string },
  instruction: string,
  aspectRatio?: string
) {
  const text = aspectRatio ? `${instruction} (aspect ratio ${aspectRatio})` : instruction;

  return callGeminiApi(env, [
    {
      role: "user",
      parts: [
        { inline_data: { mime_type: source.mimeType, data: source.data } },
        { text },
      ],
    },
  ]);
}

async function resolveSourceImage(
  env: Env,
  image: string
): Promise<{ data: string; mimeType: string } | { error: string }> {
  if (/^[a-z0-9-]{8}$/i.test(image)) {
    const { value, metadata } = await env.IMAGES.getWithMetadata<{ mimeType?: string }>(
      `img:${image}`,
      "text"
    );
    if (value === null) {
      return { error: "source image not found or expired" };
    }
    if (base64ByteLength(value) > MAX_IMAGE_BYTES) {
      return { error: `source image exceeds the ${MAX_IMAGE_BYTES} byte size limit` };
    }
    return { data: value, mimeType: metadata?.mimeType || "image/png" };
  }

  if (/^https?:\/\//i.test(image)) {
    let resp: Response;
    try {
      resp = await fetch(image);
    } catch (err: any) {
      return { error: `failed to fetch source image: ${err.message || String(err)}` };
    }
    if (!resp.ok) {
      return { error: `failed to fetch source image (HTTP ${resp.status})` };
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return { error: `source image exceeds the ${MAX_IMAGE_BYTES} byte size limit` };
    }
    const mimeType = resp.headers.get("Content-Type")?.split(";")[0].trim() || "image/png";
    return { data: bytesToBase64(new Uint8Array(buf)), mimeType };
  }

  return {
    error: "'image' must be an https:// URL or an 8-character id from a previous result",
  };
}

async function storeImagesAndBuildContent(
  env: Env,
  images: Array<{ type: string; data: string; mimeType: string }>,
  ctx: { origin: string; token: string }
) {
  const urls: string[] = [];
  for (const img of images) {
    const id = crypto.randomUUID().slice(0, 8);
    await env.IMAGES.put(`img:${id}`, img.data, {
      expirationTtl: IMAGE_TTL_SECONDS,
      metadata: { mimeType: img.mimeType },
    });
    urls.push(`${ctx.origin}/${ctx.token}/img/${id}`);
  }

  return [{ type: "text", text: urls.join("\n") }, ...images];
}

async function handleRpc(
  req: JsonRpcRequest,
  env: Env,
  ctx: { origin: string; token: string }
): Promise<any> {
  switch (req.method) {
    case "initialize":
      return jsonRpcResult(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
          resources: {},
          extensions: {
            [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] },
          },
        },
        serverInfo: { name: "nano-banana-mcp", version: "1.0.0" },
      });

    case "tools/list":
      return jsonRpcResult(req.id, { tools: [TOOL_DEFINITION, EDIT_TOOL_DEFINITION] });

    case "resources/list":
      return jsonRpcResult(req.id, {
        resources: [
          {
            uri: UI_RESOURCE_URI,
            name: "Generated Image Viewer",
            description:
              "Inline MCP App view that renders the image(s) produced by generate_image or edit_image.",
            mimeType: UI_MIME_TYPE,
          },
        ],
      });

    case "resources/read": {
      const uri = req.params?.uri;
      if (uri !== UI_RESOURCE_URI) {
        return jsonRpcError(req.id, -32602, `Unknown resource: ${uri}`);
      }
      return jsonRpcResult(req.id, {
        contents: [
          {
            uri: UI_RESOURCE_URI,
            mimeType: UI_MIME_TYPE,
            text: UI_RESOURCE_HTML,
            _meta: {
              ui: {
                csp: { resourceDomains: [ctx.origin] },
              },
            },
          },
        ],
      });
    }

    case "tools/call": {
      const { name, arguments: args } = req.params ?? {};

      if (name === "generate_image") {
        const prompt = args?.prompt;
        if (!prompt || typeof prompt !== "string") {
          return jsonRpcResult(req.id, {
            isError: true,
            content: [{ type: "text", text: "Missing required 'prompt' argument." }],
          });
        }
        const aspectRatio = args?.aspect_ratio || "1:1";
        const numImages = Math.min(Math.max(parseInt(args?.num_images ?? "1", 10) || 1, 1), 4);

        try {
          const images = await callGemini(env, prompt, aspectRatio, numImages);
          const content = await storeImagesAndBuildContent(env, images, ctx);
          return jsonRpcResult(req.id, { content, isError: false });
        } catch (err: any) {
          return jsonRpcResult(req.id, {
            isError: true,
            content: [{ type: "text", text: `generate_image failed: ${err.message || String(err)}` }],
          });
        }
      }

      if (name === "edit_image") {
        const image = args?.image;
        if (!image || typeof image !== "string") {
          return jsonRpcResult(req.id, {
            isError: true,
            content: [{ type: "text", text: "Missing required 'image' argument." }],
          });
        }
        const instruction = args?.instruction;
        if (!instruction || typeof instruction !== "string") {
          return jsonRpcResult(req.id, {
            isError: true,
            content: [{ type: "text", text: "Missing required 'instruction' argument." }],
          });
        }
        const aspectRatio = typeof args?.aspect_ratio === "string" ? args.aspect_ratio : undefined;

        try {
          const source = await resolveSourceImage(env, image);
          if ("error" in source) {
            return jsonRpcResult(req.id, {
              isError: true,
              content: [{ type: "text", text: source.error }],
            });
          }

          const images = await callGeminiEdit(env, source, instruction, aspectRatio);
          const content = await storeImagesAndBuildContent(env, images, ctx);
          return jsonRpcResult(req.id, { content, isError: false });
        } catch (err: any) {
          return jsonRpcResult(req.id, {
            isError: true,
            content: [{ type: "text", text: `edit_image failed: ${err.message || String(err)}` }],
          });
        }
      }

      return jsonRpcError(req.id, -32601, `Unknown tool: ${name}`);
    }

    default:
      return jsonRpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Expect path: /<MCP_AUTH_TOKEN>/mcp or /<MCP_AUTH_TOKEN>/img/<id>
    const parts = url.pathname.split("/").filter(Boolean);
    const token = parts[0];
    const endpoint = parts[1];

    if (!token || token !== env.MCP_AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (endpoint === "img") {
      const id = parts[2];
      if (request.method !== "GET" || !id) {
        return new Response("Method not allowed", { status: 405 });
      }

      const { value, metadata } = await env.IMAGES.getWithMetadata<{ mimeType?: string }>(
        `img:${id}`,
        "text"
      );
      if (value === null) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(base64ToBytes(value), {
        status: 200,
        headers: {
          "Content-Type": metadata?.mimeType || "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    if (endpoint !== "mcp") {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ ok: true, server: "nano-banana-mcp" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body: JsonRpcRequest;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify(jsonRpcError(null, -32700, "Parse error")),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const result = await handleRpc(body, env, { origin: url.origin, token });
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
