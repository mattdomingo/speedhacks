import { spawn } from 'node:child_process';

const child = spawn(process.env.PYTHON || 'python3', ['camera/capture.py', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, BACKEND_URL: process.env.BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 3000}` },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
