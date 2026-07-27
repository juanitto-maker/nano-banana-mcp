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

// MCP Apps (SEP-1865, extension id "io.modelcontextprotocol/ui"): predeclared ui:// resource,
// linked from the tool via _meta.ui.resourceUri, rendered in a sandboxed iframe by the host.
const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
const UI_MIME_TYPE = "text/html;profile=mcp-app";
const UI_RESOURCE_URI = "ui://nano-banana-mcp/generate-image-view";

// Static view template: performs the ui/initialize handshake, then renders whatever image
// URL(s) arrive via the host's "ui/notifications/tool-result" notification. No SDK dependency.
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
</style>
</head>
<body>
<div class="wrap" id="app"><div class="empty">Waiting for image...</div></div>
<script>
(function () {
  var nextId = 1;
  var pending = {};

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

  function render(urls) {
    var app = document.getElementById("app");
    if (!urls.length) {
      app.innerHTML = '<div class="empty">No image URL in result.</div>';
      return;
    }
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
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.jsonrpc !== "2.0") return;

    if (data.id !== undefined && (data.result !== undefined || data.error !== undefined)) {
      var p = pending[data.id];
      if (p) {
        delete pending[data.id];
        if (data.error) p.reject(new Error(data.error.message || "error"));
        else p.resolve(data.result);
      }
      return;
    }

    if (data.method === "ui/notifications/tool-result") {
      render(extractUrls(data.params && data.params.content));
    } else if (data.method === "ui/resource-teardown" && data.id !== undefined) {
      window.parent.postMessage({ jsonrpc: "2.0", id: data.id, result: {} }, "*");
    }
  });

  send("ui/initialize", {
    capabilities: {},
    clientInfo: { name: "nano-banana-mcp-view", version: "1.0.0" },
    protocolVersion: "2026-01-26",
    appCapabilities: { availableDisplayModes: ["inline"] }
  }).then(function () {
    notify("ui/notifications/initialized", {});
  });
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

async function callGemini(env: Env, prompt: string, aspectRatio: string, numImages: number) {
  const fullPrompt =
    numImages > 1
      ? `Generate ${numImages} distinct variations. ${prompt} (aspect ratio ${aspectRatio})`
      : `${prompt} (aspect ratio ${aspectRatio})`;

  const resp = await fetch(GEMINI_URL(env.GEMINI_API_KEY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
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
      return jsonRpcResult(req.id, { tools: [TOOL_DEFINITION] });

    case "resources/list":
      return jsonRpcResult(req.id, {
        resources: [
          {
            uri: UI_RESOURCE_URI,
            name: "Generated Image Viewer",
            description: "Inline MCP App view that renders the image(s) produced by generate_image.",
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
      if (name !== "generate_image") {
        return jsonRpcError(req.id, -32601, `Unknown tool: ${name}`);
      }
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

        const urls: string[] = [];
        for (const img of images) {
          const id = crypto.randomUUID().slice(0, 8);
          await env.IMAGES.put(`img:${id}`, img.data, {
            expirationTtl: IMAGE_TTL_SECONDS,
            metadata: { mimeType: img.mimeType },
          });
          urls.push(`${ctx.origin}/${ctx.token}/img/${id}`);
        }

        const content = [{ type: "text", text: urls.join("\n") }, ...images];
        return jsonRpcResult(req.id, { content, isError: false });
      } catch (err: any) {
        return jsonRpcResult(req.id, {
          isError: true,
          content: [{ type: "text", text: `generate_image failed: ${err.message || String(err)}` }],
        });
      }
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
