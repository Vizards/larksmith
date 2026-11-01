export type Risk = 'read' | 'write' | 'high-risk-write';
export interface FlagInfo { type: string; description: string }
export interface CommandMetadata { id: string; command: string[]; description: string; risk: Risk | null; flags: Record<string, FlagInfo>; help: string; schema?: unknown; authorization?: { access_tokens?: string[]; risk?: Risk; [key: string]: unknown } }

export function parseHelp(command: string[], help: string): CommandMetadata {
  const risk = /^Risk: (read|write|high-risk-write)\s*$/m.exec(help)?.[1] as Risk | undefined;
  const flags: Record<string, FlagInfo> = {};
  let inFlags = false;
  for (const line of help.split('\n')) {
    if (/^[A-Z][^\n]*:$/.test(line)) inFlags = /^(?:Flags|Global Flags|API Parameters|Request Body|Raw Parameter Input|Execution|Output|Other):$/.test(line);
    if (!inFlags) continue;
    const match = /^\s+(?:-[A-Za-z], )?\s*--([a-z][a-z0-9-]*)(?: (\S+))?\s{2,}(.+)$/.exec(line);
    if (match) flags[match[1]] = { type: match[2] || 'bool', description: match[3] };
  }
  if (!help.includes(`lark-cli ${command.join(' ')} [flags]`)) throw new Error(`Unexpected help for ${command.join(' ')}`);
  return { id: command.join('/'), command, description: help.split('\n').find(line => line.trim()) || '', risk: risk || null, flags, help };
}
