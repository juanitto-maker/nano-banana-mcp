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

// Reads pixel dimensions out of an encoded image's header so results can report the resolution
// the model actually produced, rather than the one that was asked for - the two diverge whenever
// Gemini ignores the requested aspect ratio. Returns null for formats it can't read, which only
// costs the dimensions in the echoed settings line.
function decodeImageSize(base64: string): { width: number; height: number } | null {
  // Only the leading header is needed; decoding whole multi-MB payloads here would be wasteful.
  // Sliced on a 4-character boundary so the remainder still decodes as valid base64.
  const prefix = base64.slice(0, 8192);
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(prefix.slice(0, prefix.length - (prefix.length % 4)));
  } catch {
    return null;
  }

  // PNG: 8-byte signature, then the IHDR chunk carrying width/height as big-endian uint32s.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // JPEG: walk the segment chain to the start-of-frame marker, which holds height then width.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      // Standalone markers (padding, RSTn, SOI, EOI) carry no length field.
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return {
          width: (bytes[i + 7] << 8) | bytes[i + 8],
          height: (bytes[i + 5] << 8) | bytes[i + 6],
        };
      }
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    }
  }

  return null;
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

// A tool-level failure: a normal JSON-RPC result carrying isError, per the MCP spec, so the
// client model sees the message and can correct itself rather than getting a protocol error.
function toolError(id: string | number | null, message: string) {
  return jsonRpcResult(id, { isError: true, content: [{ type: "text", text: message }] });
}

// The ten aspect ratios gemini-2.5-flash-image supports.
const ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];
const DEFAULT_ASPECT_RATIO = "1:1";
const MAX_COUNT = 4;
// Gemini's seed is an int32.
const SEED_MIN = -2147483648;
const SEED_MAX = 2147483647;

type Parsed<T> = { value: T } | { error: string };

function parseAspectRatio(raw: unknown): Parsed<string> {
  if (raw === undefined || raw === null) return { value: DEFAULT_ASPECT_RATIO };
  if (typeof raw !== "string" || !ASPECT_RATIOS.includes(raw)) {
    return {
      error: `Invalid 'aspect_ratio': ${JSON.stringify(raw)}. Valid values are ${ASPECT_RATIOS.join(
        ", "
      )}.`,
    };
  }
  return { value: raw };
}

// Optional aspect ratio: omitted means "leave the framing alone", which is what edit_image wants.
function parseOptionalAspectRatio(raw: unknown): Parsed<string | undefined> {
  if (raw === undefined || raw === null) return { value: undefined };
  return parseAspectRatio(raw);
}

// Numeric arguments arrive as JSON numbers from well-behaved clients, but some send strings;
// both are accepted, anything else is rejected with the valid range spelled out.
function toNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
  return NaN;
}

function parseCount(raw: unknown): Parsed<number> {
  if (raw === undefined || raw === null) return { value: 1 };
  const n = toNumber(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) {
    return {
      error: `Invalid 'count': ${JSON.stringify(raw)}. Must be an integer between 1 and ${MAX_COUNT}.`,
    };
  }
  return { value: n };
}

function parseSeed(raw: unknown): Parsed<number | undefined> {
  if (raw === undefined || raw === null) return { value: undefined };
  const n = toNumber(raw);
  if (!Number.isInteger(n) || n < SEED_MIN || n > SEED_MAX) {
    return {
      error: `Invalid 'seed': ${JSON.stringify(raw)}. Must be an integer between ${SEED_MIN} and ${SEED_MAX}.`,
    };
  }
  return { value: n };
}

function parseTemperature(raw: unknown): Parsed<number | undefined> {
  if (raw === undefined || raw === null) return { value: undefined };
  const n = toNumber(raw);
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    return {
      error: `Invalid 'temperature': ${JSON.stringify(raw)}. Must be a number between 0 and 2.`,
    };
  }
  return { value: n };
}

// Variants must differ from each other but stay reproducible, so each one bumps the base seed.
// Wraps at the int32 boundary instead of running off the end of the range Gemini accepts.
function seedForVariant(seed: number, index: number): number {
  const span = SEED_MAX - SEED_MIN + 1;
  return SEED_MIN + (((seed - SEED_MIN + index) % span) + span) % span;
}

// Every result must report the seed it used, so a caller who didn't supply one gets a seed
// picked here and sent to Gemini rather than letting the model choose one it never tells us -
// otherwise the seed is unknowable and the image can never be reproduced or refined.
// Non-negative half of the int32 range, which is friendlier to copy back into a follow-up call.
function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] >>> 1;
}

