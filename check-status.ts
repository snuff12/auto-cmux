import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp-server.ts"],
  });
  
  const client = new Client({ name: "orchestrator", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    const agents = await client.callTool({ name: "list_agents", arguments: {} });
    console.log("Agents:", JSON.stringify(agents, null, 2));

    const res1 = await client.callTool({ name: "get_agent_output", arguments: { name: "Researcher1" } });
    console.log("\nResearcher1 Output:", res1.content[0].text);

    const res2 = await client.callTool({ name: "get_agent_output", arguments: { name: "Researcher2" } });
    console.log("\nResearcher2 Output:", res2.content[0].text);

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await transport.close();
  }
}

main().catch(console.error);
