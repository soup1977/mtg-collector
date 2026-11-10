// Small helpers for HTTP errors and input checks.
export const httpError = (status, message) => Object.assign(new Error(message), { status });

/** A whole number in [min, max], or a 400 error. */
export function int(value, name, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/** A string of at most `max` characters (trimmed), or null when empty. */
export function text(value, name, max) {
  if (value == null) return null;
  if (typeof value !== 'string') throw httpError(400, `${name} must be text`);
  const s = value.trim();
  if (s.length > max) throw httpError(400, `${name} is too long (max ${max} characters)`);
  return s || null;
}

/** Express handler wrapper: errors with a status become JSON responses; others go to the error handler. */
export const handle = (fn) => async (req, res, next) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
    next(e);
  }
};