// Gemini's output resolutions are not exactly the nominal ratio (16:9 comes back as 1376x768),
// so the comparison needs slack; 5% is far tighter than any ratio-vs-ratio confusion.
function matchesAspectRatio(ratio: string, size: { width: number; height: number }): boolean {
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h || !size.width || !size.height) return true;
  const want = w / h;
  return Math.abs(want - size.width / size.height) / want <= 0.05;
}

// edit_image can be called without an aspect ratio, but the settings line should still name the
// framing that came back; the nearest supported ratio to the actual pixels is that answer.
function inferAspectRatio(size: { width: number; height: number }): string | null {
  if (!size.width || !size.height) return null;
  const actual = size.width / size.height;
  let best: string | null = null;
  let bestError = Infinity;
  for (const ratio of ASPECT_RATIOS) {
    const [w, h] = ratio.split(":").map(Number);
    const error = Math.abs(w / h - actual) / (w / h);
    if (error < bestError) {
      bestError = error;
      best = ratio;
    }
  }
  return bestError <= 0.05 ? best : null;
}

// The settings line echoed back with every image, e.g. "1024×576 (16:9) · seed 4821 · temp 0.9",
// so the chat side can report what was used and reuse it on a follow-up request. The seed is
// always known and always reported; the temperature reads "default" when the caller left the
// model's own choice in place, since there is no single number to name.
function formatSettings(opts: {
  size: { width: number; height: number } | null;
  requestedAspectRatio?: string;
  seed: number;
  temperature?: number;
}): string {
  const ratio =
    opts.requestedAspectRatio ?? (opts.size ? inferAspectRatio(opts.size) : null);
  const dims = opts.size ? `${opts.size.width}×${opts.size.height}` : null;

  const parts: string[] = [];
  if (dims && ratio) parts.push(`${dims} (${ratio})`);
  else if (dims) parts.push(dims);
  else if (ratio) parts.push(ratio);
  parts.push(`seed ${opts.seed}`);
  parts.push(opts.temperature !== undefined ? `temp ${opts.temperature}` : "temp default");

  let line = parts.join(" · ");
  const requested = opts.requestedAspectRatio;
  if (requested && opts.size && !matchesAspectRatio(requested, opts.size)) {
    line += ` ⚠ model returned a different aspect ratio than the requested ${requested}`;
  }
  return line;
}

const TOOL_DEFINITION = {
  name: "generate_image",
  description:
    "Generate one or more images from a text prompt using Google's Gemini 2.5 Flash Image model (nano banana). " +
    "The result includes a publicly reachable URL for each image (valid for 24 hours) alongside the raw image content. " +
    "Each image is returned with the settings it was produced under — resolution, aspect ratio, seed and " +
    "temperature — so those can be reported back to the user and reused in a follow-up request. " +
    "Each URL's trailing 8-character id can be passed to edit_image to make further edits to that image.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Text description of the image to generate. Detail helps: subject, setting, lighting, " +
          "camera or art style, mood. Style direction belongs here rather than in any other parameter.",
      },
      aspect_ratio: {
        type: "string",
        enum: ASPECT_RATIOS,
        description:
          "Framing of the output image. Landscape: 3:2, 4:3, 5:4, 16:9, 21:9 (21:9 is cinematic/ultrawide). " +
          "Portrait: 2:3, 3:4, 4:5, 9:16 (9:16 suits phone wallpapers and social stories). Square: 1:1. " +
          "Defaults to 1:1, so pass this explicitly whenever the image is not meant to be square.",
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: MAX_COUNT,
        description:
          "How many separate variations to generate, 1-4. Defaults to 1. Each variation is a full " +
          "billed generation from the same prompt and comes back with its own URL, so ask for more " +
          "than one only when the user wants options to choose between.",
      },
      seed: {
        type: "integer",
        description:
          "Seed for reproducible output. The same prompt, aspect ratio, temperature and seed give " +
          "back the same image, so pass a previous result's seed to reproduce or nudge that image. " +
          "Omit it for a fresh random result: a seed is then chosen server-side and reported back " +
          "with the image, so every result can be reproduced. With count > 1 the seed is " +
          "incremented per variation (seed, seed+1, ...), which is why the variations differ but " +
          "stay reproducible.",
      },
      temperature: {
        type: "number",
        minimum: 0,
        maximum: 2,
        description:
          "Sampling randomness, 0-2. Lower values (around 0.2-0.5) stay literal and close to the " +
          "prompt; higher values (around 1.0-1.5) are more inventive and varied. Omit to use the " +
          "model's own default.",
      },
    },
    required: ["prompt"],
  },
};

