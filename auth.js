import crypto from 'node:crypto'
import { getSessionSecret, readUsers } from './store.js'

export const DEFAULT_GOOGLE_CLIENT_ID = '736751601586-2baq2h5dhvj2526rhkuk4ihkrc26ghbo.apps.googleusercontent.com'
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID

const SESSION_COOKIE_NAME = 'nm_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const ADMIN_SESSION_COOKIE_NAME = 'nm_admin_session'
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000

const jwksCache = new Map()

function base64UrlToBuffer(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)
  return Buffer.from(padded, 'base64')
}

function decodeJwt(token) {
  if (typeof token !== 'string') throw new Error('Invalid token format.')
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT structure.')
  const [headerB64, payloadB64, signatureB64] = parts
  const header = JSON.parse(base64UrlToBuffer(headerB64).toString('utf8'))
  const payload = JSON.parse(base64UrlToBuffer(payloadB64).toString('utf8'))
  return {
    header,
    payload,
    signingInput: Buffer.from(`${headerB64}.${payloadB64}`),
    signature: base64UrlToBuffer(signatureB64),
  }
}

async function fetchJwks(url) {
  const cached = jwksCache.get(url)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch JWKS from ${url} (${response.status})`)
  const data = await response.json()
  const keys = Array.isArray(data?.keys) ? data.keys : []
  jwksCache.set(url, { keys, expiresAt: Date.now() + 60 * 60 * 1000 })
  return keys
}

async function verifyRs256Jwt(token, jwksUrl) {
  const { header, payload, signingInput, signature } = decodeJwt(token)
  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported JWT algorithm or missing key id.')
  }
  let keys = await fetchJwks(jwksUrl)
  let jwk = keys.find(item => item.kid === header.kid)
  if (!jwk) {
    // Bust cache once in case keys rotated
    jwksCache.delete(jwksUrl)
    keys = await fetchJwks(jwksUrl)
    jwk = keys.find(item => item.kid === header.kid)
  }
  if (!jwk) throw new Error('Signing key not found in JWKS.')
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  const valid = crypto.verify('RSA-SHA256', signingInput, publicKey, signature)
  if (!valid) throw new Error('Invalid JWT signature.')
  const nowSec = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error('Token has expired.')
  }
  return payload
}

export async function verifyGoogleIdToken(credential) {
  const payload = await verifyRs256Jwt(credential, 'https://www.googleapis.com/oauth2/v3/certs')
  const validIssuers = ['https://accounts.google.com', 'accounts.google.com']
  if (!validIssuers.includes(payload.iss)) throw new Error('Invalid Google token issuer.')
  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error('Google token client ID mismatch.')
  if (!payload.sub || !payload.email || payload.email_verified !== true) {
    throw new Error('Google account email is not verified.')
  }
  return {
    sub: String(payload.sub),
    email: String(payload.email).toLowerCase(),
    name: String(payload.name || payload.email.split('@')[0]),
    picture: typeof payload.picture === 'string' ? payload.picture : '',
  }
}

export function parseCookies(req) {
  const raw = req.headers.cookie || ''
  const result = {}
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    try { result[key] = decodeURIComponent(val) } catch { result[key] = val }
  }
  return result
}

export async function createSessionCookieValue(user) {
  const secret = await getSessionSecret()
  const payload = {
    sub: user.sub,
    email: user.email,
    exp: Date.now() + SESSION_TTL_MS,
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

export async function readSessionFromRequest(req) {
  const cookies = parseCookies(req)
  const token = cookies[SESSION_COOKIE_NAME]
  if (!token || !token.includes('.')) return null
  const [encoded, sig] = token.split('.')
  if (!encoded || !sig) return null
  const secret = await getSessionSecret()
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  const actualBuf = Buffer.from(sig)
  const expectedBuf = Buffer.from(expected)
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    return null
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (!payload?.sub || typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export function setSessionCookie(res, value, req) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || (process.env.PUBLIC_SITE_URL || '').startsWith('https://')
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (isHttps) attrs.push('Secure')
  res.setHeader('Set-Cookie', attrs.join('; '))
}

export function clearSessionCookie(res, req) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || (process.env.PUBLIC_SITE_URL || '').startsWith('https://')
  const attrs = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (isHttps) attrs.push('Secure')
  res.setHeader('Set-Cookie', attrs.join('; '))
}

export async function requireUser(req, res, next) {
  try {
    const session = await readSessionFromRequest(req)
    if (!session) {
      return res.status(401).json({ message: 'Please sign in with Google to continue.' })
    }
    const users = await readUsers()
    const user = users.find(item => item.sub === session.sub || item.id === session.sub)
    if (!user) {
      clearSessionCookie(res, req)
      return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' })
    }
    if (user.banned) {
      clearSessionCookie(res, req)
      return res.status(403).json({ message: 'Your Google account has been suspended from NixMix Audio. Please contact support.' })
    }
    req.user = user
    return next()
  } catch (error) {
    console.error('Auth error:', error.message)
    return res.status(401).json({ message: 'Authentication check failed.' })
  }
}

export async function verifyAdminPassword(password) {
  const configured = String(process.env.ADMIN_PASSWORD || '')
  if (!configured || typeof password !== 'string') return false
  const secret = await getSessionSecret()
  const actual = crypto.createHmac('sha256', secret).update(password).digest()
  const expected = crypto.createHmac('sha256', secret).update(configured).digest()
  return crypto.timingSafeEqual(actual, expected)
}

export async function createAdminSessionCookieValue() {
  const secret = await getSessionSecret()
  const payload = { exp: Date.now() + ADMIN_SESSION_TTL_MS }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

export async function readAdminSessionFromRequest(req) {
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE_NAME]
  if (!token || !token.includes('.')) return null
  const [encoded, sig] = token.split('.')
  const secret = await getSessionSecret()
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  const actualBuf = Buffer.from(sig || '')
  const expectedBuf = Buffer.from(expected)
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    return payload?.exp > Date.now() ? payload : null
  } catch {
    return null
  }
}

export function setAdminSessionCookie(res, value, req) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || (process.env.PUBLIC_SITE_URL || '').startsWith('https://')
  const attrs = [`${ADMIN_SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`]
  if (isHttps) attrs.push('Secure')
  res.setHeader('Set-Cookie', attrs.join('; '))
}

export function clearAdminSessionCookie(res, req) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || (process.env.PUBLIC_SITE_URL || '').startsWith('https://')
  const attrs = [`${ADMIN_SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (isHttps) attrs.push('Secure')
  res.setHeader('Set-Cookie', attrs.join('; '))
}

export async function requireAdmin(req, res, next) {
  const session = await readAdminSessionFromRequest(req)
  if (!session) return res.status(401).json({ message: 'Admin password required.' })
  req.admin = { ok: true, email: 'admin', mode: 'password' }
  return next()
}
