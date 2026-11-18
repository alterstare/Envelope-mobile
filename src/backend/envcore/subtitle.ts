// From Envelope (core/subtitle/index.ts). Subtitles (CLAUDE.md §5.3): read
// vtt / srt / lrc / ass in any of the encodings these works ship with, tell
// the language. The phone decodes with the WebView's TextDecoder (it knows
// Shift-JIS and EUC-KR, which is CP949 in the WHATWG table) instead of iconv.
import type { Cue, SubLang } from '../../shared/types'

export type { Cue, SubLang }

export const SUB_EXTS = new Set(['.vtt', '.srt', '.lrc', '.ass', '.ssa'])

// First line of every file Env writes (so it knows which files it may update).
export const ENV_MARK = 'NOTE Env'

// ---- text decoding ----

// UTF-8 / UTF-16 (BOM), else UTF-8 if valid, else whichever of Shift-JIS and
// CP949 reads with fewer broken characters; on a tie Shift-JIS when it reads
// as kana (Shift-JIS bytes often decode as valid but meaningless Korean).
export function decodeText(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf)
  const dec = (enc: string, from = 0): string => new TextDecoder(enc).decode(b.subarray(from))
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return dec('utf-8', 3)
  if (b[0] === 0xff && b[1] === 0xfe) return dec('utf-16le', 2)
  if (b[0] === 0xfe && b[1] === 0xff) return dec('utf-16be', 2)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    // not UTF-8
  }
  const bad = (s: string): number => (s.match(/\uFFFD/g) ?? []).length
  const sjis = dec('shift_jis')
  const kr = dec('euc-kr')
  if (bad(sjis) !== bad(kr)) return bad(sjis) < bad(kr) ? sjis : kr
  return (sjis.match(/[\u3040-\u30ff]/g) ?? []).length > 0 ? sjis : kr
}

// ---- language ----

export function langOfText(s: string): SubLang {
  const hangul = (s.match(/[가-힣]/g) ?? []).length
  const kana = (s.match(/[぀-ヿ]/g) ?? []).length
  if (!hangul && !kana) return 'other'
  return hangul >= kana ? 'ko' : 'ja'
}

const LANG_TAG: Record<string, SubLang> = { ja: 'ja', jp: 'ja', jpn: 'ja', japanese: 'ja', ko: 'ko', kr: 'ko', kor: 'ko', korean: 'ko' }

// "x.ja.srt" → 'ja'; null when the name has no language tag.
export function langOfName(name: string): SubLang | null {
  const m = name.toLowerCase().match(/\.([a-z]{2,8})\.(?:vtt|srt|lrc|ass|ssa)$/)
  return (m && LANG_TAG[m[1]]) || null
}

// 언어 분류 (any language, not only ja / ko): ISO 639-1 codes
const CONTENT_TAG: Record<string, string> = {
  ...LANG_TAG,
  en: 'en', eng: 'en', english: 'en',
  zh: 'zh', chs: 'zh', cht: 'zh', chi: 'zh', zho: 'zh', cn: 'zh', tw: 'zh', sc: 'zh', tc: 'zh', chinese: 'zh',
  es: 'es', spa: 'es', fr: 'fr', fre: 'fr', fra: 'fr', de: 'de', ger: 'de', deu: 'de', ru: 'ru', rus: 'ru',
  th: 'th', tha: 'th', vi: 'vi', vie: 'vi', id: 'id', ind: 'id', pt: 'pt', por: 'pt', it: 'it', ita: 'it'
}
// "x.en" (a subtitle's name without its extension) → "x"
export const LANG_SUFFIX = new RegExp(`\\.(${Object.keys(CONTENT_TAG).join('|')})$`, 'i')
export function contentLangOfName(name: string): string | null {
  const m = name.toLowerCase().match(/\.([a-z]{2,8})\.(?:vtt|srt|lrc|ass|ssa|txt)$/)
  return (m && CONTENT_TAG[m[1]]) || null
}
// by script: Hangul / kana as langOfText, then Han only = Chinese, Thai,
// Cyrillic, Latin letters = English; null = no letters
export function contentLangOfText(s: string): string | null {
  const l = langOfText(s)
  if (l !== 'other') return l
  const n = (re: RegExp): number => (s.match(re) ?? []).length
  const counts: [string, number][] = [
    ['zh', n(/[一-鿿]/g)],
    ['th', n(/[฀-๿]/g)],
    ['ru', n(/[Ѐ-ӿ]/g)],
    ['en', n(/[a-z]/gi)]
  ]
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a))
  return best[1] >= 20 ? best[0] : null
}

// ---- parsing ----

function time(s: string): number {
  // 01:02:03.456 / 02:03.456 / 01:02:03,456
  const p = s.trim().replace(',', '.').split(':').map(Number)
  return p.reduce((acc, x) => acc * 60 + x, 0)
}

const clean = (s: string): string =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim()

const TIMING = /(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}/

// vtt and srt: blocks separated by blank lines, a timing line, then text.
function parseBlocks(text: string): Cue[] {
  const out: Cue[] = []
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const i = lines.findIndex((l) => TIMING.test(l))
    if (i < 0 || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue
    const [a, b] = lines[i].split('-->')
    const body = clean(lines.slice(i + 1).join('\n'))
    // cue id "low": script alignment wasn't sure of the timing (shown in the editor)
    if (body) out.push({ start: time(a), end: time(b.trim().split(/\s/)[0]), text: body, ...(i > 0 && lines[i - 1].trim() === 'low' ? { low: true } : {}) })
  }
  return out
}

function parseLrc(text: string): Cue[] {
  const marks: { t: number; text: string }[] = []
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)]
    if (!stamps.length) continue
    const body = clean(line.replace(/\[[^\]]*\]/g, ''))
    for (const s of stamps) marks.push({ t: Number(s[1]) * 60 + Number(s[2].replace(':', '.')), text: body })
  }
  marks.sort((a, b) => a.t - b.t)
  return marks
    .map((m, i) => ({ start: m.t, end: marks[i + 1]?.t ?? m.t + 5, text: m.text }))
    .filter((c) => c.text)
}

function parseAss(text: string): Cue[] {
  const out: Cue[] = []
  let format: string[] = []
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^Format:/i.test(line) && !format.length) format = line.slice(7).split(',').map((s) => s.trim().toLowerCase())
    if (!/^Dialogue:/i.test(line) || !format.length) continue
    const parts = line.slice(9).split(',')
    const at = (k: string): string => parts[format.indexOf(k)] ?? ''
    const body = parts
      .slice(format.indexOf('text'))
      .join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .trim()
    if (body) out.push({ start: time(at('start')), end: time(at('end')), text: body })
  }
  return out
}

export function parseSubtitle(text: string, ext: string): Cue[] {
  const e = ext.toLowerCase()
  const cues = e === '.lrc' ? parseLrc(text) : e === '.ass' || e === '.ssa' ? parseAss(text) : parseBlocks(text)
  return cues.filter((c) => isFinite(c.start) && isFinite(c.end)).sort((a, b) => a.start - b.start)
}

export const isEnvMade = (text: string): boolean => text.slice(0, 200).includes(ENV_MARK)
