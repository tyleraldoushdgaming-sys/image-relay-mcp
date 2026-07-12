import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "test-client", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp"));

await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map(t => t.name));

const result = await client.callTool({
  name: "fetch_image",
  arguments: {
    url: "https://raw.githubusercontent.com/github/explore/main/topics/nodejs/nodejs.png"
  }
});

console.log("RESULT type:", result.content[0].type);
console.log("RESULT mimeType:", result.content[0].mimeType);
console.log("RESULT data length (base64 chars):", result.content[0].data?.length);
