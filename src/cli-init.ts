#!/usr/bin/env node

import { checkbox, input, select, confirm } from '@inquirer/prompts';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import type { AgentCli } from './types.js';
import {
  scaffoldInstructionFiles,
  scaffoldRoleInstructions,
  generateConfigYml,
  generateMcpJson,
  ensureGitignore,
  type RoleDefinition,
} from './scaffold.js';
import { writeFileSync, mkdirSync } from 'fs';

const CLI_CHOICES = [
  { name: 'Claude Code', value: 'claude' as AgentCli },
  { name: 'Codex', value: 'codex' as AgentCli },
];

const MODEL_PRESETS: Record<AgentCli, Array<{ name: string; value: string }>> = {
  claude: [
    { name: 'opus (default)', value: 'opus' },
    { name: 'sonnet', value: 'sonnet' },
    { name: 'haiku', value: 'haiku' },
  ],
  codex: [
    { name: 'gpt-5.5 (default)', value: 'gpt-5.5' },
  ],
};

const SKILL_CHOICES = [
  { name: 'code-review', value: 'code-review' },
  { name: 'frontend-design', value: 'frontend-design' },
  { name: 'commit', value: 'commit' },
  { name: 'security-review', value: 'security-review' },
  { name: 'simplify', value: 'simplify' },
];

// ── Role presets ──

interface RolePreset {
  id: string;
  description: string;
  defaultCli: AgentCli;
  defaultModel?: string;
  skills: string[];
}

const ROLE_PRESETS: RolePreset[] = [
  {
    id: 'developer',
    description: 'General code implementation and bug fixes',
    defaultCli: 'claude',
    defaultModel: 'sonnet',
    skills: ['commit', 'code-review'],
  },
  {
    id: 'frontend',
    description: 'UI/UX implementation (React, Next.js, CSS)',
    defaultCli: 'claude',
    defaultModel: 'sonnet',
    skills: ['frontend-design', 'commit', 'code-review'],
  },
  {
    id: 'backend',
    description: 'API, database, and server-side logic',
    defaultCli: 'claude',
    defaultModel: 'sonnet',
    skills: ['commit', 'code-review', 'security-review'],
  },
  {
    id: 'reviewer',
    description: 'Code review, quality checks, and PR feedback',
    defaultCli: 'claude',
    defaultModel: 'haiku',
    skills: ['code-review', 'security-review', 'simplify'],
  },
  {
    id: 'researcher',
    description: 'Technical research, analysis, and documentation',
    defaultCli: 'claude',
    defaultModel: 'sonnet',
    skills: [],
  },
  {
    id: 'planner',
    description: 'Task decomposition, architecture design, and planning',
    defaultCli: 'claude',
    defaultModel: 'opus',
    skills: [],
  },
  {
    id: 'tester',
    description: 'Test writing, QA, and test coverage improvement',
    defaultCli: 'claude',
    defaultModel: 'sonnet',
    skills: ['commit'],
  },
];

async function promptCustomRole(
  roleId: string,
  selectedClis: AgentCli[],
  preset?: RolePreset,
): Promise<RoleDefinition> {
  const cliChoices = selectedClis.map(c => CLI_CHOICES.find(ch => ch.value === c)!);

  const roleCli = await select({
    message: `CLI for "${roleId}":`,
    choices: cliChoices,
    default: preset?.defaultCli,
  });

  const modelChoices = [
    ...MODEL_PRESETS[roleCli],
    { name: 'custom...', value: '__custom__' },
  ];

  let model = await select({
    message: `Model for "${roleId}":`,
    choices: modelChoices,
    default: preset?.defaultModel,
  });

  if (model === '__custom__') {
    model = await input({ message: 'Custom model name:' });
  }

  const description = await input({
    message: `Description for "${roleId}":`,
    default: preset?.description,
  });

  const skills = await checkbox({
    message: `Skills for "${roleId}":`,
    choices: SKILL_CHOICES,
  });

  return {
    id: roleId,
    cli: roleCli,
    model: model || undefined,
    description: description || undefined,
    skills: skills.length > 0 ? skills : undefined,
  };
}

