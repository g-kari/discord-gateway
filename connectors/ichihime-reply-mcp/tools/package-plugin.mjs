import { readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
// Deliberately requires a recorded, supported live discovery check.
// This script never deploys, creates credentials, saves a plugin, or connects it.
const [discoveryFile, outputDirectory] = process.argv.slice(2);
if (!discoveryFile || !outputDirectory) throw Error('Usage: node tools/package-plugin.mjs verified-discovery.json new-output-directory');
const d = JSON.parse(await readFile(discoveryFile, 'utf8'));
const u = new URL(d.endpoint);
if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/mcp' || /(?:example|localhost|REPLACE|<|>)/i.test(d.endpoint)) throw Error('Verified production HTTPS /mcp endpoint required');
const expected = ['discord_reply_status', 'discord_send_reply', 'discord_reply_receipt'];
if (!['cimd', 'dcr'].includes(d.oauth_client_mode) || d.transport !== 'streamable-http' || d.owner_auth_verified !== true || d.unauthenticated_rejected !== true || d.outsider_rejected !== true || !expected.every(t => d.tools?.includes(t))) throw Error('Authenticated live MCP discovery and owner isolation checks required');
const output = resolve(outputDirectory);
await mkdir(output); // Existing target is an error, not an overwrite.
await cp(resolve('plugin-template'), output, { recursive: true });
await writeFile(resolve(output, 'mcp.json'), JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: { 'ichihime-owner-reply': {
    type: 'streamable-http', url: d.endpoint,
    extensions: { 'com.openai': { auth: {
      type: 'oauth', client: { mode: d.oauth_client_mode },
      baseScopes: ['discord:reply:read'], defaultScopes: ['discord:reply:read','discord:reply:send']
    } } }
  } }
}, null, 2) + '\n');
console.log('Private plugin files prepared. Inspect and archive before an explicitly authorized save.');
