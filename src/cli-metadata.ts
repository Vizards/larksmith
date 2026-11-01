export type Risk = 'read' | 'write' | 'high-risk-write';
export interface FlagInfo { type: string; description: string }
export interface CommandMetadata { id: string; command: string[]; description: string; risk: Risk | null; flags: Record<string, FlagInfo>; help: string; schema?: unknown; authorization?: { access_tokens?: string[]; risk?: Risk; [key: string]: unknown } }

function resolveRisk(help: string, schemaRisk?: unknown): Risk | null {
  const labels = help.split(/\r?\n/).flatMap(line => {
    const match = /^[ \t]*Risk[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    return match ? [match[1]] : [];
  });
  const helpRisk = labels.length === 1
    ? /^(read|write|high-risk-write)(?:[ \t]+\([^\r\n]*\))?$/.exec(labels[0])?.[1] as Risk | undefined
    : undefined;
  // Schema is the structured source for raw APIs; help also covers shortcuts.
  // A missing source may use the other, but an unknown, ambiguous or conflicting
  // declaration blocks dispatch instead of guessing a lower risk.
  if (labels.length && !helpRisk) return null;
  if (schemaRisk !== undefined && schemaRisk !== 'read' && schemaRisk !== 'write' && schemaRisk !== 'high-risk-write') return null;
  if (schemaRisk !== undefined && helpRisk && schemaRisk !== helpRisk) return null;
  return schemaRisk ?? helpRisk ?? null;
}

export function parseHelp(command: string[], help: string, schemaRisk?: unknown): CommandMetadata {
  const risk = resolveRisk(help, schemaRisk);
  const flags: Record<string, FlagInfo> = {};
  let inFlags = false;
  for (const line of help.split('\n')) {
    if (/^[A-Z][^\n]*:$/.test(line)) inFlags = /^(?:Flags|Global Flags|API Parameters|Request Body|Raw Parameter Input|Execution|Output|Other):$/.test(line);
    if (!inFlags) continue;
    const match = /^\s+(?:-[A-Za-z], )?\s*--([a-z][a-z0-9-]*)(?: (\S+))?\s{2,}(.+)$/.exec(line);
    if (match) flags[match[1]] = { type: match[2] || 'bool', description: match[3] };
  }
  if (!help.includes(`lark-cli ${command.join(' ')} [flags]`)) throw new Error(`Unexpected help for ${command.join(' ')}`);
  return { id: command.join('/'), command, description: help.split('\n').find(line => line.trim()) || '', risk, flags, help };
}
