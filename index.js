import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import Razorpay from 'razorpay'
import {
  clearSessionCookie,
  clearAdminSessionCookie,
  createAdminSessionCookieValue,
  createSessionCookieValue,
  GOOGLE_CLIENT_ID,
  requireAdmin,
  requireUser,
  setSessionCookie,
  setAdminSessionCookie,
  verifyAdminPassword,
  verifyGoogleIdToken,
  readSessionFromRequest,
} from './auth.js'
import {
  downloadsDir,
  mutateProducts,
  readContactRequests,
  readOrders,
  readProducts,
  readUsers,
  saveOrder,
  saveContactRequest,
  updateContactRequest,
  updateUser,
  uploadsDir,
  upsertUser,
} from './store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = express()
// Render and Cloudflare terminate TLS before forwarding requests to Node.
// Trusting the first proxy lets Express correctly identify HTTPS requests.
app.set('trust proxy', 1)
const port = Number(process.env.PORT || 3000)
const publicSiteUrl = (process.env.PUBLIC_SITE_URL || `http://localhost:${port}`).replace(/\/$/, '')
const apiPublicUrl = (process.env.API_PUBLIC_URL || publicSiteUrl).replace(/\/$/, '')
const allowedOrigins = String(process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map(value => value.trim().replace(/\/$/, ''))
  .filter(Boolean)
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
let exchangeRatesCache = { expiresAt: 0, rates: { INR: 1 } }

// Express's built-in JSON parser pulls in body-parser/iconv-lite, which is not
// compatible with the Cloudflare Workers runtime. Keep parsing local and
// lightweight so the same app works in Node and Workers.
app.use(async (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next()
  const contentType = String(req.headers['content-type'] || '').toLowerCase()
  if (!contentType.includes('application/json')) return next()
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    req.body = raw ? JSON.parse(raw) : {}
    return next()
  } catch {
    return res.status(400).json({ message: 'Invalid JSON body.' })
  }
})
app.use((req, res, next) => {
  const origin = String(req.headers.origin || '').replace(/\/$/, '')
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(origin && allowedOrigins.includes(origin) ? 204 : 403)
  return next()
})
app.use('/uploads', express.static(uploadsDir, { fallthrough: true }))

function isMailerConfigured() {
  return Boolean(process.env.RESEND_API_KEY && (process.env.RESEND_FROM || process.env.MAIL_FROM))
}

async function sendResendEmail({ from, to, replyTo, subject, text, html }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, ...(replyTo ? { reply_to: replyTo } : {}), subject, text, html }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const error = new Error(data?.message || `Resend email failed (${response.status}).`)
    error.code = 'RESEND_ERROR'
    throw error
  }
  return response.json()
}

async function getAssetForProduct(product, platform, expectedFile = '') {
  const fileName = expectedFile || product?.files?.bundle || product?.files?.[platform] || product?.files?.windows || product?.files?.mac
  const objectKey = product?.files?.bundleKey || product?.files?.[`${platform}Key`]
  const r2 = globalThis.__NIXMIX_DOWNLOADS
  if (r2 && objectKey) {
    if (expectedFile && product?.files?.bundle && expectedFile !== product.files.bundle) return null
    const object = await r2.get(objectKey)
    return object ? { fileName: product.files.bundle || fileName || 'installer.zip', objectKey, object } : null
  }
  if (!fileName || path.basename(fileName) !== fileName) return null
  const filePath = path.join(downloadsDir, fileName)
  try {
    await fs.access(filePath)
    return { fileName, filePath }
  } catch {
    return null
  }
}

async function sendAsset(res, asset) {
  if (asset.object) {
    res.setHeader('Content-Type', asset.object.httpMetadata?.contentType || 'application/zip')
    res.setHeader('Content-Length', String(asset.object.size || 0))
    res.setHeader('Content-Disposition', `attachment; filename="${String(asset.fileName).replace(/["\\\r\n]/g, '_')}"`)
    return res.end(Buffer.from(await asset.object.arrayBuffer()))
  }
  return res.download(asset.filePath, asset.fileName)
}

