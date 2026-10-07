import assert from 'node:assert/strict';
import { ensureFirstAdmin, type SeedAdminRow } from '../src/seedAdmin';

const store: SeedAdminRow[] = [];
let creates = 0;

async function hashPassword(password: string): Promise<string> {
  return `hash:${password}`;
}

async function create(data: { email: string; passwordHash: string; name: string }): Promise<SeedAdminRow> {
  creates += 1;
  const row: SeedAdminRow = { id: 'admin-1', ...data };
  store.push(row);
  return row;
}

async function main() {
const first = await ensureFirstAdmin({
  existing: store[0] ?? null,
  email: 'info@woontegra.com',
  password: 'ilk-parola',
  hashPassword,
  create,
});
assert.equal(first.created, true);
assert.equal(first.admin.passwordHash, 'hash:ilk-parola');

const beforeRestart = {
  id: first.admin.id,
  email: first.admin.email,
  passwordHash: first.admin.passwordHash,
  name: first.admin.name,
};

const second = await ensureFirstAdmin({
  existing: store[0],
  email: 'baska@woontegra.com',
  password: 'railway-yeni-parola',
  hashPassword,
  create,
});

assert.equal(second.created, false);
assert.equal(creates, 1);
assert.deepEqual(
  {
    id: second.admin.id,
    email: second.admin.email,
    passwordHash: second.admin.passwordHash,
    name: second.admin.name,
  },
  beforeRestart,
);
assert.equal(store[0].passwordHash, 'hash:ilk-parola');
assert.notEqual(store[0].passwordHash, 'hash:railway-yeni-parola');

console.log('seed admin restart check passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
