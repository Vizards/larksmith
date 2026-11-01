// Generate discovery from the pinned, official binary. No user credentials or
// business calls are needed. Schema/flag definitions are upstream-owned.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHelp, type CommandMetadata } from '../src/cli-metadata.ts';

const execute = promisify(execFile);
const binary = process.env.LARK_CATALOG_BINARY || 'lark-cli';
const scratch = await mkdtemp(join(tmpdir(), 'lark-catalog-'));
const pin = JSON.parse(await readFile(new URL('../config/cli-version.json', import.meta.url), 'utf8'));
const env = { PATH: process.env.PATH, HOME: scratch, LARKSUITE_CLI_CONFIG_DIR: join(scratch, 'config'), LARKSUITE_CLI_BRAND: 'feishu', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
async function run(args: string[]) { return (await execute(binary, args, { env, cwd: scratch, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })).stdout; }
try {
  await mkdir(join(scratch, 'config'));
  if (!(await run(['--version'])).trim().split(/\s+/).includes(pin.version)) throw new Error('Catalog binary does not match the pinned version');
  const root = await run(['--help']);
  const domains = [...root.split('Lark domains:')[1].split('Agent tooling:')[0].matchAll(/^  ([a-z]+)\s+(.+)$/gm)].map(match => ({ name: match[1], description: match[2] }));
  const schema = JSON.parse(await run(['schema']));
  const raw = new Map(schema.map((item: any) => [item.name, item]));
  const paths = schema.map((item: any) => item.name.split(' '));
  for (const domain of domains) {
    const help = await run([domain.name, '--help']);
    for (const match of help.matchAll(/^  (\+[a-z0-9_-]+)\s+/gm)) paths.push([domain.name, match[1]]);
  }
  const entries: CommandMetadata[] = [];
  for (let start = 0; start < paths.length; start += 8) {
    entries.push(...await Promise.all(paths.slice(start, start + 8).map(async (command: string[]) => {
      const help = await run([...command, '--help']);
      const api = raw.get(command.join(' ')) as any;
      const metadata = parseHelp(command, help, api?._meta?.risk);
      return { ...metadata, ...(api ? { schema: api.inputSchema, authorization: api._meta } : {}) };
    })));
  }
  entries.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  await writeFile(new URL('../config/cli-catalog.json', import.meta.url), JSON.stringify({ version: pin.version, domains, entries }) + '\n');
  console.log(JSON.stringify({ version: pin.version, domains: domains.length, commands: entries.length, raw: schema.length, shortcuts: entries.length - schema.length, noBusinessCalls: true }));
} finally { await rm(scratch, { recursive: true, force: true }); }
