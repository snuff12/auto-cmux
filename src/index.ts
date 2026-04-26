import { runStandaloneMcpServer } from './mcp-server.js';

runStandaloneMcpServer().catch((err) => {
  console.error(`[auto-cmux] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