function createToken() {
  const token = crypto.randomBytes(32).toString('hex')
  return { token, tokenHash: crypto.createHash('sha256').update(token).digest('hex') }
}

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function validPhone(value) {
  return typeof value === 'string' && /^[+\d\s().-]{7,24}$/.test(value.trim())
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase().trim()
  if (s === 'pre_order' || s === 'pre-order' || s === 'preorder') return 'pre_order'
  if (s === 'coming_soon' || s === 'coming soon' || s === 'coming-soon') return 'coming_soon'
  return 'available'
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function sendOrderEmail({ email, name, productName, orderId, invoiceNo, amount, downloads, hasPreOrder }) {
  if (!isMailerConfigured()) return false
  const entries = (downloads || []).filter(item => item.token)
  const subject = `Your NixMix Audio order (${orderId}) — ${productName}`
  const amountLine = !amount ? 'Total: Free' : `Total paid: ₹${(amount / 100).toFixed(2)}`
  const invoiceLine = invoiceNo ? `Invoice No: ${invoiceNo}` : ''
  const greetingName = escapeHtml(name || 'there')
  const safeProductName = escapeHtml(productName)
  const linksText = entries.length
    ? entries.map(item => `Download ${item.productName}${item.platformLabel ? ` (${item.platformLabel})` : ''}: ${apiPublicUrl}/api/download/${item.token}`).join('\n')
    : hasPreOrder
      ? 'Your pre-order is confirmed. We will email your private download link as soon as the release installer is published.'
      : 'Your order is confirmed. Your installer link will be made available in your NixMix Audio dashboard.'
  const linksHtml = entries.length
    ? entries.map(item => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px"><tr><td><a href="${apiPublicUrl}/api/download/${item.token}" style="display:block;padding:15px 18px;background:#bfff68;color:#101827;text-decoration:none;border-radius:10px;font-size:14px;font-weight:700;text-align:center">Download ${escapeHtml(item.productName)}${item.platformLabel ? ` · ${escapeHtml(item.platformLabel)}` : ''} &nbsp;↗</a></td></tr></table>`).join('')
    : `<div style="padding:16px;border:1px solid #dce3eb;border-radius:10px;background:#f6f8fb;color:#526176;font-size:13px;line-height:1.6">${escapeHtml(hasPreOrder ? 'Your pre-order is confirmed. We will email your private installer link as soon as the release bundle is published.' : 'Your order is confirmed. Your installer link will appear in your NixMix Audio dashboard when it is ready.')}</div>`

  const logoHtml = '<div style="font-size:22px;font-weight:800;letter-spacing:-.05em;color:#ffffff">NIXMIX <span style="color:#bfff68">AUDIO</span></div>'
  const html = `<!doctype html><html><head><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head><body style="margin:0;padding:0;background:#080d18;font-family:Arial,Helvetica,sans-serif;color:#172033"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#080d18;padding:24px 10px"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#f7f8f4;border-radius:22px 8px 22px 8px;overflow:hidden;box-shadow:0 16px 55px rgba(0,0,0,.35)">
    <tr><td style="height:6px;background:#c2ff78;font-size:0;line-height:0">&nbsp;</td></tr>
    <tr><td style="padding:28px 34px 34px;background:radial-gradient(circle at 82% 18%,#34335b 0,#111a2b 42%,#0b1220 100%);color:#ffffff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td>${logoHtml}</td><td align="right" valign="top" style="font-size:10px;letter-spacing:.16em;color:#9fb1c9;font-weight:700">ORDER<br/>CONFIRMED</td></tr></table><div style="margin-top:34px;font-size:11px;letter-spacing:.18em;color:#bfff68;font-weight:700">YOUR SOUND IS READY ✳</div><h1 style="margin:12px 0 10px;font-size:34px;line-height:1.05;letter-spacing:-.05em;color:#ffffff">Thanks for your order,<br/><span style="color:#c9b7ff">${greetingName}.</span></h1><p style="max-width:470px;margin:0;color:#b7c5d8;font-size:14px;line-height:1.7">Your NixMix Audio order is confirmed. Your private installer access is ready below.</p></td></tr>
    <tr><td style="padding:24px 34px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dfe4dc;border-radius:16px 5px 16px 5px;background:#ffffff"><tr><td style="padding:20px 22px"><div style="font-size:10px;letter-spacing:.16em;color:#83907f;font-weight:700;margin-bottom:9px">ORDER SUMMARY</div><div style="font-size:19px;font-weight:700;letter-spacing:-.02em;color:#172033">${safeProductName}</div><div style="margin-top:14px;color:#657283;font-size:13px;line-height:1.85"><strong style="color:#172033">${escapeHtml(amountLine)}</strong><br/>Order reference: <strong style="color:#172033">${escapeHtml(orderId)}</strong>${invoiceLine ? `<br/>Invoice number: <strong style="color:#172033">${escapeHtml(invoiceNo)}</strong>` : ''}</div></td></tr></table></td></tr>
    <tr><td style="padding:22px 34px 8px"><div style="font-size:10px;letter-spacing:.16em;color:#83907f;font-weight:700;margin-bottom:12px">PRIVATE INSTALLER ACCESS</div>${linksHtml}</td></tr>
    <tr><td style="padding:14px 34px 30px"><div style="padding:17px 19px;background:#e9f5d8;border:1px solid #d3eab5;border-radius:12px 4px 12px 4px;color:#50652f;font-size:12px;line-height:1.7"><strong>Keep this link private.</strong><br/>It expires in 7 days and allows up to 5 downloads. You can also find it in your signed-in dashboard.</div></td></tr>
    <tr><td style="padding:24px 34px;background:#111a2b;border-top:6px solid #c9b7ff"><p style="margin:0;color:#c2cedd;font-size:12px;line-height:1.7">Need help with installation or your order? Reply to this email or contact <a href="mailto:support@nixmixaudio.com" style="color:#c2ff78;font-weight:700;text-decoration:none">support@nixmixaudio.com</a>.</p><p style="margin:15px 0 0;color:#8495ad;font-size:11px;line-height:1.6">Thoughtful tools for curious ears.<br/>NixMix Audio · India, worldwide in spirit</p></td></tr>
  </table><p style="margin:18px 0 0;color:#78889d;font-size:11px">This is an automated order confirmation from NixMix Audio.</p></td></tr></table></body></html>`

  await sendResendEmail({
    from: process.env.RESEND_FROM || process.env.MAIL_FROM,
    to: email,
    subject,
    text: `Hi ${name},\n\nYour NixMix Audio order is confirmed.\n${productName}\n${amountLine}\n${invoiceLine ? `${invoiceLine}\n` : ''}Order reference: ${orderId}\n\n${linksText}\n\n${entries.length ? 'This private link expires in 7 days and allows up to 5 downloads.\n' : ''}Need help? support@nixmixaudio.com\n\nNixMix Audio`,
    html,
  })
  return true
}

async function sendContactEmail({ type, name, email, subject, message, details = '' }) {
  if (!isMailerConfigured()) return false
  const safeType = type === 'studio' ? 'Studio request' : 'Support request'
  await sendResendEmail({
    from: process.env.RESEND_FROM || process.env.MAIL_FROM || 'support@nixmixaudio.com',
    to: process.env.SUPPORT_EMAIL || 'support@nixmixaudio.com',
    replyTo: email,
    subject: `[NixMix ${safeType}] ${subject}`,
    text: `${safeType}\n\nName: ${name}\nEmail: ${email}\n${details ? `${details}\n` : ''}\n${message}`,
    html: `<div style="font:15px/1.6 Arial,sans-serif;color:#222"><h2>${escapeHtml(safeType)}</h2><p><strong>Name:</strong> ${escapeHtml(name)}<br/><strong>Email:</strong> ${escapeHtml(email)}</p>${details ? `<p>${escapeHtml(details).replaceAll('\n', '<br/>')}</p>` : ''}<p>${escapeHtml(message).replaceAll('\n', '<br/>')}</p></div>`,
  })
  return true
}

function buildDownloadEntries(products) {
  const itemTokens = []
  for (const product of products) {
    itemTokens.push({
      productId: product.id,
      productName: product.name,
      platform: 'bundle',
      platformLabel: 'Windows + macOS bundle',
      fileName: '',
      tokenHash: '',
      downloads: 0,
      maxDownloads: 5,
    })
  }
  return { itemTokens, emailDownloads: [] }
}

async function addDownloadTokens(products, itemTokens, emailDownloads) {
  for (const entry of itemTokens) {
    const product = products.find(item => item.id === entry.productId)
    const asset = product ? await getAssetForProduct(product, entry.platform) : null
    if (!asset) continue
    const token = createToken()
    entry.fileName = asset.fileName
    entry.tokenHash = token.tokenHash
    emailDownloads.push({ productName: entry.productName, platform: entry.platform, platformLabel: entry.platformLabel, token: token.token })
  }
  return { itemTokens, emailDownloads }
}

function sanitizeOrderForClient(order) {
  const { tokenHash: _th, itemTokens, ...rest } = order
  const dashboardApiUrl = apiPublicUrl || allowedOrigins[0] || publicSiteUrl
  return {
    ...rest,
    items: (order.items || [{ productId: order.productId, productName: order.productName, pricePaise: order.amount || 0 }]).map((item, index) => {
      const tokenEntries = Array.isArray(itemTokens) ? itemTokens.filter(t => t.productId === item.productId) : []
      const downloads = tokenEntries.reduce((sum, token) => sum + (token.downloads || 0), 0)
      const maxDownloads = order.maxDownloads || 5
      return {
        ...item,
        downloads,
        maxDownloads,
        downloadLinks: tokenEntries.filter(token => token.tokenHash).map(token => ({
          platform: token.platform || 'bundle',
          platformLabel: token.platformLabel || 'Windows + macOS bundle',
          downloads: token.downloads || 0,
          maxDownloads: token.maxDownloads || 5,
          href: `${dashboardApiUrl}/api/download-file/${encodeURIComponent(order.id)}/${encodeURIComponent(item.productId)}/${encodeURIComponent(token.platform || 'bundle')}?download=1`,
        })),
      }
    }),
  }
}

// ── Public Health & Products ─────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, brand: 'NixMix Audio', googleClientId: GOOGLE_CLIENT_ID })
})

