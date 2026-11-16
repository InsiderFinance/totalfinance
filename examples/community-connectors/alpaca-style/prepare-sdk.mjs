import process from 'node:process';
import { copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const file = process.argv[2];
if (!file) throw Error('Supply the SDK tarball path');
const cwd = dirname(fileURLToPath(import.meta.url));
copyFileSync(resolve(file), resolve(cwd, 'sdk.tgz'));
if (execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim() !== '10.32.0')
  throw Error('Use pnpm10.32.0');
execFileSync('pnpm', ['install', '--lockfile-only'], { cwd, stdio: 'inherit' });
