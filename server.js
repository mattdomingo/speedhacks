// Vercel entry point. Vercel's zero-config Express support deploys the app exported here as a
// single function; it only recognizes an entry file that imports express itself.
// Locally use `npm start` (backend/index.mjs) instead.
import express from 'express';
import { createRuntime } from './backend/runtime.mjs';

const app = express();
app.disable('x-powered-by');
app.use(createRuntime().app);

export default app;
