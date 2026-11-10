// Every request carries X-MTG-Client: the server rejects changes without it (cross-site protection).
// A 401 means the session ended: the app listens for 'mtg:logged-out' and shows the login screen.
async function req(method, url, body) {
  const opts = { method, headers: { 'X-MTG-Client': '1' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.code === 'LOGIN_REQUIRED') window.dispatchEvent(new Event('mtg:logged-out'));
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b),
  patch: (u, b) => req('PATCH', u, b),
  del: (u) => req('DELETE', u),
};
