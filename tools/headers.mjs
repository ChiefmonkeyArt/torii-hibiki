// tools/headers.mjs — the response headers for the static files. install.sh
// renders the same values into the nginx fragment (tests check they agree).
export const SHELL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
export const NAPPLET_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts";
export const HEADERS = {
  common: { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache', 'permissions-policy': 'geolocation=(), microphone=(), camera=()' },
  shell: { 'content-security-policy': SHELL_CSP, 'x-frame-options': 'SAMEORIGIN' },
  napplet: { 'content-security-policy': NAPPLET_CSP },
  fonts: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=2592000' },
};
