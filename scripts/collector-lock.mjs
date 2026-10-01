import { spawn } from 'node:child_process';

// Ubuntu's kernel releases flock when its process descriptors close, even
// after a crash. The persistent inode is not a stale ownership flag.
export function runWithCollectorLock(path, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '75', path, command, ...args], options);
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
