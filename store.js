import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const dataDir = process.env.DATA_DIR || path.join(here, 'data')
export const downloadsDir = process.env.DOWNLOADS_DIR || path.join(here, 'downloads')
export const uploadsDir = path.join(dataDir, 'uploads')

const ordersFile = path.join(dataDir, 'orders.json')
const usersFile = path.join(dataDir, 'users.json')
const productsFile = path.join(dataDir, 'products.json')
const contactRequestsFile = path.join(dataDir, 'contact-requests.json')
const sessionSecretFile = path.join(dataDir, '.session-secret')

export const DEFAULT_PRODUCTS = [
  {
    id: 'devorra',
    name: 'Devorra',
    eyebrow: 'SPATIAL EFFECTS',
    category: 'Spatial effects',
    status: 'available',
    pricePaise: 0,
    priceLabel: '',
    description: 'Two expressive effects. One inspiring return. Reverb, delay and a shared return EQ.',
    longDescription: 'Devorra brings reverb and delay together in one spatial effects plugin, with category-based starting presets, a shared return EQ and flexible insert or bus routing.',
    mainImage: '/devorra/01-plugin-interface.png?v=current-20261030',
    featureImages: [
      {
        id: 'devorra-engines',
        eyebrow: '01 · TWO EFFECT ENGINES',
        title: 'Reverb + delay, together.',
        description: 'Shape room, decay, size, pre-delay and stereo width in the reverb engine. Add delay time, feedback, modulation, filtering or ping-pong in the second engine. Blend them in parallel or series.',
        image: '',
        kind: 'engines',
      },
      {
        id: 'devorra-presets',
        eyebrow: '02 · SOUND-CATEGORY PRESETS',
        title: 'A starting point for every sound.',
        description: 'Choose a sound category, then explore its variations: vocals, drums, guitars, keys, strings, woodwinds, brass and synths.',
        image: '',
        kind: 'presets',
      },
      {
        id: 'devorra-eq',
        eyebrow: '03 · EFFECT RETURN EQ',
        title: 'Sculpt the space around it.',
        description: 'Shape the combined effect return with high-pass and low-pass filters plus parametric bands. Tune frequency and gain on the graph, then adjust Q.',
        image: '',
        kind: 'eq',
      },
      {
        id: 'devorra-workflow',
        eyebrow: '04 · SESSION-READY CONTROL',
        title: 'Fits the way you mix.',
        description: 'Start in parallel or series on an insert, or use wet-only mode on a bus. Sync delay repeats to your host tempo, resize the window and zoom to the controls.',
        image: '',
        kind: 'workflow',
      },
    ],
    platforms: ['Windows — VST3', 'macOS — VST3 & AU'],
    accent: 'lime',
    highlights: ['REVERB + DELAY', 'SHARED RETURN EQ', 'PARALLEL / SERIES'],
    files: { bundle: 'devorra-windows-mac.zip' },
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  },
  {
    id: 'auvoryn',
    name: 'Auvoryn',
    eyebrow: 'MASTERING LIMITER',
    category: 'Mastering limiter',
    status: 'available',
    pricePaise: 0,
    priceLabel: '',
    description: 'True peak control, five limiter styles and clear loudness metering in one focused mastering view.',
    longDescription: 'Auvoryn is a stereo mastering limiter with a true peak ceiling, adjustable lookahead and release behavior, selectable limiter styles, and post-limiter loudness measurements. Its loudness targets are visual references, not automatic normalization.',
    mainImage: '/auvoryn/01-plugin-interface.png?v=current-20261030',
    featureImages: [
      {
        id: 'auvoryn-style',
        eyebrow: 'LIMITER CHARACTER',
        title: 'Find the release that fits.',
        description: 'Choose Modern, Clean, Transparent, Vintage or Punch. Each mode brings a distinct release character—try them against the track instead of chasing one preset.',
        image: '',
      },
      {
        id: 'auvoryn-envelope',
        eyebrow: 'SHAPE THE ENVELOPE',
        title: 'Set the pressure, then the response.',
        description: 'Set Input (−24 to +24 dB) and True Peak Ceiling (−12 to 0 dBTP). Then tune Lookahead (0–10 ms), Attack (0.1–1000 ms) and Release (20–500 ms) to decide how quickly the limiter catches and lets go.',
        image: '',
      },
      {
        id: 'auvoryn-stereo',
        eyebrow: 'STEREO + OVERSAMPLING',
        title: 'Keep the image together.',
        description: 'Adjust Stereo Link to control how closely the left and right channels move together, then choose 2×, 4× or 8× oversampled peak detection. Fixed host latency keeps timing steady; latency-matched bypass makes A/B checks easier.',
        image: '',
      },
      {
        id: 'auvoryn-loudness',
        eyebrow: 'LOUDNESS, IN CONTEXT',
        title: 'Read the whole picture.',
        description: 'Follow input, output and gain reduction across the recent five-second graph. Master meters show true peak; the loudness panel tracks short-term and momentary values, integrated LUFS, maximum momentary and LRA. Set a LUFS reference target and reset between programmes.',
        image: '',
      },
    ],
    platforms: ['Windows — VST3', 'macOS — VST3 & AU'],
    accent: 'mint',
    highlights: ['TRUE PEAK CEILING', '5 LIMITER STYLES', 'LUFS HISTORY'],
    files: { bundle: 'auvoryn-windows-mac.zip' },
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  },
  {
    id: 'vorzyn',
    name: 'Vorzyn',
    eyebrow: 'SATURATOR LAB · COMING SOON',
    category: 'Saturation',
    status: 'coming_soon',
    pricePaise: 0,
    priceLabel: '',
    description: 'Warm tape character, harmonic shaping and a hands-on four-band EQ in one focused saturation workspace.',
    longDescription: 'Start with a sound such as Warm Tape, choose a saturation model and harmonic balance, then shape Input, Drive, Tone, Punish, Mix and Output. A four-band graph EQ, saturation risk meter, A/B comparison, Auto Gain, Soft Clip, oversampling and zoom controls complete the workflow.',
    mainImage: '/vorzyn/01-plugin-interface.png',
    featureImages: [
      {
        id: 'vorzyn-color',
        eyebrow: '01 / FIND YOUR COLOR',
        title: 'Start with the sound in mind.',
        description: 'Choose a starting preset like Warm Tape, then select a saturation model and set the Harmonic Balance to Odd, Both or Even. Explore subtle warmth, thicker overtones or more adventurous color.',
        image: '',
      },
      {
        id: 'vorzyn-drive',
        eyebrow: '02 / PUSH WITH CONTROL',
        title: 'Drive the tone, keep your bearings.',
        description: 'Set Input and Drive, fine-tune Tone, and bring in Punish when you want a stronger edge. The live Saturation Risk meter gives you a quick visual cue as you push the signal.',
        image: '',
      },
      {
        id: 'vorzyn-eq',
        eyebrow: '03 / SHAPE EACH BAND',
        title: 'Make room around the character.',
        description: 'Sculpt the four-band EQ from its response graph. Switch bands on or off, choose a filter shape, and tune Frequency, Gain and Q. Place the EQ before or after the saturation stage.',
        image: '',
      },
      {
        id: 'vorzyn-finish',
        eyebrow: '04 / FINISH THE CHAIN',
        title: 'Keep the blend feeling right.',
        description: 'Balance Mix and Output, then choose Auto Gain, Soft Clip and oversampling to suit your session. Compare A and B states, save a preset direction and zoom the interface to your preferred scale.',
        image: '',
      },
    ],
    platforms: ['Windows — VST3', 'macOS — VST3 & AU'],
    accent: 'copper',
    highlights: ['WARM TAPE + MODEL CHOICES', 'FOUR-BAND SHAPING EQ', 'A/B · AUTO GAIN · SOFT CLIP'],
    files: { bundle: 'vorzyn-windows-mac.zip' },
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  },
]