const EDIT_TOOL_DEFINITION = {
  name: "edit_image",
  description:
    "Edit an existing image with a natural-language instruction, using Google's Gemini 2.5 Flash Image model (nano banana). " +
    "The source image can be a public HTTPS URL or the 8-character id from a previous generate_image/edit_image result " +
    "(the trailing segment of its returned URL). The result includes a publicly reachable URL for each output image " +
    "(valid for 24 hours) alongside the raw image content, plus the settings it was produced under.",
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
        enum: ASPECT_RATIOS,
        description:
          "Reframe the output to this aspect ratio. Landscape: 3:2, 4:3, 5:4, 16:9, 21:9. " +
          "Portrait: 2:3, 3:4, 4:5, 9:16. Square: 1:1. Omit to preserve the source image's framing, " +
          "which is usually what an edit wants.",
      },
      seed: {
        type: "integer",
        description:
          "Seed for reproducible output. The same source, instruction, temperature and seed give " +
          "back the same edit. Omit for a fresh random result: a seed is then chosen server-side " +
          "and reported back with the image, so every edit can be reproduced.",
      },
      temperature: {
        type: "number",
        minimum: 0,
        maximum: 2,
        description:
          "Sampling randomness, 0-2. Lower values (around 0.2-0.5) apply the instruction " +
          "conservatively and stay closer to the source; higher values take more liberties. " +
          "Omit to use the model's own default.",
      },
    },
    required: ["image", "instruction"],
  },
};

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

interface GenerationParams {
  aspectRatio?: string;
  seed?: number;
  temperature?: number;
}

// Generation parameters belong in generationConfig, and the aspect ratio specifically in
// generationConfig.imageConfig.aspectRatio. Appending "(aspect ratio 16:9)" to the prompt text
// instead - as this server used to - makes the ratio a suggestion the model is free to ignore,
// which is why 16:9 requests kept coming back square.
async function callGeminiApi(env: Env, contents: any[], params: GenerationParams) {
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"],
  };
  if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
  if (params.seed !== undefined) generationConfig.seed = params.seed;
  if (params.aspectRatio) generationConfig.imageConfig = { aspectRatio: params.aspectRatio };

  const resp = await fetch(GEMINI_URL(env.GEMINI_API_KEY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig }),
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

// One call produces one variation. Multiple variations are separate sequential calls (see the
// generate_image handler) rather than one call asking the model for N images, which it answers
// inconsistently.
async function callGemini(env: Env, prompt: string, params: GenerationParams) {
  return callGeminiApi(env, [{ role: "user", parts: [{ text: prompt }] }], params);
}

async function callGeminiEdit(
  env: Env,
  source: { data: string; mimeType: string },
  instruction: string,
  params: GenerationParams
) {
  return callGeminiApi(
    env,
    [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: source.mimeType, data: source.data } },
          { text: instruction },
        ],
      },
    ],
    params
  );
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

async function storeImage(
  env: Env,
  img: { data: string; mimeType: string },
  ctx: { origin: string; token: string }
): Promise<string> {
  const id = crypto.randomUUID().slice(0, 8);
  await env.IMAGES.put(`img:${id}`, img.data, {
    expirationTtl: IMAGE_TTL_SECONDS,
    metadata: { mimeType: img.mimeType },
  });
  return `${ctx.origin}/${ctx.token}/img/${id}`;
}

