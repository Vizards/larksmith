import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const run = promisify(execFile);

// This public probe accepts no commands, paths, URLs, identities or credentials.
export default async function handler(request: IncomingMessage, response: ServerResponse) {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    response.statusCode = 405;
    response.end(JSON.stringify({ ok: false, error: 'METHOD_NOT_ALLOWED' }));
    return;
  }
  let scratch;
  let result;
  let status = 200;
  try {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      throw new Error('UNEXPECTED_RUNTIME');
    }
    scratch = await mkdtemp(join(tmpdir(), 'larksmith-request-'));
    await mkdir(join(scratch, 'config'));
    const marker = randomUUID();
    await writeFile(join(scratch, 'marker'), marker, { mode: 0o600 });
    const env = {
      PATH: '/usr/bin:/bin', HOME: scratch, XDG_CONFIG_HOME: join(scratch, 'config'),
      TMPDIR: scratch, LANG: 'C.UTF-8',
    };
    const options = { cwd: scratch, env, timeout: 8_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' as const };
    const binary = fileURLToPath(new URL('./bin/lark-cli', import.meta.url));
    const release = JSON.parse(await readFile(new URL('./release.json', import.meta.url), 'utf8'));
    const [version, help] = await Promise.all([
      run(binary, ['--version'], options),
      run(binary, ['sheets', '--help'], options),
    ]);
    const isolated = await readFile(join(scratch, 'marker'), 'utf8') === marker;
    if (version.stdout.trim() !== `lark-cli version ${release.version}` || !help.stdout.includes('Usage:') || !isolated) {
      throw new Error('PROBE_ASSERTION_FAILED');
    }
    result = { ok: true, runtime: { node: process.version, platform: process.platform, arch: process.arch },
      cli: version.stdout.trim(), sheetsHelp: true, scratchIsolated: isolated, requestId: marker };
  } catch (error) {
    status = 500;
    // Avoid echoing child stderr, paths or future environment secrets.
    result = { ok: false, error: 'RUNTIME_PROBE_FAILED', reason: String(error.code || error.name || 'Error') };
  } finally {
    if (scratch) {
      try { await rm(scratch, { recursive: true, force: true }); }
      catch { status = 500; result = { ok: false, error: 'SCRATCH_CLEANUP_FAILED' }; }
    }
  }
  response.statusCode = status;
  response.end(JSON.stringify({ ...result, scratchCleaned: Boolean(scratch) && status === 200 }));
};