const queues = new Map()
let d1SchemaPromise = null

function getD1() {
  return globalThis.__NIXMIX_DB || null
}

async function ensureD1Schema() {
  const db = getD1()
  if (!db) return null
  if (!d1SchemaPromise) {
    d1SchemaPromise = db.prepare(`
      CREATE TABLE IF NOT EXISTS nixmix_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      )
    `).run()
  }
  await d1SchemaPromise
  return db
}

async function readD1Records(kind) {
  const db = await ensureD1Schema()
  if (!db) return null
  const result = await db.prepare('SELECT id, data FROM nixmix_records WHERE kind = ? ORDER BY updated_at ASC').bind(kind).all()
  return (result.results || []).map(row => JSON.parse(row.data))
}

async function upsertD1Records(kind, records) {
  const db = await ensureD1Schema()
  if (!db) return
  const now = new Date().toISOString()
  await db.batch(records.map(record => db.prepare(`
    INSERT INTO nixmix_records (kind, id, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).bind(kind, String(record.id), JSON.stringify(record), now)))
}

async function replaceD1Records(kind, records) {
  const db = await ensureD1Schema()
  if (!db) return
  const now = new Date().toISOString()
  const statements = [db.prepare('DELETE FROM nixmix_records WHERE kind = ?').bind(kind)]
  statements.push(...records.map(record => db.prepare(`
    INSERT INTO nixmix_records (kind, id, data, updated_at) VALUES (?, ?, ?, ?)
  `).bind(kind, String(record.id), JSON.stringify(record), now)))
  await db.batch(statements)
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJsonAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempFile = `${filePath}.tmp`
  await fs.writeFile(tempFile, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.rename(tempFile, filePath)
}

function enqueue(filePath, task) {
  const prev = queues.get(filePath) || Promise.resolve()
  const next = prev.then(task, task)
  queues.set(filePath, next)
  return next
}

let cachedSessionSecret = null
export async function getSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET
  }
  if (cachedSessionSecret) return cachedSessionSecret
  const db = await ensureD1Schema()
  if (db) {
    const existing = await db.prepare('SELECT data FROM nixmix_records WHERE kind = ? AND id = ?').bind('meta', 'session-secret').first()
    if (existing?.data) {
      cachedSessionSecret = existing.data
      return cachedSessionSecret
    }
    cachedSessionSecret = crypto.randomBytes(32).toString('hex')
    await db.prepare(`
      INSERT INTO nixmix_records (kind, id, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).bind('meta', 'session-secret', cachedSessionSecret, new Date().toISOString()).run()
    return cachedSessionSecret
  }
  try {
    cachedSessionSecret = (await fs.readFile(sessionSecretFile, 'utf8')).trim()
    if (cachedSessionSecret.length >= 32) return cachedSessionSecret
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await fs.mkdir(dataDir, { recursive: true })
  cachedSessionSecret = crypto.randomBytes(32).toString('hex')
  await fs.writeFile(sessionSecretFile, cachedSessionSecret, { mode: 0o600 })
  return cachedSessionSecret
}

export async function readOrders() {
  const d1 = await readD1Records('order')
  if (d1) return d1
  return readJsonFile(ordersFile, [])
}

export function saveOrder(order) {
  if (getD1()) {
    return (async () => {
      const batch = Array.isArray(order) ? order : [order]
      await upsertD1Records('order', batch)
      return order
    })()
  }
  return enqueue(ordersFile, async () => {
    const orders = await readOrders()
    const batch = Array.isArray(order) ? order : [order]
    for (const item of batch) {
      const idx = orders.findIndex(saved => saved.id === item.id)
      if (idx >= 0) orders[idx] = item
      else orders.push(item)
    }
    await writeJsonAtomic(ordersFile, orders)
    return order
  })
}

export async function readUsers() {
  const d1 = await readD1Records('user')
  if (d1) return d1
  return readJsonFile(usersFile, [])
}

export async function readContactRequests() {
  const d1 = await readD1Records('request')
  if (d1) return d1
  return readJsonFile(contactRequestsFile, [])
}

export function saveContactRequest(request) {
  if (getD1()) {
    return upsertD1Records('request', [request]).then(() => request)
  }
  return enqueue(contactRequestsFile, async () => {
    const requests = await readContactRequests()
    const index = requests.findIndex(item => item.id === request.id)
    if (index >= 0) requests[index] = request
    else requests.unshift(request)
    await writeJsonAtomic(contactRequestsFile, requests.slice(0, 1000))
    return request
  })
}

export function updateContactRequest(id, patch) {
  if (getD1()) {
    return (async () => {
      const requests = await readContactRequests()
      const existing = requests.find(item => item.id === id)
      if (!existing) return null
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() }
      await upsertD1Records('request', [updated])
      return updated
    })()
  }
  return enqueue(contactRequestsFile, async () => {
    const requests = await readContactRequests()
    const index = requests.findIndex(item => item.id === id)
    if (index < 0) return null
    requests[index] = { ...requests[index], ...patch, updatedAt: new Date().toISOString() }
    await writeJsonAtomic(contactRequestsFile, requests)
    return requests[index]
  })
}

export function upsertUser(profile) {
  if (getD1()) {
    return (async () => {
      const users = await readUsers()
      const now = new Date().toISOString()
      const idx = users.findIndex(u => u.id === profile.sub || u.email === profile.email.toLowerCase())
      if (idx >= 0) {
        const existing = users[idx]
        const updated = {
          ...existing,
          id: profile.sub || existing.id,
          sub: profile.sub || existing.sub,
          email: profile.email.toLowerCase(),
          name: profile.name || existing.name,
          picture: profile.picture || existing.picture,
          lastLoginAt: now,
        }
        await upsertD1Records('user', [updated])
        return updated
      }
      const created = {
        id: profile.sub,
        sub: profile.sub,
        email: profile.email.toLowerCase(),
        name: profile.name || profile.email.split('@')[0],
        picture: profile.picture || '',
        phone: '',
        banned: false,
        bannedAt: null,
        bannedReason: '',
        createdAt: now,
        lastLoginAt: now,
      }
      await upsertD1Records('user', [created])
      return created
    })()
  }
  return enqueue(usersFile, async () => {
    const users = await readUsers()
    const now = new Date().toISOString()
    const idx = users.findIndex(u => u.id === profile.sub || u.email === profile.email.toLowerCase())
    if (idx >= 0) {
      const existing = users[idx]
      users[idx] = {
        ...existing,
        id: profile.sub || existing.id,
        sub: profile.sub || existing.sub,
        email: profile.email.toLowerCase(),
        name: profile.name || existing.name,
        picture: profile.picture || existing.picture,
        lastLoginAt: now,
      }
      await writeJsonAtomic(usersFile, users)
      return users[idx]
    }
    const created = {
      id: profile.sub,
      sub: profile.sub,
      email: profile.email.toLowerCase(),
      name: profile.name || profile.email.split('@')[0],
      picture: profile.picture || '',
      phone: '',
      banned: false,
      bannedAt: null,
      bannedReason: '',
      createdAt: now,
      lastLoginAt: now,
    }
    users.push(created)
    await writeJsonAtomic(usersFile, users)
    return created
  })
}

export function updateUser(userId, patch) {
  if (getD1()) {
    return (async () => {
      const users = await readUsers()
      const idx = users.findIndex(u => u.id === userId || u.sub === userId)
      if (idx < 0) return null
      const updated = { ...users[idx], ...patch }
      await upsertD1Records('user', [updated])
      return updated
    })()
  }
  return enqueue(usersFile, async () => {
    const users = await readUsers()
    const idx = users.findIndex(u => u.id === userId || u.sub === userId)
    if (idx < 0) return null
    users[idx] = { ...users[idx], ...patch }
    await writeJsonAtomic(usersFile, users)
    return users[idx]
  })
}

export async function readProducts() {
  const d1 = await readD1Records('product')
  if (d1 && d1.length > 0) return d1
  if (d1) {
    await replaceD1Records('product', DEFAULT_PRODUCTS)
    return DEFAULT_PRODUCTS
  }
  const existing = await readJsonFile(productsFile, null)
  if (Array.isArray(existing) && existing.length > 0) return existing
  // Seed defaults on first access
  return enqueue(productsFile, async () => {
    const recheck = await readJsonFile(productsFile, null)
    if (Array.isArray(recheck) && recheck.length > 0) return recheck
    await writeJsonAtomic(productsFile, DEFAULT_PRODUCTS)
    return DEFAULT_PRODUCTS
  })
}

export function saveProducts(products) {
  if (getD1()) return replaceD1Records('product', products).then(() => products)
  return enqueue(productsFile, async () => {
    await writeJsonAtomic(productsFile, products)
    return products
  })
}

export function mutateProducts(mutator) {
  if (getD1()) {
    return (async () => {
      const current = await readProducts()
      const updated = await mutator([...current])
      await replaceD1Records('product', updated)
      return updated
    })()
  }
  return enqueue(productsFile, async () => {
    const current = await readJsonFile(productsFile, null)
    const list = Array.isArray(current) && current.length > 0 ? [...current] : [...DEFAULT_PRODUCTS]
    const updated = await mutator(list)
    await writeJsonAtomic(productsFile, updated)
    return updated
  })
}
