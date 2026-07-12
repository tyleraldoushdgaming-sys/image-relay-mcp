import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "test-client", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp"));
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map(t => t.name));

// no CLOUDFLARE creds set locally -> should gracefully error, not crash
const result = await client.callTool({ name: "cloudflare_generate_image", arguments: { prompt: "test" } });
console.log("RESULT:", JSON.stringify(result).slice(0, 200));
