/**
 * Isolated trial integration tests: ephemeral local Postgres, never Railway.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 55432;
const PASSWORD = 'trial-test-local';

function run(command, args, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, ...extraEnv },
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`));
    });
  });
}

async function main() {
  await run('npx', ['tsx', 'scripts/test-trial-unit.ts'], {});

  const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koopplus-trial-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: PASSWORD,
    port: PORT,
    persistent: false,
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
  });

  const databaseUrl = `postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
  if (/railway|rlwy\.net|lisans-server-backend-production/i.test(databaseUrl)) {
    throw new Error('Refusing production DATABASE_URL');
  }
  if (process.env.DATABASE_URL && /railway|rlwy\.net|lisans-server-backend-production/i.test(process.env.DATABASE_URL)) {
    console.warn('Ignoring production DATABASE_URL from environment; using ephemeral local Postgres');
  }

  const extraEnv = {
    DATABASE_URL: databaseUrl,
    JWT_SECRET: process.env.JWT_SECRET || 'test-jwt-secret-min-32-chars-xxxx',
    ADMIN_EMAIL: 'admin@woontegra.com',
    ADMIN_PASSWORD: 'change-me-strong-password',
    INTEGRATION_SECRET: process.env.INTEGRATION_SECRET || 'change-me-integration-secret',
  };

  console.log(`Starting ephemeral Postgres on 127.0.0.1:${PORT}`);
  await pg.initialise();
  await pg.start();

  try {
    await run('npx', ['prisma', 'migrate', 'deploy'], extraEnv);
    await run('npx', ['tsx', 'scripts/test-trial.ts'], extraEnv);
    await run('npx', ['tsx', 'scripts/test-p0-saas.ts'], extraEnv);
    await run('npx', ['tsx', 'scripts/test-renew-license.ts'], extraEnv);
  } finally {
    try {
      await pg.stop();
    } catch (err) {
      console.error('Failed to stop ephemeral Postgres', err);
    }
    fs.rmSync(databaseDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
