#!/usr/bin/env node

const command = process.argv[2];

switch (command) {
  case 'init':
    await import('./cli-init.js');
    break;
  case 'remove': {
    const { loadProjectConfig } = await import('./config-loader.js');
    const { cleanupInstructionFiles } = await import('./scaffold.js');

    const projectRoot = process.cwd();
    const config = loadProjectConfig(projectRoot);
    const clis = (config as any).project?.clis ?? ['claude'];
    const removed = cleanupInstructionFiles(projectRoot, clis);
    for (const f of removed) {
      console.log(`✓ Removed ${f}`);
    }
    if (removed.length === 0) {
      console.log('Nothing to remove.');
    }
    break;
  }
  case 'doctor': {
    const { runDoctorCommand } = await import('./doctor.js');
    await runDoctorCommand();
    break;
  }
  case 'clean': {
    const { runCleanupCommand } = await import('./runtime-cleanup.js');
    await runCleanupCommand(process.argv.slice(3));
    break;
  }
  default: {
    // No subcommand = run MCP server
    const { runStandaloneMcpServer } = await import('./mcp-server.js');
    await runStandaloneMcpServer();
    break;
  }
}
