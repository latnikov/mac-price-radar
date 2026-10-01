import { readFileSync } from 'node:fs';
import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export function createStaffAuth(env) {
  const entries = env.STORE_STAFF_USERS_FILE ? JSON.parse(readFileSync(env.STORE_STAFF_USERS_FILE, 'utf8')) : [];
  if (!Array.isArray(entries) || entries.length > 20) throw new Error('Invalid staff configuration');
  const users = new Map();
  for (const user of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]{1,31}$/.test(user.username) || !['owner', 'manager'].includes(user.role)
      || !/^[a-f0-9]{32}$/.test(user.salt) || !/^[a-f0-9]{64}$/.test(user.hash)
      || users.has(user.username.toLowerCase())) throw new Error('Invalid staff entry');
    users.set(user.username.toLowerCase(), user);
  }
  let pending = 0;
  return {
    configured: users.size > 0,
    async verify(username, password) {
      if (pending >= 4) return null;
      pending++;
      try {
        const user = users.get(String(username || '').trim().toLowerCase());
        // Unknown users take the same hash path; names and roles are never inferred from input.
        const actual = await derive(String(password || '').slice(0, 256), user?.salt || '0'.repeat(32), 32);
        const expected = Buffer.from(user?.hash || '0'.repeat(64), 'hex');
        return timingSafeEqual(actual, expected) && user ? { username: user.username, role: user.role } : null;
      } finally { pending--; }
    },
  };
}
