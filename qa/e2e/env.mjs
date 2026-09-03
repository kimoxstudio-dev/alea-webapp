import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env.e2e.local');
dotenv.config({ path: envPath });

export const env = process.env;

export function requireE2EEnv(required) {
  for (const name of required) {
    if (!env[name]) throw new Error(`Missing env var in .env.e2e.local: ${name}`);
  }
  if (env.E2E_ALLOW_DESTRUCTIVE !== '1') {
    throw new Error('Refusing privileged E2E writes. Set E2E_ALLOW_DESTRUCTIVE=1 in .env.e2e.local.');
  }
}

export function chromiumLaunchOptions() {
  return {
    headless: true,
    ...(env.CHROME_PATH ? { executablePath: env.CHROME_PATH } : {}),
  };
}