async function main() {
  const projectRoot = process.cwd();
  const projectName = basename(projectRoot);

  console.log('\n🔧 auto-cmux init\n');

  // Check if already initialized
  if (existsSync(join(projectRoot, 'auto-cmux.yml'))) {
    const overwrite = await confirm({
      message: 'auto-cmux.yml already exists. Overwrite?',
      default: false,
    });
    if (!overwrite) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // 1. Select CLIs
  const selectedClis = await checkbox({
    message: 'Which CLI tools do you use?',
    choices: CLI_CHOICES,
    required: true,
  });

  // 2. Define roles — preset selection + custom
  const roles: RoleDefinition[] = [];

  // Filter presets to only show those whose defaultCli is in selectedClis
  const availablePresets = ROLE_PRESETS.filter(p => selectedClis.includes(p.defaultCli));

  if (availablePresets.length > 0) {
    const selectedPresetIds = await checkbox({
      message: 'Select role presets (or skip to define custom):',
      choices: availablePresets.map(p => ({
        name: `${p.id} — ${p.description} (${p.defaultCli}${p.defaultModel ? `, ${p.defaultModel}` : ''})`,
        value: p.id,
      })),
    });

    // Add selected presets, let user customize each
    for (const presetId of selectedPresetIds) {
      const preset = ROLE_PRESETS.find(p => p.id === presetId)!;

      const customize = await confirm({
        message: `Customize "${preset.id}" role? (default: ${preset.defaultCli}, ${preset.defaultModel ?? 'default model'})`,
        default: false,
      });

      if (customize) {
        const role = await promptCustomRole(preset.id, selectedClis, preset);
        roles.push(role);
      } else {
        roles.push({
          id: preset.id,
          cli: preset.defaultCli,
          model: preset.defaultModel,
          description: preset.description,
          skills: preset.skills.length > 0 ? preset.skills : undefined,
        });
      }
    }
  }

  // Custom roles
  const addCustom = await confirm({
    message: 'Add custom roles?',
    default: roles.length === 0,
  });

  if (addCustom) {
    let addMore = true;
    while (addMore) {
      const roleId = await input({
        message: 'Role name:',
        validate: (v) => {
          if (!v.trim()) return 'Role name is required';
          if (!/^[a-zA-Z0-9_-]+$/.test(v)) return 'Use only alphanumeric, dash, underscore';
          if (roles.some(r => r.id === v)) return 'Role already defined';
          return true;
        },
      });

      const role = await promptCustomRole(roleId, selectedClis);
      roles.push(role);

      addMore = await confirm({
        message: 'Add another role?',
        default: false,
      });
    }
  }

  // 3. Generate files
  console.log('');

  // auto-cmux.yml
  const configContent = generateConfigYml(projectName, selectedClis, roles);
  writeFileSync(join(projectRoot, 'auto-cmux.yml'), configContent, 'utf8');
  console.log('✓ Created auto-cmux.yml');

  // .mcp.json
  const mcpPath = join(projectRoot, '.mcp.json');
  if (existsSync(mcpPath)) {
    // Merge into existing .mcp.json
    try {
      const existing = JSON.parse(
        (await import('fs')).readFileSync(mcpPath, 'utf8'),
      );
      existing.mcpServers = existing.mcpServers ?? {};
      existing.mcpServers['auto-cmux'] = { command: 'npx', args: ['auto-cmux'] };
      writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
      console.log('✓ Updated .mcp.json (merged auto-cmux server)');
    } catch {
      writeFileSync(mcpPath, generateMcpJson(), 'utf8');
      console.log('✓ Created .mcp.json');
    }
  } else {
    writeFileSync(mcpPath, generateMcpJson(), 'utf8');
    console.log('✓ Created .mcp.json');
  }

  // Instruction files per CLI
  const instructionFiles = scaffoldInstructionFiles({
    projectRoot,
    clis: selectedClis,
  });
  for (const f of instructionFiles) {
    console.log(`✓ Created ${f}`);
  }

  // Role instruction files
  for (const role of roles) {
    const rolePath = scaffoldRoleInstructions(
      projectRoot,
      role.id,
      role.description,
    );
    console.log(`✓ Created .auto-cmux/roles/${role.id}.md`);
  }

  // .gitignore
  if (ensureGitignore(projectRoot)) {
    console.log('✓ Added .auto-cmux/ to .gitignore');
  }

  console.log('\n✅ auto-cmux initialized! Restart your MCP server to apply.\n');
}

main().catch((err) => {
  if (err.name === 'ExitPromptError') {
    // User cancelled with Ctrl+C
    console.log('\nAborted.');
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
