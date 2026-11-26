// Every state-changing request to kronikarz-server must carry this header
// (CSRF guard — see server/index.js). Use apiWrite() for PUT/POST/DELETE.
export const WRITE_HEADER = 'X-Kronikarz';

export function apiWrite(
  url: string,
  init: RequestInit & { method: 'PUT' | 'POST' | 'DELETE' },
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(WRITE_HEADER, '1');
  return fetch(url, { ...init, headers });
}
