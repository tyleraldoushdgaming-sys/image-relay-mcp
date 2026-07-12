import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// --- config -----------------------------------------------------------
// Only fetch from hosts you actually trust. Keeps this from becoming an
// open SSRF relay if the URL ever leaks or gets guessed.
const ALLOWED_HOST_SUFFIXES = [
  ".hf.space",
  "huggingface.co",
];

// Optional shared secret. If set, callers must send it as a Bearer token.
// Leave unset while testing locally.
const AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || null;

const MAX_BYTES = 15 * 1024 * 1024; // 15MB safety cap

function isAllowedUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return ALLOWED_HOST_SUFFIXES.some(
    (suf) => u.hostname === suf.replace(/^\./, "") || u.hostname.endsWith(suf)
  );
}

// --- MCP server ---------------------------------------------------------
function buildServer() {
  const server = new McpServer({ name: "image-relay", version: "1.0.0" });

  server.registerTool(
    "fetch_image",
    {
      title: "Fetch image",
      description:
        "Downloads an image from an allowed host (e.g. a Hugging Face Space output) " +
        "and returns it as inline image content, bypassing any caller-side sandbox " +
        "network restrictions.",
      inputSchema: {
        url: z.string().url().describe("Direct https URL to the image file"),
      },
    },
    async ({ url }) => {
      if (!isAllowedUrl(url)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Refused: host not on allowlist (${ALLOWED_HOST_SUFFIXES.join(", ")})`,
            },
          ],
        };
      }

      const res = await fetch(url);
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Fetch failed: HTTP ${res.status}` }],
        };
      }

      const contentType = res.headers.get("content-type") || "image/webp";
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) {
        return {
          isError: true,
          content: [{ type: "text", text: `Image too large (${buf.byteLength} bytes)` }],
        };
      }

      return {
        content: [
          {
            type: "image",
            data: buf.toString("base64"),
            mimeType: contentType,
          },
        ],
      };
    }
  );

  return server;
}

// --- HTTP transport (stateless: one transport per request) --------------
const app = express();
app.use(express.json({ limit: "20mb" }));

app.post("/mcp", async (req, res) => {
  if (AUTH_TOKEN) {
    const header = req.get("authorization") || "";
    if (header !== `Bearer ${AUTH_TOKEN}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: one request, one response, no session
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`image-relay MCP server listening on :${PORT} (POST /mcp)`);
});
