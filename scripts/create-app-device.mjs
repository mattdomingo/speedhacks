import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local provisioning only. Never prints the caller number, device code or registration.
// Configure APP_PAIRING_PATIENT (or DEMO_CALLER_NUMBER) in the ignored .env first.
const root = fileURLToPath(new URL('../', import.meta.url));
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const patient = process.env.APP_PAIRING_PATIENT || process.env.DEMO_CALLER_NUMBER;
const name = process.argv[2] || '.app-device';
if (!/^\+[1-9]\d{7,14}$/.test(patient ?? '')) {
  console.error('Set APP_PAIRING_PATIENT or DEMO_CALLER_NUMBER in the ignored .env.');
  process.exitCode = 1;
} else if (!/^\.app-device(?:-[A-Za-z0-9_-]+)?$/.test(name)) {
  console.error('Use a gitignored .app-device or .app-device-<name> output directory.');
  process.exitCode = 1;
} else {
  const directory = resolve(root, name);
  try {
    await mkdir(directory, { mode: 0o700 }); // Refuse to overwrite an existing device registration.
    const token = randomBytes(32).toString('base64url');
    const registration = [{ tokenHash: createHash('sha256').update(token).digest('hex'), patient }];
    await writeFile(resolve(directory, 'device-code.txt'), token + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(resolve(directory, 'registration.json'), JSON.stringify(registration) + '\n', { mode: 0o600, flag: 'wx' });
    console.log('Device code and server registration saved privately. See docs/ios-memory.md for setup.');
  } catch {
    console.error('Could not create the private registration. Choose a new .app-device-<name> directory and check filesystem permissions.');
    process.exitCode = 1;
  }
}