app.get('/api/exchange-rates', async (_req, res) => {
  if (exchangeRatesCache.expiresAt > Date.now()) return res.json({ base: 'INR', rates: exchangeRatesCache.rates })
  try {
    const response = await fetch('https://api.frankfurter.app/latest?from=INR')
    if (!response.ok) throw new Error(`Rate service returned ${response.status}`)
    const data = await response.json()
    const rates = { INR: 1, ...(data?.rates || {}) }
    exchangeRatesCache = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, rates }
    return res.json({ base: 'INR', rates })
  } catch (error) {
    console.warn('Exchange rates unavailable:', error.message)
    return res.json({ base: 'INR', rates: { INR: 1 }, fallback: true })
  }
})

app.post('/api/contact', async (req, res) => {
  const { type, name, email, subject, message, details, company } = req.body || {}
  if (company) return res.status(400).json({ message: 'Request rejected.' })
  if (!['studio', 'support'].includes(type) || !String(name || '').trim() || !validEmail(email) || !String(message || '').trim()) {
    return res.status(400).json({ message: 'Please provide your name, a valid email address, and a message.' })
  }
  const request = {
    id: `REQ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    type,
    name: String(name).trim().slice(0, 100),
    email: String(email).trim().toLowerCase(),
    subject: String(subject || type).trim().slice(0, 160),
    message: String(message).trim().slice(0, 4000),
    details: String(details || '').trim().slice(0, 1000),
    status: 'new',
    mailSent: false,
    createdAt: new Date().toISOString(),
  }
  await saveContactRequest(request)
  try {
    const sent = await sendContactEmail({
      type,
      name: request.name,
      email: request.email,
      subject: request.subject,
      message: request.message,
      details: request.details,
    })
    await updateContactRequest(request.id, { mailSent: sent, status: sent ? 'new' : 'email_pending' })
    if (!sent) return res.status(503).json({ requestId: request.id, message: 'Your request was saved, but email delivery is not configured yet. We will still review it from the admin panel.' })
    return res.json({ ok: true, requestId: request.id })
  } catch (error) {
    console.error('Contact email failed:', error.message)
    await updateContactRequest(request.id, { mailSent: false, status: 'email_pending', mailError: error.code || 'SMTP_ERROR' })
    return res.status(503).json({ requestId: request.id, message: 'Your request was saved safely, but notification email could not be delivered. Our team can still open it from the admin panel.' })
  }
})

app.get('/api/products', async (_req, res) => {
  try {
    const products = await readProducts()
    return res.json({ products })
  } catch (error) {
    console.error('Failed to read products:', error.message)
    return res.status(500).json({ message: 'Could not load products.' })
  }
})

app.get('/api/products/:id', async (req, res) => {
  try {
    const products = await readProducts()
    const product = products.find(p => p.id === req.params.id)
    if (!product) return res.status(404).json({ message: 'Product not found.' })
    return res.json({ product })
  } catch (error) {
    console.error('Failed to read product:', error.message)
    return res.status(500).json({ message: 'Could not load product.' })
  }
})

// ── Google Authentication ────────────────────────────────────────────────────

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body || {}
  if (typeof credential !== 'string' || !credential.trim()) {
    return res.status(400).json({ message: 'Missing Google sign-in credential.' })
  }
  try {
    const googleProfile = await verifyGoogleIdToken(credential.trim())
    const user = await upsertUser(googleProfile)
    if (user.banned) {
      clearSessionCookie(res, req)
      return res.status(403).json({
        message: 'Your Google account has been banned from NixMix Audio. Please contact support.',
      })
    }
    const cookieValue = await createSessionCookieValue(user)
    setSessionCookie(res, cookieValue, req)
    return res.json({
      ok: true,
      user: {
        id: user.id,
        sub: user.sub,
        name: user.name,
        email: user.email,
        picture: user.picture,
        phone: user.phone || '',
      },
    })
  } catch (error) {
    console.error('Google sign-in failed:', error.message)
    return res.status(401).json({ message: error.message || 'Google authentication failed.' })
  }
})

app.get('/api/auth/me', async (req, res) => {
  try {
    const session = await readSessionFromRequest(req)
    if (!session) return res.json({ user: null })
    const users = await readUsers()
    const user = users.find(item => item.sub === session.sub || item.id === session.sub)
    if (!user) {
      clearSessionCookie(res, req)
      return res.json({ user: null })
    }
    if (user.banned) {
      clearSessionCookie(res, req)
      return res.status(403).json({ user: null, banned: true, message: 'Your account has been banned. Please contact support.' })
    }
    return res.json({
      user: {
        id: user.id,
        sub: user.sub,
        name: user.name,
        email: user.email,
        picture: user.picture,
        phone: user.phone || '',
      },
    })
  } catch (error) {
    console.error('Session check failed:', error.message)
    return res.json({ user: null })
  }
})

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res, req)
  return res.json({ ok: true })
})

// ── Authenticated User Dashboard & Downloads ─────────────────────────────────

app.get('/api/orders/mine', requireUser, async (req, res) => {
  try {
    const orders = await readOrders()
    const mine = orders
      .filter(order => order.userId === req.user.sub || (order.email && order.email.toLowerCase() === req.user.email))
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      .map(sanitizeOrderForClient)
    return res.json({ orders: mine })
  } catch (error) {
    console.error('Failed to read user orders:', error.message)
    return res.status(500).json({ message: 'Could not load your orders.' })
  }
})

app.get('/api/download-file/:orderId/:productId/:platform?', (req, res, next) => {
  const suffix = req.params.platform ? `/${encodeURIComponent(req.params.platform)}` : ''
  const query = req.url.includes('?') ? `?${req.url.split('?')[1]}` : ''
  return res.redirect(307, `/api/orders/${encodeURIComponent(req.params.orderId)}/download/${encodeURIComponent(req.params.productId)}${suffix}${query}`)
})

app.get('/api/orders/:orderId/download/:productId/:platform?', requireUser, async (req, res) => {
  try {
    const orders = await readOrders()
    const order = orders.find(item => item.id === req.params.orderId)
    if (!order) return res.status(404).send('Order not found.')
    const ownsOrder = order.userId === req.user.sub || order.email?.toLowerCase() === req.user.email
    if (!ownsOrder) return res.status(403).send('You do not have access to this order.')
    if (!['paid', 'free'].includes(order.paymentStatus)) {
      return res.status(403).send('Payment has not been completed for this order.')
    }
    if (order.tokenExpiresAt && order.tokenExpiresAt < Date.now()) {
      return res.status(410).send('This download link has expired. Please contact NixMix Audio support.')
    }

    const products = await readProducts()
    const product = products.find(p => p.id === req.params.productId)
    if (!product) return res.status(404).send('Product not found.')

    const platform = ['windows', 'mac', 'bundle'].includes(req.params.platform) ? req.params.platform : (order.platform === 'mac' ? 'mac' : 'bundle')
    const itemToken = Array.isArray(order.itemTokens)
      ? order.itemTokens.find(t => t.productId === product.id && (t.platform || platform) === platform)
      : null

    if (itemToken) {
      if (itemToken.downloads >= itemToken.maxDownloads) {
        return res.status(410).send('Maximum download limit reached for this plugin.')
      }
    } else if (order.productId === product.id) {
      if ((order.downloads || 0) >= (order.maxDownloads || 5)) {
        return res.status(410).send('Maximum download limit reached for this plugin.')
      }
    } else {
      return res.status(404).send('Plugin not included in this order.')
    }

    const asset = await getAssetForProduct(product, platform, itemToken?.fileName || '')
    if (!asset) return res.status(404).send('The universal installer bundle is still being prepared.')

    if (itemToken) {
      itemToken.downloads += 1
      order.downloads = (order.downloads || 0) + 1
    } else {
      order.downloads = (order.downloads || 0) + 1
    }
    await saveOrder(order)
    return sendAsset(res, asset)
  } catch (error) {
    console.error('Dashboard download failed:', error.message)
    return res.status(500).send('Could not start download.')
  }
})

// ── Helper to resolve requested checkout items ───────────────────────────────

async function resolveCheckoutProducts(body) {
  const requestedIds = Array.isArray(body?.productIds)
    ? body.productIds
    : [body?.productId]
  const productIds = [...new Set(requestedIds.filter(id => typeof id === 'string' && id.trim()))]
  if (productIds.length === 0) return { error: 'Please select at least one plugin.' }

  const catalog = await readProducts()
  const selected = []
  for (const id of productIds) {
    const product = catalog.find(item => item.id === id)
    if (!product) return { error: `Plugin "${id}" was not found.` }
    if (normalizeStatus(product.status) === 'coming_soon') {
      return { error: `${product.name} is coming soon and cannot be ordered yet.` }
    }
    selected.push(product)
  }
  const totalPaise = selected.reduce((sum, item) => sum + Math.max(0, Number(item.pricePaise || 0)), 0)
  return { products: selected, productIds, totalPaise }
}

// ── Free Checkout (Authenticated with Google) ────────────────────────────────

app.post('/api/free-order', requireUser, async (req, res) => {
  const { name, phone, country } = req.body || {}
  const resolved = await resolveCheckoutProducts(req.body)
  if (resolved.error) return res.status(400).json({ message: resolved.error })
  if (resolved.totalPaise > 0) {
    return res.status(400).json({ message: 'This order includes paid plugins. Please complete checkout with Razorpay.' })
  }
  const cleanName = typeof name === 'string' ? name.trim() : req.user.name
  const cleanEmail = req.user.email
  if (!cleanName || cleanName.length > 100 || !validEmail(cleanEmail) || !validPhone(phone)) {
    return res.status(400).json({ message: 'Please enter your name and a valid phone number.' })
  }

  try {
    const { products: selected, productIds } = resolved
    const platform = 'bundle'
    const orderId = `NM-${crypto.randomBytes(5).toString('hex').toUpperCase()}`
    const invoiceNo = `FREE-${orderId}`
    const createdAt = new Date().toISOString()

    const { itemTokens, emailDownloads } = buildDownloadEntries(selected)
    await addDownloadTokens(selected, itemTokens, emailDownloads)

    const hasPreOrder = selected.some(p => normalizeStatus(p.status) === 'pre_order')
    const allHaveAssets = itemTokens.every(item => Boolean(item.tokenHash))
    const order = {
      id: orderId,
      userId: req.user.sub,
      name: cleanName,
      email: cleanEmail,
      phone: phone.trim(),
      country: typeof country === 'string' ? country.trim().slice(0, 100) : '',
      platform,
      items: selected.map((product, i) => ({
        productId: product.id,
        productName: product.name,
        pricePaise: 0,
        status: normalizeStatus(product.status),
        fileName: '',
      })),
      productId: selected.length === 1 ? selected[0].id : 'bundle',
      productName: selected.map(p => p.name).join(' + '),
      amount: 0,
      currency: 'INR',
      paymentStatus: 'free',
      orderType: hasPreOrder ? 'pre_order' : 'available',
      deliveryStatus: allHaveAssets ? 'ready' : 'preparing',
      invoiceNo,
      razorpayOrderId: '',
      razorpayPaymentId: '',
      itemTokens,
      tokenHash: itemTokens.length === 1 ? itemTokens[0].tokenHash : '',
      tokenExpiresAt: Date.now() + SEVEN_DAYS_MS,
      downloads: 0,
      maxDownloads: 5,
      createdAt,
    }

    await saveOrder(order)
    await updateUser(req.user.id, { phone: phone.trim(), name: cleanName })

    let emailSent = false
    try {
      emailSent = await sendOrderEmail({
        email: cleanEmail,
        name: cleanName,
        productName: order.productName,
        orderId,
        invoiceNo,
        amount: 0,
        downloads: emailDownloads,
        hasPreOrder,
      })
    } catch (mailError) {
      console.warn('Free order email not sent:', mailError.message)
    }

    return res.status(201).json({ ok: true, orderId, invoiceNo, productIds, emailSent, deliveryStatus: order.deliveryStatus })
  } catch (error) {
    console.error('Free order could not be completed:', error.message)
    return res.status(503).json({ message: 'We could not complete your order just now. Please try again shortly.' })
  }
})

// ── Razorpay Paid Checkout (Authenticated with Google) ───────────────────────

app.post('/api/payments/create-order', requireUser, async (req, res) => {
  const { name, phone, country } = req.body || {}
  const resolved = await resolveCheckoutProducts(req.body)
  if (resolved.error) return res.status(400).json({ message: resolved.error })
  if (resolved.totalPaise < 100) {
    return res.status(400).json({ message: 'Total must be at least ₹1 for Razorpay checkout.' })
  }
  const cleanName = typeof name === 'string' ? name.trim() : req.user.name
  const cleanEmail = req.user.email
  if (!cleanName || cleanName.length > 100 || !validEmail(cleanEmail) || !validPhone(phone)) {
    return res.status(400).json({ message: 'Please enter your name and a valid phone number.' })
  }

  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return res.status(503).json({ message: 'Online Razorpay payment is not configured on the server yet.' })
  }

  try {
    const { products: selected, totalPaise } = resolved
    const platform = 'bundle'
    const orderId = `NM-${crypto.randomBytes(5).toString('hex').toUpperCase()}`
    const receipt = `nm_${crypto.randomBytes(6).toString('hex')}`
    const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
    const razorOrder = await razorpay.orders.create({
      amount: totalPaise,
      currency: 'INR',
      receipt,
      notes: {
        orderId,
        userId: req.user.sub,
        email: cleanEmail,
        phone: phone.trim(),
        platform,
        products: selected.map(p => p.id).join(','),
      },
    })

    const hasPreOrder = selected.some(p => normalizeStatus(p.status) === 'pre_order')
    const order = {
      id: orderId,
      userId: req.user.sub,
      name: cleanName,
      email: cleanEmail,
      phone: phone.trim(),
      country: typeof country === 'string' ? country.trim().slice(0, 100) : '',
      platform,
      items: selected.map(product => ({
        productId: product.id,
        productName: product.name,
        pricePaise: Number(product.pricePaise || 0),
        status: normalizeStatus(product.status),
        fileName: '',
      })),
      productId: selected.length === 1 ? selected[0].id : 'bundle',
      productName: selected.map(p => p.name).join(' + '),
      amount: totalPaise,
      currency: 'INR',
      paymentStatus: 'pending',
      orderType: hasPreOrder ? 'pre_order' : 'available',
      deliveryStatus: 'pending',
      razorpayOrderId: razorOrder.id,
      razorpayPaymentId: '',
      receipt,
      invoiceNo: '',
      downloads: 0,
      maxDownloads: 5,
      createdAt: new Date().toISOString(),
    }

    await saveOrder(order)
    await updateUser(req.user.id, { phone: phone.trim(), name: cleanName })

    return res.status(201).json({
      keyId: RAZORPAY_KEY_ID,
      razorpayOrderId: razorOrder.id,
      orderId,
      amount: razorOrder.amount,
      currency: razorOrder.currency,
      productName: order.productName,
    })
  } catch (error) {
    console.error('Razorpay order creation failed:', error.message)
    return res.status(503).json({ message: 'We could not start Razorpay checkout right now. Please try again.' })
  }
})

app.post('/api/payments/verify', requireUser, async (req, res) => {
  const { razorpay_order_id: razorOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {}
  if (![razorOrderId, paymentId, signature].every(value => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ message: 'Payment verification details are incomplete.' })
  }
  const secret = process.env.RAZORPAY_KEY_SECRET
  const keyId = process.env.RAZORPAY_KEY_ID
  if (!secret) return res.status(503).json({ message: 'Online payment is not configured yet.' })

  try {
    const orders = await readOrders()
    const order = orders.find(item => item.razorpayOrderId === razorOrderId && item.paymentStatus === 'pending')
    if (!order) return res.status(404).json({ message: 'This payment order could not be found.' })
    if (order.userId && order.userId !== req.user.sub && order.email?.toLowerCase() !== req.user.email) {
      return res.status(403).json({ message: 'This payment order does not belong to the signed-in account.' })
    }

    const expected = crypto.createHmac('sha256', secret).update(`${razorOrderId}|${paymentId}`).digest()
    const actual = Buffer.from(signature, 'hex')
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(400).json({ message: 'Payment signature verification failed.' })
    }

    let invoiceNo = order.receipt ? `INV-${order.receipt.toUpperCase()}` : `INV-${paymentId.replace(/^pay_/, '').toUpperCase()}`
    if (keyId && secret) {
      try {
        const razorpay = new Razorpay({ key_id: keyId, key_secret: secret })
        const paymentDetails = await razorpay.payments.fetch(paymentId)
        if (paymentDetails?.invoice_id) invoiceNo = paymentDetails.invoice_id
      } catch {
        // Fallback invoice number already computed
      }
    }

    const catalog = await readProducts()
    const items = order.items || [{ productId: order.productId, productName: order.productName }]
    const itemTokens = []
    const emailDownloads = []

    for (const item of items) {
      const entries = buildDownloadEntries([{ id: item.productId, name: item.productName }]).itemTokens
      itemTokens.push(...entries)
    }
    await addDownloadTokens(catalog, itemTokens, emailDownloads)

    order.paymentStatus = 'paid'
    order.razorpayPaymentId = paymentId
    order.invoiceNo = invoiceNo
    order.paidAt = new Date().toISOString()
    order.itemTokens = itemTokens
    order.tokenHash = itemTokens.length === 1 ? itemTokens[0].tokenHash : ''
    order.tokenExpiresAt = Date.now() + SEVEN_DAYS_MS
    order.downloads = 0
    order.maxDownloads = 5
    order.deliveryStatus = emailDownloads.length === items.length ? 'ready' : 'preparing'

    await saveOrder(order)

    let emailSent = false
    try {
      emailSent = await sendOrderEmail({
        email: order.email,
        name: order.name,
        productName: order.productName,
        orderId: order.id,
        invoiceNo,
        amount: order.amount,
        downloads: emailDownloads,
        hasPreOrder: order.orderType === 'pre_order',
      })
    } catch (mailError) {
      console.warn('Paid order confirmation email failed:', mailError.message)
    }

    return res.json({
      ok: true,
      orderId: order.id,
      invoiceNo,
      razorpayPaymentId: paymentId,
      emailSent,
      deliveryStatus: order.deliveryStatus,
    })
  } catch (error) {
    console.error('Razorpay payment verification error:', error.message)
    return res.status(503).json({ message: 'Payment verification encountered an error. Please contact support with your payment reference.' })
  }
})

// ── Tokenized Download Link ──────────────────────────────────────────────────

app.get('/api/download/:token', async (req, res) => {
  try {
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex')
    const orders = await readOrders()
    let matchedOrder = null
    let matchedItemToken = null

    for (const order of orders) {
      if (Array.isArray(order.itemTokens)) {
        const found = order.itemTokens.find(t => t.tokenHash && t.tokenHash === tokenHash)
        if (found) {
          matchedOrder = order
          matchedItemToken = found
          break
        }
      }
      if (order.tokenHash && order.tokenHash === tokenHash) {
        matchedOrder = order
        break
      }
    }

    if (!matchedOrder || matchedOrder.tokenExpiresAt < Date.now()) {
      return res.status(410).send('This download link has expired or is invalid. Please contact NixMix Audio support.')
    }
    const used = matchedItemToken ? matchedItemToken.downloads : matchedOrder.downloads
    const limit = matchedItemToken ? matchedItemToken.maxDownloads : matchedOrder.maxDownloads
    if (used >= limit) {
      return res.status(410).send('This download link has reached its download limit. Please contact NixMix Audio support.')
    }

    const productId = matchedItemToken ? matchedItemToken.productId : matchedOrder.productId
    // New orders have separate tokens for Windows and macOS. Older orders
    // stored one platform on the order itself, so keep that as a fallback.
    const platform = matchedItemToken?.platform || (matchedOrder.platform === 'mac' ? 'mac' : 'windows')
    const catalog = await readProducts()
    const product = catalog.find(p => p.id === productId)
    const asset = product ? await getAssetForProduct(product, platform, matchedItemToken?.fileName || '') : null
    const expectedFile = matchedItemToken ? matchedItemToken.fileName : matchedOrder.fileName
    if (!asset || (expectedFile && asset.fileName !== expectedFile)) {
      return res.status(404).send('This installer is temporarily unavailable. Please contact NixMix Audio support.')
    }

    if (matchedItemToken) {
      matchedItemToken.downloads += 1
      matchedOrder.downloads = (matchedOrder.downloads || 0) + 1
    } else {
      matchedOrder.downloads = (matchedOrder.downloads || 0) + 1
    }
    await saveOrder(matchedOrder)
    return sendAsset(res, asset)
  } catch (error) {
    console.error('Download link could not be processed:', error.message)
    return res.status(500).send('The download could not be started. Please contact NixMix Audio support.')
  }
})

// ── Admin Panel APIs (password protected) ────────────────────────────────────

app.post('/api/admin/login', async (req, res) => {
  const password = req.body?.password
  if (!(await verifyAdminPassword(password))) {
    return res.status(401).json({ message: 'Incorrect admin password.' })
  }
  const value = await createAdminSessionCookieValue()
  setAdminSessionCookie(res, value, req)
  return res.json({ ok: true, adminEmail: 'admin', mode: 'password' })
})

app.post('/api/admin/logout', (req, res) => {
  clearAdminSessionCookie(res, req)
  return res.json({ ok: true })
})

app.get('/api/admin/session', requireAdmin, (req, res) => {
  res.json({ ok: true, adminEmail: req.admin.email, mode: req.admin.mode })
})

app.get('/api/admin/orders', requireAdmin, async (_req, res) => {
  try {
    const orders = await readOrders()
    const sorted = [...orders]
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      .map(sanitizeOrderForClient)
    return res.json({ orders: sorted })
  } catch (error) {
    console.error('Admin orders error:', error.message)
    return res.status(500).json({ message: 'Failed to load orders.' })
  }
})

app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  try {
    const [users, orders] = await Promise.all([readUsers(), readOrders()])
    const enriched = users
      .map(user => {
        const userOrders = orders.filter(o => o.userId === user.sub || o.email?.toLowerCase() === user.email)
        const paidOrders = userOrders.filter(o => ['paid', 'free'].includes(o.paymentStatus))
        const totalSpentPaise = paidOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0)
        return {
          ...user,
          ordersCount: paidOrders.length,
          totalSpentPaise,
        }
      })
      .sort((a, b) => new Date(b.lastLoginAt || 0).getTime() - new Date(a.lastLoginAt || 0).getTime())
    return res.json({ users: enriched })
  } catch (error) {
    console.error('Admin users error:', error.message)
    return res.status(500).json({ message: 'Failed to load users.' })
  }
})

app.get('/api/admin/requests', requireAdmin, async (_req, res) => {
  try {
    const requests = (await readContactRequests()).sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    return res.json({ requests })
  } catch (error) {
    console.error('Admin requests error:', error.message)
    return res.status(500).json({ message: 'Failed to load contact requests.' })
  }
})

app.patch('/api/admin/requests/:id', requireAdmin, async (req, res) => {
  const allowed = ['new', 'in_progress', 'resolved', 'email_pending']
  const status = String(req.body?.status || '')
  if (!allowed.includes(status)) return res.status(400).json({ message: 'Invalid request status.' })
  try {
    const request = await updateContactRequest(req.params.id, { status })
    if (!request) return res.status(404).json({ message: 'Request not found.' })
    return res.json({ ok: true, request })
  } catch (error) {
    console.error('Admin request update failed:', error.message)
    return res.status(500).json({ message: 'Failed to update request.' })
  }
})

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const { banned, reason } = req.body || {}
  if (typeof banned !== 'boolean') {
    return res.status(400).json({ message: 'Please specify banned: true or false.' })
  }
  try {
    const updated = await updateUser(req.params.id, {
      banned,
      bannedAt: banned ? new Date().toISOString() : null,
      bannedReason: banned ? String(reason || '').trim().slice(0, 300) : '',
    })
    if (!updated) return res.status(404).json({ message: 'User not found.' })
    return res.json({ ok: true, user: updated })
  } catch (error) {
    console.error('Admin ban toggle failed:', error.message)
    return res.status(500).json({ message: 'Failed to update user ban status.' })
  }
})

app.get('/api/admin/products', requireAdmin, async (_req, res) => {
  try {
    const products = await readProducts()
    return res.json({ products })
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load products.' })
  }
})

function buildProductPayload(body, existing = null) {
  const name = String(body?.name || existing?.name || '').trim()
  if (!name) throw new Error('Product name is required.')
  const id = existing ? existing.id : slugify(body?.id || name)
  if (!id) throw new Error('A valid product slug ID is required.')

  const status = normalizeStatus(body?.status ?? existing?.status)
  const pricePaise = Math.max(0, Math.round(Number(body?.pricePaise ?? existing?.pricePaise ?? 0)))
  if (!Number.isFinite(pricePaise)) throw new Error('Invalid price value.')
  if (pricePaise > 0 && pricePaise < 100) throw new Error('Paid plugin price must be at least ₹1 (100 paise) or ₹0 for Free.')

  const featureImages = Array.isArray(body?.featureImages)
    ? body.featureImages
        .filter(item => item && (item.title || item.image || item.description))
        .map((item, idx) => ({
          id: String(item.id || `${id}-feat-${idx + 1}`),
          eyebrow: String(item.eyebrow || `0${idx + 1} · FEATURE`).trim(),
          title: String(item.title || '').trim(),
          description: String(item.description || '').trim(),
          image: String(item.image || '').trim(),
          kind: item.kind ? String(item.kind) : undefined,
        }))
    : (existing?.featureImages || [])

  const highlights = Array.isArray(body?.highlights)
    ? body.highlights.map(v => String(v).trim()).filter(Boolean)
    : (existing?.highlights || [])

  const platforms = Array.isArray(body?.platforms)
    ? body.platforms.map(v => String(v).trim()).filter(Boolean)
    : (existing?.platforms || ['Windows — VST3', 'macOS — VST3 & AU'])

  const now = new Date().toISOString()
  const bundleFile = String(body?.files?.bundle ?? existing?.files?.bundle ?? existing?.files?.mac ?? existing?.files?.windows ?? '').trim() || `${id}-windows-mac.zip`
  const requestedBundleKey = String(body?.files?.bundleKey ?? existing?.files?.bundleKey ?? '').trim()
  const bundleKey = requestedBundleKey && requestedBundleKey.startsWith(`installers/${id}/`) ? requestedBundleKey : ''
  return {
    id,
    name,
    eyebrow: String(body?.eyebrow ?? existing?.eyebrow ?? (String(body?.category || 'PLUGIN').toUpperCase())).trim(),
    category: String(body?.category ?? existing?.category ?? 'Audio plugin').trim(),
    status,
    pricePaise,
    priceLabel: String(body?.priceLabel ?? existing?.priceLabel ?? '').trim(),
    description: String(body?.description ?? existing?.description ?? '').trim(),
    longDescription: String(body?.longDescription ?? existing?.longDescription ?? body?.description ?? '').trim(),
    mainImage: String(body?.mainImage ?? existing?.mainImage ?? '').trim(),
    featureImages,
    highlights,
    platforms: platforms.length ? platforms : ['Windows — VST3', 'macOS — VST3 & AU'],
    accent: ['lime', 'mint', 'copper', 'cyan', 'violet'].includes(body?.accent) ? body.accent : (existing?.accent || 'cyan'),
    files: {
      bundle: bundleFile,
      ...(bundleKey ? { bundleKey } : {}),
    },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
}

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    let createdProduct = null
    await mutateProducts(list => {
      const payload = buildProductPayload(req.body)
      if (list.some(item => item.id === payload.id)) {
        const err = new Error(`A plugin with id "${payload.id}" already exists.`)
        err.statusCode = 409
        throw err
      }
      createdProduct = payload
      return [...list, payload]
    })
    return res.status(201).json({ ok: true, product: createdProduct })
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message || 'Could not create product.' })
  }
})

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    let updatedProduct = null
    await mutateProducts(list => {
      const idx = list.findIndex(item => item.id === req.params.id)
      if (idx < 0) {
        const err = new Error('Product not found.')
        err.statusCode = 404
        throw err
      }
      updatedProduct = buildProductPayload(req.body, list[idx])
      const next = [...list]
      next[idx] = updatedProduct
      return next
    })
    return res.json({ ok: true, product: updatedProduct })
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message || 'Could not update product.' })
  }
})

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    await mutateProducts(list => {
      const next = list.filter(item => item.id !== req.params.id)
      if (next.length === list.length) {
        const err = new Error('Product not found.')
        err.statusCode = 404
        throw err
      }
      return next
    })
    return res.json({ ok: true })
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message || 'Could not delete product.' })
  }
})

app.post('/api/admin/upload', requireAdmin, async (req, res) => {
  const { filename, dataUrl, kind = 'image', productId = '' } = req.body || {}
  if (typeof dataUrl !== 'string') {
    return res.status(400).json({ message: 'Missing upload data.' })
  }
  if (kind === 'installer') {
    const originalName = path.basename(String(filename || 'installer.zip'))
    if (!/\.zip$/i.test(originalName)) {
      return res.status(400).json({ message: 'Please upload a ZIP installer file.' })
    }
    const match = dataUrl.match(/^data:(?:application\/zip|application\/x-zip-compressed|application\/octet-stream);base64,([A-Za-z0-9+/=]+)$/)
    if (!match) return res.status(400).json({ message: 'Please upload a valid ZIP installer file.' })
    const buffer = Buffer.from(match[1], 'base64')
    if (buffer.length > 250 * 1024 * 1024) return res.status(400).json({ message: 'Installer ZIP must be 250 MB or smaller.' })
    const r2 = globalThis.__NIXMIX_DOWNLOADS
    const safeProductId = slugify(productId)
    if (!r2 || !safeProductId) return res.status(503).json({ message: 'Cloudflare R2 installer storage is not available.' })
    const base = slugify(path.basename(originalName, path.extname(originalName))) || 'installer'
    const objectKey = `installers/${safeProductId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${base}.zip`
    try {
      await r2.put(objectKey, buffer, {
        httpMetadata: {
          contentType: 'application/zip',
          contentDisposition: `attachment; filename="${originalName.replace(/["\\\r\n]/g, '_')}"`,
        },
        customMetadata: { productId: safeProductId, originalName },
      })
      return res.status(201).json({ ok: true, storage: 'r2', key: objectKey, fileName: originalName })
    } catch (error) {
      console.error('Installer upload error:', error.message)
      return res.status(500).json({ message: 'Failed to save installer to Cloudflare R2.' })
    }
  }
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/)
  if (!match) {
    return res.status(400).json({ message: 'Please upload a valid PNG, JPEG, WebP, GIF, or SVG image.' })
  }
  const mime = match[1]
  const extMap = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
  }
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length > 5 * 1024 * 1024) {
    return res.status(400).json({ message: 'Image must be 5 MB or smaller.' })
  }
  try {
    await fs.mkdir(uploadsDir, { recursive: true })
    const base = slugify(path.basename(String(filename || 'image'), path.extname(String(filename || '')))) || 'image'
    const outName = `${base}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${extMap[mime]}`
    await fs.writeFile(path.join(uploadsDir, outName), buffer)
    return res.status(201).json({ ok: true, url: `${apiPublicUrl}/uploads/${outName}` })
  } catch (error) {
    console.error('Upload error:', error.message)
    return res.status(500).json({ message: 'Failed to save uploaded image.' })
  }
})

// ── Static Frontend Fallback ─────────────────────────────────────────────────

app.use(express.static(path.resolve(here, '../dist'), { index: false }))
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next()
  return res.sendFile(path.resolve(here, '../dist/index.html'), error => { if (error) next() })
})

export { app }
