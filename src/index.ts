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

// MCP Apps (SEP-1865, extension id "io.modelcontextprotocol/ui"): predeclared ui:// resource,
// linked from the tool via _meta.ui.resourceUri, rendered in a sandboxed iframe by the host.
const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
const UI_MIME_TYPE = "text/html;profile=mcp-app";

// Claude.ai caches view HTML by URI — bump VIEW_VERSION whenever UI_RESOURCE_HTML changes, so
// the resource URI changes too and clients fetch the new HTML instead of a cached stale view.
const VIEW_VERSION = "v5";
const UI_RESOURCE_URI = `ui://nano-banana-mcp/image-view/${VIEW_VERSION}/app.html`;
// Compat alias: the URI this server used before it was versioned. Some clients may have cached
// a tool definition or resource reference pointing at this URI - resources/read still answers
// it (with the current HTML) so those clients don't break. Not advertised in resources/list.
const UI_RESOURCE_URI_LEGACY = "ui://nano-banana-mcp/generate-image-view";

// Static view template: performs the ui/initialize handshake, then renders whatever image
// URL(s) or image content arrive from the host, tolerating several message shapes since hosts
// vary in how they deliver the tool result. No SDK dependency.
//
// Falls back to a small debug readout (last message methods received) if nothing rendered
// within 3s or the handshake itself is rejected, so delivery mismatches are diagnosable.
//
// DIAGNOSTIC BUILD: the Claude Android client clamps the inline iframe to a fixed height and
// ignores ui/notifications/size-changed, so this view measures the box it is actually given
// instead of trying to resize it. Overlaid on the image are: a viewport/document/DPR readout,
// a 50px grid (count the cells if the text is clipped), a magenta frame border (visible only
// if our top and bottom edges survive), and four bottom-pinned swatches (a missing swatch
// tells us how much of the bottom edge the host cut off).
const UI_RESOURCE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: #111; color: #e6e6e6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

  /* Outermost element: the magenta frame. If a magenta edge is missing, that edge is clipped. */
  #root { position: fixed; inset: 0; box-sizing: border-box; border: 6px solid magenta; background: #111; overflow: hidden; }

  /* Image, full-bleed behind every diagnostic layer. */
  .wrap { position: absolute; inset: 0; display: flex; flex-direction: row; align-items: center; justify-content: center; z-index: 1; }
  img { flex: 1 1 0; min-width: 0; min-height: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
  img.expandable { cursor: pointer; }
  .empty { color: #9aa0a6; font-size: 13px; padding: 20px; text-align: center; }
  .debug { list-style: none; margin: 8px 12px 0; padding: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #7a8085; }
  .debug li { padding: 2px 0; border-bottom: 1px solid #1c1c1f; }

  /* 50px reference grid - a countable ruler for when the numeric readout is cut off. */
  #grid {
    position: absolute; inset: 0; z-index: 2; pointer-events: none;
    background-image:
      repeating-linear-gradient(to right, rgba(255,255,255,0.25) 0 1px, transparent 1px 50px),
      repeating-linear-gradient(to bottom, rgba(255,255,255,0.25) 0 1px, transparent 1px 50px);
  }

  /* Measurement readout, pinned top-left, outlined so it reads over any image. */
  #diag {
    position: absolute; top: 0; left: 0; z-index: 4; pointer-events: none;
    margin: 0; padding: 6px 10px;
    white-space: pre;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: clamp(14px, 5vw, 28px);
    font-weight: 800;
    line-height: 1.15;
    color: #fff;
    text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 0 6px #000;
  }

  /* Bottom-edge probe: whichever swatch is missing tells us where the bottom got cut. */
  #swatches { position: absolute; left: 0; right: 0; bottom: 0; height: 40px; z-index: 3; display: flex; pointer-events: none; }
  #swatches div { flex: 1 1 0; height: 40px; }
  #swatches .s1 { background: #ff0000; }
  #swatches .s2 { background: #00c000; }
  #swatches .s3 { background: #0066ff; }
  #swatches .s4 { background: #ffee00; }

  #closeBtn {
    display: none;
    position: absolute;
    top: 8px;
    right: 8px;
    width: 44px;
    height: 44px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: 20px;
    line-height: 1;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 5;
  }

  /* Lightbox: host granted the fullscreen display mode we requested on tap. */
  html.fullscreen-mode, html.fullscreen-mode body, html.fullscreen-mode #root { background: #000; }
  html.fullscreen-mode #closeBtn { display: flex; }
</style>
</head>
<body>
<div id="root">
  <div class="wrap" id="app"><div class="empty">Waiting for image...</div></div>
  <div id="grid"></div>
  <div id="swatches"><div class="s1"></div><div class="s2"></div><div class="s3"></div><div class="s4"></div></div>
  <pre id="diag">VP  ? x ?
DOC ? x ?
DPR ?</pre>
  <button type="button" id="closeBtn" aria-label="Close fullscreen">&#10005;</button>
</div>
<script>
(function () {
  var nextId = 1;
  var pending = {};
  var recentMethods = [];
  var rendered = false;

  function send(method, params) {
    var id = nextId++;
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params || {} }, "*");
    var promise = new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
    });
    promise.requestId = id;
    return promise;
  }

  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
  }

  // hostContext/hostCapabilities (SEP-1865) are captured from the ui/initialize result;
  // hostContext is kept in sync afterwards via ui/notifications/host-context-changed. The
  // lightbox has no state of its own - it's driven entirely by hostContext.displayMode, so a
  // host that force-returns to "inline" on its own is reflected automatically, no separate
  // bookkeeping needed.
  var hostContext = {};
  var hostCapabilities = {};
  var initializeRequestId = null;

  function fullscreenAvailable() {
    var modes = hostContext.availableDisplayModes || [];
    return modes.indexOf("fullscreen") !== -1;
  }

  function applyLayout() {
    document.documentElement.classList.toggle("fullscreen-mode", hostContext.displayMode === "fullscreen");
  }

  function applyHostContext(partial) {
    if (!partial || typeof partial !== "object") return;
    for (var key in partial) {
      if (Object.prototype.hasOwnProperty.call(partial, key)) hostContext[key] = partial[key];
    }
    applyLayout();
  }

  function applyInitializeResult(result) {
    if (!result) return;
    hostCapabilities = result.hostCapabilities || {};
    applyHostContext(result.hostContext);
  }

  function requestDisplayMode(mode) {
    send("ui/request-display-mode", { mode: mode }).then(function (result) {
      hostContext.displayMode = (result && result.mode) || hostContext.displayMode || "inline";
      applyLayout();
    });
  }

  document.getElementById("closeBtn").addEventListener("click", function () {
    requestDisplayMode("inline");
  });

  // Views MUST report their rendered size so the host can grow the iframe to fit, since the
  // host has no other way to know the content outgrew its initial (often short) default frame.
  // Debounced because img.onload and window "resize" can both fire in quick bursts.
  var sizeReportTimer = null;
  function reportSize() {
    if (sizeReportTimer) clearTimeout(sizeReportTimer);
    sizeReportTimer = setTimeout(function () {
      sizeReportTimer = null;
      notify("ui/notifications/size-changed", {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight
      });
    }, 100);
  }

  // Self-measurement. The host clamps the inline iframe and ignores the size-changed
  // notification above, so we report back the box we were actually handed. Sampled on a timer
  // as well as on load/resize because the host may resize the frame after first paint without
  // always firing a "resize" event we can observe.
  function updateDiag() {
    var el = document.getElementById("diag");
    if (!el) return;
    el.textContent =
      "VP  " + window.innerWidth + " x " + window.innerHeight + "\\n" +
      "DOC " + document.documentElement.clientWidth + " x " + document.documentElement.clientHeight + "\\n" +
      "DPR " + (window.devicePixelRatio || 1);
  }

  var diagTimer = setInterval(updateDiag, 500);
  setTimeout(function () { clearInterval(diagTimer); }, 5000);
  window.addEventListener("load", updateDiag);
  updateDiag();

  window.addEventListener("resize", function () {
    updateDiag();
    reportSize();
  });

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
    var box = document.createElement("div");
    box.innerHTML =
      '<div class="empty">No image received yet.<br>Last messages from host:</div>' +
      '<ul class="debug">' + items + "</ul>";
    app.innerHTML = "";
    app.appendChild(box);
  }

  // Tap behavior, in priority order: request fullscreen if the host offers it (shows the
  // lightbox once granted); otherwise ask the host to open the image's public URL, if it has
  // one and the host supports it; otherwise the image just isn't interactive.
  function attachTap(img, url) {
    if (fullscreenAvailable()) {
      img.className = "expandable";
      img.addEventListener("click", function () {
        requestDisplayMode("fullscreen");
      });
    } else if (url && hostCapabilities.openLinks) {
      img.className = "expandable";
      img.addEventListener("click", function () {
        send("ui/open-link", { url: url }).catch(function () {});
      });
    }
  }

  function render(urls) {
    var app = document.getElementById("app");
    app.innerHTML = "";
    urls.forEach(function (url) {
      var img = document.createElement("img");
      img.onload = reportSize;
      img.src = url;
      img.alt = "Generated image";
      attachTap(img, url);
      app.appendChild(img);
    });
    rendered = true;
    reportSize();
  }

  function renderImages(imgs) {
    var app = document.getElementById("app");
    app.innerHTML = "";
    imgs.forEach(function (im) {
      var img = document.createElement("img");
      img.onload = reportSize;
      img.src = "data:" + im.mimeType + ";base64," + im.data;
      img.alt = "Generated image";
      attachTap(img);
      app.appendChild(img);
    });
    rendered = true;
    reportSize();
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
      // Applied synchronously here (not in the send().then() below) so layout/capability state
      // is in place before any tool-result content on this same response gets rendered.
      if (data.id === initializeRequestId && data.result) {
        applyInitializeResult(data.result);
      }
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

    if (data.method === "ui/notifications/host-context-changed") {
      applyHostContext(data.params);
      return;
    }

    // Accept the tool result regardless of the exact method name (e.g.
    // "ui/notifications/tool-result", "notifications/tool-result", "tools/result", ...) -
    // what matters is that params carry a content array.
    var paramsContent = findContent(data.params);
    if (paramsContent) handleContent(paramsContent);
  });

  var initPromise = send("ui/initialize", {
    capabilities: {},
    clientInfo: { name: "nano-banana-mcp-view", version: "1.0.0" },
    protocolVersion: "2026-01-26",
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] }
  });
  initializeRequestId = initPromise.requestId;
  initPromise.then(
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

// Gemini's output resolutions are not exactly the nominal ratio (16:9 comes back as 1376x768),
// so the comparison needs slack; 5% is far tighter than any ratio-vs-ratio confusion.
function matchesAspectRatio(ratio: string, size: { width: number; height: number }): boolean {
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h || !size.width || !size.height) return true;
  const want = w / h;
  return Math.abs(want - size.width / size.height) / want <= 0.05;
}

