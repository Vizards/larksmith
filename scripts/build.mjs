import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBuild } from './check-build.mjs';

// Pin the official Linux binary and verify every download before packaging.
const { version, archiveSha256 } = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/cli-version.json', import.meta.url), 'utf8'));
execFileSync(process.execPath, ['scripts/compile.mjs'], { stdio: 'inherit' });
const { deploymentIssuer } = await import('../src/accounts.ts');
const issuer = deploymentIssuer();
const archiveUrl = `https://github.com/larksuite/cli/releases/download/v${version}/lark-cli-${version}-linux-amd64.tar.gz`;
const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, '.vercel/output');
const func = join(output, 'functions/api/probe.func');
const scratch = await mkdtemp(join(tmpdir(), 'larksmith-build-'));

try {
  const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Release download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== archiveSha256) throw new Error('Release checksum mismatch');
  const archive = join(scratch, 'cli.tar.gz');
  await writeFile(archive, bytes);
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (!members.includes('lark-cli')) throw new Error('Pinned archive layout changed');
  execFileSync('tar', ['-xzf', archive, '-C', scratch, 'lark-cli']);
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, 'static'), { recursive: true });
  if (process.env.BUILD_RUNTIME_PROBE === '1') {
  await mkdir(join(func, 'bin'), { recursive: true });
  await copyFile(join(scratch, 'lark-cli'), join(func, 'bin/lark-cli'));
  await chmod(join(func, 'bin/lark-cli'), 0o755);
  await copyFile(join(root, 'dist/src/probe.js'), join(func, 'index.mjs'));
  await writeFile(join(func, '.vc-config.json'), JSON.stringify({
    runtime: 'nodejs24.x', handler: 'index.mjs', launcherType: 'Nodejs', maxDuration: 30,
  }, null, 2));
  await writeFile(join(func, 'release.json'), JSON.stringify({ version, archiveSha256, archiveUrl }));
  }
  const bridge = join(output, 'functions/api/bridge.func');
  await mkdir(join(bridge, 'bin'), { recursive: true });
  await copyFile(join(scratch, 'lark-cli'), join(bridge, 'bin/lark-cli'));
  await chmod(join(bridge, 'bin/lark-cli'), 0o755);
  await cp(join(root, 'dist/src'), join(bridge, 'src'), { recursive: true });
  await mkdir(join(bridge, 'config'));
  for (const name of ['cli-version.json', 'cli-catalog.json']) await copyFile(join(root, 'config', name), join(bridge, 'config', name));
  await cp(join(root, 'node_modules'), join(bridge, 'node_modules'), { recursive: true });
  await writeFile(join(bridge, 'index.mjs'), "export { default } from './src/server.js';\n");
  await writeFile(join(bridge, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(bridge, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: 'index.mjs', launcherType: 'Nodejs', maxDuration: 300 }, null, 2));
  await cp(join(root, 'licenses'), join(bridge, 'licenses'), { recursive: true });
  await copyFile(join(root, 'NOTICE'), join(bridge, 'NOTICE'));
  if (process.env.BUILD_RUNTIME_PROBE === '1') await cp(join(root, 'licenses'), join(func, 'licenses'), { recursive: true });
  await checkBuild(bridge);
  const { writePublicRoutes } = await import('../dist/scripts/public-routes.js');
  const publicRoutes = await writePublicRoutes(output, issuer);
  await writeFile(join(output, 'config.json'), JSON.stringify({ version: 3, routes: [
    ...publicRoutes, { handle: 'filesystem' }, { src: '/.*', dest: '/api/bridge' },
  ] }));
  await writeFile(join(output, 'static/index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>larksmith</title><h1>larksmith</h1><p>官方 lark-cli 的远程 MCP 服务。</p><p>请在 MCP 客户端连接本网站的 /mcp 地址。首次连接将进入实例所有者登录页。</p><p>支持部署者配置的 user 身份的飞书 CLI 业务操作、文件上传下载和图片读取，并自动维护飞书授权。</p></html>');
  console.log(JSON.stringify({ built: true, version, archiveSha256, target: 'linux-x64' }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
