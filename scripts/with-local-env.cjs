/**
 * Kök .env (localhost) yükler; backend/.env içindeki production URL'yi ezmez, override eder.
 * Production Railway URL ile çalışmayı reddeder.
 */
const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

dotenv.config({
  path: path.resolve(__dirname, '../../.env'),
  override: true,
});

const url = process.env.DATABASE_URL || '';
if (/railway|rlwy\.net|lisans-server-backend-production/i.test(url)) {
  console.error('Refusing production DATABASE_URL');
  process.exit(2);
}
if (!/localhost|127\.0\.0\.1/i.test(url)) {
  console.error('DATABASE_URL is not local (localhost required)');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/with-local-env.cjs <command>...');
  process.exit(2);
}

const child = spawn(args[0], args.slice(1), {
  stdio: 'inherit',
  env: process.env,
  shell: true,
  cwd: path.resolve(__dirname, '..'),
});

child.on('exit', (code) => process.exit(code ?? 1));
