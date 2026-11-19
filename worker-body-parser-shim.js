// Express imports body-parser even when the application does not use its
// parser helpers. Cloudflare Workers cannot bundle body-parser's iconv-lite
// dependency, so Wrangler aliases it to these no-op exports for the Worker.
// The application installs its own JSON parser in index.js.
function passthrough() {
  return (_req, _res, next) => next()
}

export const json = passthrough
export const raw = passthrough
export const text = passthrough
export const urlencoded = passthrough

export default { json, raw, text, urlencoded }
