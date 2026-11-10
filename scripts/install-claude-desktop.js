// Adds the mtg-collector MCP server to the Claude desktop app's config.
// Quit the Claude desktop app first (it rewrites this file while running), then: npm run claude:install
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const config = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const server = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'mcp.js');

const data = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {};
data.mcpServers ||= {};
const entry = { command: process.execPath, args: ['--no-warnings', server] };
const before = JSON.stringify(data.mcpServers['mtg-collector'] || null);
if (before === JSON.stringify(entry)) {
  console.log('Already installed. Nothing to do.');
  process.exit(0);
}
if (existsSync(config)) {
  const backup = `${config}.backup.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(config, backup);
  console.log(`Backed up existing config to ${backup}`);
}
data.mcpServers['mtg-collector'] = entry;
writeFileSync(config, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
console.log(`Added "mtg-collector" to ${config}`);
console.log('Start the Claude desktop app; the tools appear under the tools/connectors menu in a chat.');
