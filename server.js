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

// Google Gemini (Nano Banana) for free image generation/editing.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-image";

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

  server.registerTool(
    "gemini_generate_image",
    {
      title: "Generate or edit an image with Gemini (free)",
      description:
        "Generates a new image from a text prompt, or edits an existing image, using " +
        "Google's Gemini image model (no cost, uses Google AI Studio's free quota, " +
        "separate from Hugging Face's ZeroGPU quota). For editing, provide the source " +
        "image either as a public URL (input_image_url, must be an allowed host) or as " +
        "raw base64 (input_image_b64) — base64 is preferred for private/personal photos " +
        "since it never touches any public storage.",
      inputSchema: {
        prompt: z.string().describe("Text description of the image to generate, or the edit to apply"),
        input_image_url: z
          .string()
          .url()
          .optional()
          .describe("Optional: public URL of an image to edit (must be an allowed host)"),
        input_image_b64: z
          .string()
          .optional()
          .describe("Optional: raw base64 image data to edit, as an alternative to input_image_url"),
        input_mime_type: z
          .string()
          .optional()
          .describe("MIME type of input_image_b64, e.g. 'image/jpeg'. Default image/jpeg."),
        push_to_github: z
          .boolean()
          .optional()
          .describe("If true, push the result to GitHub and return a raw URL instead of inline image content"),
        filename: z
          .string()
          .regex(/^[a-zA-Z0-9._-]+$/)
          .optional()
          .describe("Required if push_to_github is true"),
      },
    },
    async ({ prompt, input_image_url, input_image_b64, input_mime_type, push_to_github, filename }) => {
      if (!GEMINI_API_KEY) {
        return { isError: true, content: [{ type: "text", text: "Server missing GEMINI_API_KEY config." }] };
      }

      const parts = [{ text: prompt }];

      if (input_image_url) {
        if (!isAllowedUrl(input_image_url)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Refused: host not on allowlist (${ALLOWED_HOST_SUFFIXES.join(", ")})` }],
          };
        }
        const imgRes = await fetch(input_image_url);
        if (!imgRes.ok) {
          return { isError: true, content: [{ type: "text", text: `Fetch failed: HTTP ${imgRes.status}` }] };
        }
        const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
        const buf = Buffer.from(await imgRes.arrayBuffer());
        parts.push({ inline_data: { mime_type: mimeType, data: buf.toString("base64") } });
      } else if (input_image_b64) {
        parts.push({ inline_data: { mime_type: input_mime_type || "image/jpeg", data: input_image_b64 } });
      }

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts }] }),
        }
      );

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        return {
          isError: true,
          content: [{ type: "text", text: `Gemini API error: HTTP ${geminiRes.status} ${errText.slice(0, 400)}` }],
        };
      }

      const data = await geminiRes.json();
      const imgPart = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
      const inline = imgPart?.inlineData || imgPart?.inline_data;

      if (!inline?.data) {
        const textPart = data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Gemini returned no image. ${textPart ? "Model said: " + textPart.slice(0, 300) : "Response: " + JSON.stringify(data).slice(0, 300)}`,
            },
          ],
        };
      }

      const outMime = inline.mimeType || inline.mime_type || "image/png";
      const outBuf = Buffer.from(inline.data, "base64");

      if (push_to_github) {
        if (!filename) {
          return { isError: true, content: [{ type: "text", text: "filename is required when push_to_github is true." }] };
        }
        if (!GITHUB_TOKEN || !GITHUB_REPO) {
          return { isError: true, content: [{ type: "text", text: "Server missing GITHUB_TOKEN / GITHUB_REPO config." }] };
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
          body: JSON.stringify({ message: `relay: gemini output ${filename}`, content: outBuf.toString("base64"), branch: GITHUB_BRANCH }),
        });
        if (!putRes.ok) {
          const errText = await putRes.text();
          return { isError: true, content: [{ type: "text", text: `GitHub push failed: HTTP ${putRes.status} ${errText.slice(0, 300)}` }] };
        }
        const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}`;
        return { content: [{ type: "text", text: rawUrl }] };
      }

      return { content: [{ type: "image", data: outBuf.toString("base64"), mimeType: outMime }] };
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
