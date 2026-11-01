import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invoke } from './cli.ts';
import { failure } from './mutations.ts';
import { validateDocumentXml } from './document-input.ts';
import type { CommandMetadata, Risk } from './cli-metadata.ts';

interface Inventory { version: string; domains: { name: string; description: string }[]; entries: CommandMetadata[] }
export type FlagValue = string | number | boolean | null | FlagValue[] | { [key: string]: FlagValue };
export interface PreparedCommand { args: string[]; policy: string; parameters: Record<string, FlagValue>; content?: string; risk: Risk; id: string }
const inventory: Inventory = JSON.parse(await readFile(new URL('../config/cli-catalog.json', import.meta.url), 'utf8'));
const entries = new Map(inventory.entries.map(entry => [entry.id, entry]));
const reserved = new Set(['as', 'profile', 'help', 'version', 'format', 'output', 'jq', 'yes', 'page-all', 'page-limit', 'page-delay']);
const reservedFlags = (entry: CommandMetadata) => new Set([...reserved, ...(entry.flags.json?.type === 'bool' ? ['json'] : [])]);

export const exceptions = [
  { scope: 'existing lark_sheets_* / lark_docs_read / lark_api_read convenience tools', reason: 'Compatibility with the already-accepted clients and bounded sheet ranges. New ordinary business capabilities use generic dispatch; no new per-command facade is required.' },
  { scope: 'auth/config/profile/update/doctor/whoami', reason: 'Bridge owns the two fixed user identities, credential renewal and pinned binary. Management commands are outside the business catalog.' },
  { scope: 'apps/**, event/**, drive/+pull,+push,+sync,+status, docs/+script', reason: 'These workflows require deployment toolchains, durable local working trees, interactive input or long-lived processes. A stateless Vercel invocation does not provide that lifecycle.' },
  { scope: 'file/path/output flags, @file/stdin, native MCP image/file results', reason: 'Client files and server paths are different. Use upload/read tools for actual byte transfer; arbitrary server paths cannot be forwarded.' },
  { scope: 'docs/+create and docs/+update content', reason: 'XML can load local files or external assets. Content is validated as the supported DocxXML subset and written to an isolated temporary input; external asset fetching/reference maps need separate transport work.' },
  { scope: 'local media in Slides XML / mail HTML / Base form attachment JSON; upload, clipboard and local-media flags', reason: 'Inline business content can hide local-file reads as well. Local media references are rejected until those bytes have an explicit bridge transport; existing upstream media tokens and ordinary inline content remain available.' },
  { scope: 'risk missing or no user identity', reason: 'The CLI risk/identity metadata must support the selected user execution; unknown risk is not guessed.' },
  { scope: 'bounded runtime/output/pagination', reason: 'One invocation has a 120s CLI limit and 1 MiB output; pagination stays explicit. Large/binary outputs use the file tools.' },
];

export function unavailable(entry: CommandMetadata): string | null {
  if (/^(?:apps|event)\//.test(entry.id) || /^(?:drive\/\+(?:pull|push|sync|status)|docs\/\+script)$/.test(entry.id)) return 'requires_local_or_persistent_runtime';
  if (!entry.risk) return 'upstream_risk_unannotated';
  if (entry.authorization?.access_tokens && !entry.authorization.access_tokens.includes('user')) return 'upstream_user_identity_not_supported';
  if (!entry.flags.as) return 'upstream_user_identity_flag_unavailable';
  // Shortcuts have no raw API schema. Their --as help is the upstream identity
  // contract; do not advertise bot-only shortcuts as executable for a user.
  const identities = /^identity type: ((?:user|bot)(?: \| (?:user|bot))*)$/.exec(entry.flags.as.description)?.[1].split(' | ');
  if (identities && !identities.includes('user')) return 'upstream_user_identity_not_supported';
  return null;
}

export function catalog({ command, query = '', offset = 0, limit = 30 }: { command?: string[]; query?: string; offset?: number; limit?: number } = {}) {
  if (command?.length) {
    const entry = entries.get(command.join('/'));
    if (!entry) throw failure('unknown_command_use_catalog_search');
    return { cliVersion: inventory.version, ...entry, executable: !unavailable(entry), unavailableReason: unavailable(entry),
      bridgeReservedFlags: [...reservedFlags(entry)], exceptions, usage: 'Pass flags as an object using the exact --flag name without leading dashes. Scalars pass as one argv value; objects become inline JSON; arrays repeat only list flags, otherwise become JSON. A business --json payload flag is distinct from the reserved boolean --json output switch. Read official Related skills through lark_cli_help(skill="lark-doc/references/lark-doc-xml.md"), for example. The upstream CLI validates business semantics. Read/write tools are separated by upstream risk. Do not copy an agent-local @path into a remote command.' };
  }
  const matched = inventory.entries.filter(entry => !query || `${entry.id} ${entry.description}`.toLowerCase().includes(query.toLowerCase()));
  return { cliVersion: inventory.version, domains: inventory.domains, total: matched.length, totalCatalog: inventory.entries.length,
    commands: matched.slice(offset, offset + limit).map(entry => ({ command: entry.command, description: entry.description, risk: entry.risk, executable: !unavailable(entry), ...(unavailable(entry) ? { reason: unavailable(entry) } : {}) })),
    nextOffset: offset + limit < matched.length ? offset + limit : null, exceptions,
    usage: 'Search by domain/name, then pass command for official help, flags and raw API JSON Schema. Executable means the bridge supports dispatch, not that the account has every scope or that every command has been tested. Choose a configured account alias explicitly. Ordinary commands are not implemented one by one in this bridge.' };
}

function checkInline(value: FlagValue, domain: string, depth = 0): void {
  if (depth > 32) throw failure('command_input_nesting_exceeds_limit');
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if (trimmed.startsWith('@') || trimmed.trimEnd() === '-' || /\x00/.test(value)) throw failure('remote_cli_requires_inline_values_not_local_paths_or_stdin');
    // Upstream Slides recognizes @paths inside XML; mail also resolves bare
    // local img src paths. Catch these after JSON decoding, including arrays.
    for (const match of value.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']/gis)) {
      const source = match[1].trim();
      if (source.startsWith('@') || (domain === 'mail' && source && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source))) throw failure('inline_local_media_requires_explicit_file_transport');
    }
    if (/^[\[{]/.test(trimmed)) {
      let parsed: FlagValue | undefined;
      try { parsed = JSON.parse(value); } catch { /* The CLI owns business syntax validation. */ }
      if (parsed !== undefined) checkInline(parsed, domain, depth + 1);
    }
  }
  if (Array.isArray(value)) for (const child of value) checkInline(child, domain, depth + 1);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) checkInline(child, domain, depth + 1);
}

