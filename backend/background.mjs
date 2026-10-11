import { waitUntil } from '@vercel/functions';

// Work that must outlive the response. On Vercel, waitUntil keeps the function alive until it
// settles; on a long-running server it simply runs. Errors are logged, never thrown.
export function background(promise, label = 'Background task') {
  const settled = Promise.resolve(promise).catch(error => console.error(`${label} failed: ${error.message}`));
  waitUntil(settled);
  return settled;
}
