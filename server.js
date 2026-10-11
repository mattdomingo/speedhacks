// Vercel entry point. Vercel detects this exported Express app (zero-config Express) and
// deploys it as a single function; locally use `npm start` (backend/index.mjs) instead.
import { createRuntime } from './backend/runtime.mjs';

export default createRuntime().app;
