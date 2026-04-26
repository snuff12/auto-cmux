import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp-server.ts"],
  });
  
  const client = new Client({ name: "orchestrator", version: "1.0.0" }, { capabilities: {} });
  
  console.log("Connecting to auto-cmux MCP server...");
  await client.connect(transport);
  console.log("Connected!");

  try {
    console.log("\n1. Creating 'Research' workspace...");
    const wsResult = await client.callTool({
      name: "create_agent_workspace",
      arguments: { name: "Research", use_worktree: true }
    });
    console.log("Workspace Result:", JSON.stringify(wsResult, null, 2));

    console.log("\n2. Spawning researcher agents...");
    const agent1 = await client.callTool({
      name: "spawn_in_workspace",
      arguments: {
        workspace: "Research",
        name: "Researcher1",
        cli: "gemini",
        role: "researcher",
        prompt: "Research Multi-agent orchestration best practices"
      }
    });
    console.log("Agent 1 Result:", JSON.stringify(agent1, null, 2));

    const agent2 = await client.callTool({
      name: "spawn_in_workspace",
      arguments: {
        workspace: "Research",
        name: "Researcher2",
        cli: "gemini",
        role: "researcher",
        prompt: "Research Multi-agent orchestration best practices"
      }
    });
    console.log("Agent 2 Result:", JSON.stringify(agent2, null, 2));

    console.log("\n3. Waiting for results (up to 120s)...");
    const p1 = client.callTool({
      name: "wait_for_result",
      arguments: { name: "Researcher1", timeout_ms: 120000 }
    });
    const p2 = client.callTool({
      name: "wait_for_result",
      arguments: { name: "Researcher2", timeout_ms: 120000 }
    });

    const [res1, res2] = await Promise.all([p1, p2]);
    console.log("\nResearcher 1 Final Result:", JSON.stringify(res1, null, 2));
    console.log("\nResearcher 2 Final Result:", JSON.stringify(res2, null, 2));

  } catch (error) {
    console.error("Error during execution:", error);
  } finally {
    console.log("\nClosing client transport...");
    await transport.close();
  }
}

main().catch(console.error);
