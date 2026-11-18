import { env } from 'cloudflare:workers'
import { httpServerHandler } from 'cloudflare:node'

// Make Worker vars/secrets available to the existing Express modules through
// process.env. Bindings such as D1 and R2 remain available on globalThis for
// the storage migration.
for (const [key, value] of Object.entries(env)) {
  if (typeof value === 'string') process.env[key] = value
}

const { app } = await import('./index.js')
app.listen(3000)

export default httpServerHandler({ port: 3000 })
