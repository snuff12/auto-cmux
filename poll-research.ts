import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp-server.ts"],
  });
  
  const client = new Client({ name: "orchestrator", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  
  console.log("Connected to MCP server.");

  try {
    const wsName = `Research-${Date.now()}`;
    console.log(`\n1. Creating '${wsName}' workspace...`);
    const wsResult = await client.callTool({
      name: "create_agent_workspace",
      arguments: { name: wsName, use_worktree: true }
    });
    console.log("Workspace:", JSON.stringify(wsResult, null, 2));

    console.log("\n2. Spawning agents...");
    const a1 = await client.callTool({
      name: "spawn_in_workspace",
      arguments: {
        workspace: wsName,
        name: "ResearcherA",
        cli: "gemini",
        role: "researcher",
        prompt: "Research Multi-agent orchestration best practices"
      }
    });
    console.log("ResearcherA spawned.");

    const a2 = await client.callTool({
      name: "spawn_in_workspace",
      arguments: {
        workspace: wsName,
        name: "ResearcherB",
        cli: "gemini",
        role: "researcher",
        prompt: "Research Multi-agent orchestration best practices"
      }
    });
    console.log("ResearcherB spawned.");

    console.log("\n3. Waiting for results (polling status)...");
    
    let a1Finished = false;
    let a2Finished = false;
    
    // Poll for completion to avoid MCP request timeouts
    while (!a1Finished || !a2Finished) {
      await new Promise(r => setTimeout(r, 5000));
      
      const agentsRes = await client.callTool({ name: "list_agents", arguments: {} });
      const agentsStr = Array.isArray(agentsRes.content) ? agentsRes.content[0].text : '';
      const agents = agentsStr ? JSON.parse(agentsStr as string) : [];
      
      const a1State = agents.find((a: any) => a.name === "ResearcherA");
      const a2State = agents.find((a: any) => a.name === "ResearcherB");
      
      if (!a1State || a1State.status !== "working") a1Finished = true;
      if (!a2State || a2State.status !== "working") a2Finished = true;
      
      console.log(`[Status] ResearcherA: ${a1State?.status || 'gone'} | ResearcherB: ${a2State?.status || 'gone'}`);
    }
    
    console.log("\n4. Retrieving final output:");
    
    try {
      const o1 = await client.callTool({ name: "get_agent_output", arguments: { name: "ResearcherA" } });
      console.log("\n=== ResearcherA Output ===\n", (o1.content as any)[0].text);
    } catch (e: any) { console.error("Could not get ResearcherA output:", e.message); }
    
    try {
      const o2 = await client.callTool({ name: "get_agent_output", arguments: { name: "ResearcherB" } });
      console.log("\n=== ResearcherB Output ===\n", (o2.content as any)[0].text);
    } catch (e: any) { console.error("Could not get ResearcherB output:", e.message); }

  } catch (err: any) {
    console.error("Error:", err.message);
  } finally {
    console.log("\nClosing client transport...");
    await transport.close();
  }
}

main().catch(console.error);
