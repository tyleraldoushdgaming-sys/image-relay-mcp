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

// GitHub push target for relay_to_github. Repo format: "owner/repo".
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const GITHUB_REPO = process.env.GITHUB_REPO || null;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

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

  server.registerTool(
    "relay_to_github",
    {
      title: "Relay image to GitHub",
      description:
        "Fetches an image from an allowed host (e.g. a Hugging Face Space output) and " +
        "pushes it into a GitHub repo, returning a raw.githubusercontent.com URL. This " +
        "lets Claude's own sandbox (which can reach GitHub but not hf.space) pull the " +
        "image down directly for further local editing.",
      inputSchema: {
        url: z.string().url().describe("Direct https URL to the source image"),
        filename: z
          .string()
          .regex(/^[a-zA-Z0-9._-]+$/)
          .describe("Filename only, e.g. 'bg-01.png'. No slashes or paths."),
      },
    },
    async ({ url, filename }) => {
      if (!isAllowedUrl(url)) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Refused: host not on allowlist (${ALLOWED_HOST_SUFFIXES.join(", ")})` },
          ],
        };
      }
      if (!GITHUB_TOKEN || !GITHUB_REPO) {
        return {
          isError: true,
          content: [{ type: "text", text: "Server missing GITHUB_TOKEN / GITHUB_REPO config." }],
        };
      }

      const imgRes = await fetch(url);
      if (!imgRes.ok) {
        return { isError: true, content: [{ type: "text", text: `Fetch failed: HTTP ${imgRes.status}` }] };
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) {
        return { isError: true, content: [{ type: "text", text: `Image too large (${buf.byteLength} bytes)` }] };
      }

      const path = `relay-drops/${filename}`;
      const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;

      const putRes = await fetch(apiUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `relay: add ${filename}`,
          content: buf.toString("base64"),
          branch: GITHUB_BRANCH,
        }),
      });

      if (!putRes.ok) {
        const errText = await putRes.text();
        return {
          isError: true,
          content: [{ type: "text", text: `GitHub push failed: HTTP ${putRes.status} ${errText.slice(0, 300)}` }],
        };
      }

      const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}`;
      return { content: [{ type: "text", text: rawUrl }] };
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