// The settings line echoed back with every image, e.g. "1024x576 (16:9) - seed 4821 - temp 0.9",
// so the chat side can report what was used and reuse it on a follow-up request.
function formatSettings(opts: {
  size: { width: number; height: number } | null;
  aspectRatio?: string;
  seed?: number;
  temperature?: number;
}): string {
  const dims = opts.size ? `${opts.size.width}×${opts.size.height}` : null;
  const parts: string[] = [];
  if (dims && opts.aspectRatio) parts.push(`${dims} (${opts.aspectRatio})`);
  else if (dims) parts.push(dims);
  else if (opts.aspectRatio) parts.push(opts.aspectRatio);
  if (opts.seed !== undefined) parts.push(`seed ${opts.seed}`);
  if (opts.temperature !== undefined) parts.push(`temp ${opts.temperature}`);

  let line = parts.join(" · ");
  if (opts.aspectRatio && opts.size && !matchesAspectRatio(opts.aspectRatio, opts.size)) {
    line += ` ⚠ model returned a different aspect ratio than the requested ${opts.aspectRatio}`;
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
    "Each URL's trailing 8-character id can be passed to edit_image to make further edits to that image. " +
    "On hosts that support MCP Apps, the image also renders inline as an embedded HTML view.",
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
          "back the same image, so pass a previous result's seed to reproduce or nudge that image, " +
          "and omit it for a fresh random result. With count > 1 the seed is incremented per " +
          "variation (seed, seed+1, ...), which is why the variations differ but stay reproducible.",
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
          "back the same edit. Omit for a fresh random result.",
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
  _meta: {
    ui: {
      resourceUri: UI_RESOURCE_URI,
      visibility: ["model", "app"],
    },
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

// One text block per image, URL on its own first line (the MCP App view scans text blocks for
// http lines) followed by the settings actually used, then the raw image blocks for hosts that
// render base64 directly.
function buildImageBlock(url: string, settings: string) {
  return { type: "text", text: settings ? `${url}\n${settings}` : url };
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
      if (uri !== UI_RESOURCE_URI && uri !== UI_RESOURCE_URI_LEGACY) {
        return jsonRpcError(req.id, -32602, `Unknown resource: ${uri}`);
      }
      return jsonRpcResult(req.id, {
        contents: [
          {
            uri,
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

        const textBlocks: any[] = [];
        const imageBlocks: any[] = [];
        let failure: { variant: number; message: string } | null = null;

        for (let i = 0; i < count.value; i++) {
          const variantSeed =
            seed.value === undefined ? undefined : seedForVariant(seed.value, i);
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
              aspectRatio: aspectRatio.value,
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

          const params: GenerationParams = {
            aspectRatio: aspectRatio.value,
            seed: seed.value,
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
                  aspectRatio: aspectRatio.value,
                  seed: seed.value,
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