// One text block per image: URL on its own first line, then the settings actually used. The raw
// image blocks follow, for hosts that render base64 directly.
function buildImageBlock(url: string, settings: string) {
  return { type: "text", text: `${url}\n${settings}` };
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
        },
        serverInfo: { name: "nano-banana-mcp", version: "1.0.0" },
      });

    case "tools/list":
      return jsonRpcResult(req.id, { tools: [TOOL_DEFINITION, EDIT_TOOL_DEFINITION] });

    case "tools/call": {
      const { name, arguments: args } = req.params ?? {};

      if (name === "generate_image") {
        const prompt = args?.prompt;
        if (!prompt || typeof prompt !== "string") {
          return toolError(req.id, "Missing required 'prompt' argument.");
        }

        const aspectRatio = parseAspectRatio(args?.aspect_ratio);
        if ("error" in aspectRatio) return toolError(req.id, aspectRatio.error);
        // `num_images` is the pre-rename name for `count`, still accepted so clients holding a
        // cached copy of the old tool definition keep getting the number of images they asked for.
        const count = parseCount(args?.count ?? args?.num_images);
        if ("error" in count) return toolError(req.id, count.error);
        const seed = parseSeed(args?.seed);
        if ("error" in seed) return toolError(req.id, seed.error);
        const temperature = parseTemperature(args?.temperature);
        if ("error" in temperature) return toolError(req.id, temperature.error);

        // A caller who didn't pick a seed still gets one, so the result stays reproducible.
        const baseSeed = seed.value ?? randomSeed();

        const textBlocks: any[] = [];
        const imageBlocks: any[] = [];
        let failure: { variant: number; message: string } | null = null;

        for (let i = 0; i < count.value; i++) {
          const variantSeed = seedForVariant(baseSeed, i);
          const params: GenerationParams = {
            aspectRatio: aspectRatio.value,
            seed: variantSeed,
            temperature: temperature.value,
          };

          let images: Array<{ type: string; data: string; mimeType: string }>;
          try {
            images = await callGemini(env, prompt, params);
          } catch (err: any) {
            failure = { variant: i + 1, message: err.message || String(err) };
            break;
          }

          for (const img of images) {
            const url = await storeImage(env, img, ctx);
            const settings = formatSettings({
              size: decodeImageSize(img.data),
              requestedAspectRatio: aspectRatio.value,
              seed: variantSeed,
              temperature: temperature.value,
            });
            textBlocks.push(
              buildImageBlock(
                url,
                count.value > 1 ? `variant ${i + 1}/${count.value} · ${settings}` : settings
              )
            );
            imageBlocks.push(img);
          }
        }

        if (imageBlocks.length === 0) {
          const detail = failure
            ? count.value > 1
              ? `variant ${failure.variant}/${count.value}: ${failure.message}`
              : failure.message
            : "Gemini returned no image data.";
          return toolError(req.id, `generate_image failed: ${detail}`);
        }

        const content = [...textBlocks, ...imageBlocks];
        // Every variant is a separate billed call, so a mid-run failure still returns whatever
        // was already generated instead of discarding it.
        if (failure) {
          content.push({
            type: "text",
            text: `Stopped after ${imageBlocks.length} of ${count.value} variants — variant ${failure.variant} failed: ${failure.message}`,
          });
        }
        return jsonRpcResult(req.id, { content, isError: false });
      }

      if (name === "edit_image") {
        const image = args?.image;
        if (!image || typeof image !== "string") {
          return toolError(req.id, "Missing required 'image' argument.");
        }
        const instruction = args?.instruction;
        if (!instruction || typeof instruction !== "string") {
          return toolError(req.id, "Missing required 'instruction' argument.");
        }

        const aspectRatio = parseOptionalAspectRatio(args?.aspect_ratio);
        if ("error" in aspectRatio) return toolError(req.id, aspectRatio.error);
        const seed = parseSeed(args?.seed);
        if ("error" in seed) return toolError(req.id, seed.error);
        const temperature = parseTemperature(args?.temperature);
        if ("error" in temperature) return toolError(req.id, temperature.error);

        try {
          const source = await resolveSourceImage(env, image);
          if ("error" in source) {
            return toolError(req.id, source.error);
          }

          // As in generate_image: always send a known seed, so the edit can be reproduced.
          const effectiveSeed = seed.value ?? randomSeed();
          const params: GenerationParams = {
            aspectRatio: aspectRatio.value,
            seed: effectiveSeed,
            temperature: temperature.value,
          };
          const images = await callGeminiEdit(env, source, instruction, params);

          const textBlocks: any[] = [];
          for (const img of images) {
            const url = await storeImage(env, img, ctx);
            textBlocks.push(
              buildImageBlock(
                url,
                formatSettings({
                  size: decodeImageSize(img.data),
                  requestedAspectRatio: aspectRatio.value,
                  seed: effectiveSeed,
                  temperature: temperature.value,
                })
              )
            );
          }
          return jsonRpcResult(req.id, { content: [...textBlocks, ...images], isError: false });
        } catch (err: any) {
          return toolError(req.id, `edit_image failed: ${err.message || String(err)}`);
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