export function commandArguments(command: string[], flags: Record<string, FlagValue>, mode: 'read' | 'write', highRiskConfirmed = false): PreparedCommand {
  const entry = entries.get(command.join('/'));
  if (!entry) throw failure('unknown_command_use_catalog_search');
  const reason = unavailable(entry);
  if (reason) throw failure(reason);
  const risk = entry.risk!;
  if ((mode === 'read') !== (risk === 'read')) throw failure('command_risk_does_not_match_read_or_write_tool');
  if (risk === 'high-risk-write' && !highRiskConfirmed) throw failure('high_risk_command_requires_explicit_user_confirmation');
  if (Buffer.byteLength(JSON.stringify(flags)) > 262144) throw failure('command_input_exceeds_256_kib');
  const args = [...command];
  let content: string | undefined;
  const blocked = reservedFlags(entry);
  for (const [name, value] of Object.entries(flags)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !entry.flags[name] || blocked.has(name)) throw failure('unknown_or_bridge_reserved_flag_use_catalog');
    if (/(?:^|-)(?:file|files|filepath|path|directory|dir|output|output-dir|input-file|attachment-path)(?:$|-)/.test(name) && !/(?:token|id|name|type|size|version)/.test(name)) throw failure('file_transport_requires_upload_or_read_tool');
    if (/^(?:optional\.?\s*|required\.?\s*)?(?:regular\s+)?(?:local (?:image |file )?path|local file path|attachment file path)/i.test(entry.flags[name].description) || /(?:cwd-relative local path|file_path.*relative|clipboard)/i.test(entry.flags[name].description)) throw failure('file_transport_requires_upload_or_read_tool');
    checkInline(value, command[0]);
    if (entry.id === 'base/+form-submit' && name === 'json') {
      const body = typeof value === 'string' ? JSON.parse(value) : value;
      if (body && typeof body === 'object' && !Array.isArray(body) && body.attachments && Object.keys(body.attachments).length) throw failure('form_attachments_require_explicit_file_transport');
    }
    if (entry.id === 'docs/+create' || entry.id === 'docs/+update') {
      if (name === 'reference-map' || (name === 'doc-format' && value !== 'xml')) throw failure('document_transport_currently_accepts_inline_xml_only');
      if (name === 'content') {
        if (typeof value !== 'string') throw failure('document_content_must_be_xml_string');
        content = validateDocumentXml(value);
        args.push('--content=@./content.xml');
        continue;
      }
    }
    const info = entry.flags[name];
    const values = Array.isArray(value) && ['strings', 'stringArray', 'ints'].includes(info.type) ? value : [value];
    for (const item of values) {
      if (info.type === 'bool' && typeof item !== 'boolean') throw failure('boolean_flag_requires_boolean');
      if (['int', 'ints', 'float'].includes(info.type) && (typeof item !== 'number' || !Number.isFinite(item))) throw failure('numeric_flag_requires_number');
      args.push(`--${name}=${typeof item === 'object' ? JSON.stringify(item) : String(item)}`);
    }
  }
  args.push('--as=user');
  if (entry.flags.json?.type === 'bool') args.push('--json');
  else if (entry.flags.format) args.push('--format=json');
  if (risk === 'high-risk-write') args.push('--yes');
  // Enforce the same risk inside the official CLI, independent of this catalog.
  const policy = `name: bridge-invocation\nallow:\n  - ${entry.id}\nmax_risk: ${risk}\nidentities:\n  - user\nallow_unannotated: false\n`;
  return { args, policy, parameters: flags, content, risk, id: entry.id };
}

export async function executeCommand(account, token, prepared: PreparedCommand, run = invoke) {
  const { ok, output } = await run(prepared.args, token, { timeout: 120_000, prepare: async scratch => {
    await writeFile(join(scratch, 'config/policy.yml'), prepared.policy, { mode: 0o600 });
    if (prepared.content !== undefined) await writeFile(join(scratch, 'content.xml'), prepared.content, { mode: 0o600 });
  } });
  let result;
  try { result = JSON.parse(output); } catch { throw failure('cli_output_not_json_use_specialized_transport'); }
  return { ok: ok && result.ok !== false, account, identity: 'user', result };
}
