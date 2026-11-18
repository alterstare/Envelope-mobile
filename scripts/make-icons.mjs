// Android app icons + splash from the Envelope logo (`Env_icon_v2.png`, 1024²,
// the same art as the PC app; rendering as the PC's scripts/make-icons.mjs):
//   mipmap-*/ic_launcher.png            legacy icon, rounded square (as on the PC)
//   mipmap-*/ic_launcher_round.png      legacy round icon
//   mipmap-*/ic_launcher_foreground.png adaptive icon layer (108dp): the logo in
//                                       the visible 72dp, the art's ground around it
//   drawable-*/splash.png               launch screen before Android 12
// Every size is rendered on its own from the full-size art: the halftone dots
// are blurred into tone before shrinking (a plain resize turns them into moiré)
// and the purple stripe is drawn again as a sharp shape at that size.
//   node scripts/make-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = join(root, 'android/app/src/main/res')
const SIZE = 1024
const RADIUS = 0.22 // corner radius / side, as the PC app's icon
const BG = '#f4f5f8' // the app's light background (splash)
const GROUND = '#f0eef8' // the art's light ground
const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
// the stripe in the 1024² art (measured on the PC): top edge y 153.5 from x
// 805.5 to 935, bottom edge y 870 from x 89 to 219.5
const STRIPE = { top: 153.5, bottom: 870, tl: 805.5, tr: 935, bl: 89, br: 219.5, color: '#6e2cf5' }
const MIN_STRIPE_PX = 2.4

const stripe = (n, color = STRIPE.color, pad = 0) => {
  const k = n / SIZE
  const w = (STRIPE.tr - STRIPE.tl) * k
  const grow = Math.max(pad, (MIN_STRIPE_PX - w) / 2)
  const pts = [
    [STRIPE.tl * k - grow, STRIPE.top * k],
    [STRIPE.tr * k + grow, STRIPE.top * k],
    [STRIPE.br * k + grow, STRIPE.bottom * k],
    [STRIPE.bl * k - grow, STRIPE.bottom * k]
  ]
  return Buffer.from(
    `<svg width="${n}" height="${n}"><polygon points="${pts.map((p) => p.map((v) => v.toFixed(3)).join(',')).join(' ')}" fill="${color}"/></svg>`
  )
}

// the art without its stripe (it is drawn again sharp at each size)
const art = await sharp(readFileSync(join(root, 'Env_icon_v2.png')))
  .resize(SIZE, SIZE)
  .removeAlpha()
  .composite([{ input: stripe(SIZE, GROUND, 3) }])
  .png()
  .toBuffer()

const shape = {
  square: () => null,
  rounded: (n) => `<rect width="${n}" height="${n}" rx="${n * RADIUS}" ry="${n * RADIUS}" fill="#fff"/>`,
  round: (n) => `<circle cx="${n / 2}" cy="${n / 2}" r="${n / 2}" fill="#fff"/>`
}

async function render(n, mask = 'rounded') {
  const sigma = (SIZE / n) * 0.5
  const tone = await sharp(sigma >= 0.3 ? await sharp(art).blur(sigma).png().toBuffer() : art)
    .resize(n, n, { kernel: 'mitchell' })
    .png()
    .toBuffer()
  let img = sharp(await sharp(tone).composite([{ input: stripe(n) }]).png().toBuffer()).ensureAlpha()
  const m = shape[mask](n)
  if (m) img = img.composite([{ input: Buffer.from(`<svg width="${n}" height="${n}">${m}</svg>`), blend: 'dest-in' }])
  return img.png({ compressionLevel: 9 }).toBuffer()
}

for (const [d, k] of Object.entries(DENSITY)) {
  const dir = join(res, `mipmap-${d}`)
  mkdirSync(dir, { recursive: true })
  const legacy = Math.round(48 * k)
  writeFileSync(join(dir, 'ic_launcher.png'), await render(legacy, 'rounded'))
  writeFileSync(join(dir, 'ic_launcher_round.png'), await render(legacy, 'round'))
  // adaptive foreground: 108dp, the whole logo in the visible middle 72dp
  // (the launcher's mask cuts its corners); around it the background layer =
  // the art's ground colour (values/ic_launcher_background)
  const full = Math.round(108 * k)
  const inner = Math.round(72 * k)
  const pad = Math.floor((full - inner) / 2)
  const fg = await sharp(await render(inner, 'square'))
    .extend({ top: pad, left: pad, bottom: full - inner - pad, right: full - inner - pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
  writeFileSync(join(dir, 'ic_launcher_foreground.png'), fg)
}

// Launch screen (before Android 12; 12+ shows the adaptive icon itself).
const SPLASH = {
  'port-mdpi': [320, 480],
  'port-hdpi': [480, 800],
  'port-xhdpi': [720, 1280],
  'port-xxhdpi': [960, 1600],
  'port-xxxhdpi': [1280, 1920],
  'land-mdpi': [480, 320],
  'land-hdpi': [800, 480],
  'land-xhdpi': [1280, 720],
  'land-xxhdpi': [1600, 960],
  'land-xxxhdpi': [1920, 1280]
}
for (const [d, [w, h]] of Object.entries(SPLASH)) {
  const n = Math.round(Math.min(w, h) * 0.32)
  const png = await sharp({ create: { width: w, height: h, channels: 4, background: BG } })
    .composite([{ input: await render(n), left: Math.round((w - n) / 2), top: Math.round((h - n) / 2) }])
    .png({ compressionLevel: 9 })
    .toBuffer()
  mkdirSync(join(res, `drawable-${d}`), { recursive: true })
  writeFileSync(join(res, `drawable-${d}`, 'splash.png'), png)
}
writeFileSync(
  join(res, 'drawable/splash.png'),
  await sharp({ create: { width: 480, height: 800, channels: 4, background: BG } })
    .composite([{ input: await render(154), left: 163, top: 323 }])
    .png()
    .toBuffer()
)
// the adaptive icon's background = the ground as the rendered logo has it
// (a shade off from the art after resizing), so no edge shows around it
const px = await sharp(await render(288, 'square')).extract({ left: 4, top: 4, width: 1, height: 1 }).raw().toBuffer()
const ground = '#' + [...px.subarray(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
writeFileSync(
  join(res, 'values/ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${ground}</color>\n</resources>\n`
)
console.log('icons + splash written')
