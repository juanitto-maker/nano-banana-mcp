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
    "The result includes a publicly reachable URL for each image (valid for 24 hours) alongside the raw image content.",
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
        capabilities: { tools: {} },
        serverInfo: { name: "nano-banana-mcp", version: "1.0.0" },
      });

    case "tools/list":
      return jsonRpcResult(req.id, { tools: [TOOL_DEFINITION] });

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
