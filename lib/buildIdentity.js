import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

export function buildIdentity() {
  const files = ['server.js', 'app.js', 'package.json', 'package-lock.json'];
  function collect(directory) {
    for (const entry of readdirSync(new URL(directory, root), { withFileTypes: true })) {
      const path = `${directory}${entry.name}`;
      if (entry.isDirectory()) collect(`${path}/`);
      else if (entry.name.endsWith('.js')) files.push(path);
    }
  }
  for (const directory of ['config/', 'controllers/', 'lib/', 'middleware/', 'routes/', 'services/', 'utils/']) collect(directory);
  const hash = createHash('sha256');
  for (const path of files.sort()) {
    hash.update(path).update('\0');
    // Git's Windows checkout may use CRLF; deployments normally use LF.
    hash.update(readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n')).update('\0');
  }
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(root), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch { /* Hostinger artifacts may omit .git. The fingerprint still verifies source. */ }
  return { commit: /^[a-f0-9]{40}$/.test(commit || '') ? commit : null, sourceFingerprint: hash.digest('hex') };
}
