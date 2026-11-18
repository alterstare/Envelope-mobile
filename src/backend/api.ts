// window.api on the phone: the same calls the Envelope screens make to the PC
// app's main process, answered here (library.ts / state.ts / the plugin).
import type { Group, LibrarySource, ProgressEvent, SePref, Settings, SubLang, SubtitleText, WorkDetail, WorkSummary } from '../shared/types'
import { native, imgUrl, thumbUrl, readBytes, isNas, joinPath, nasParts, nasPath } from './native'
import { PACK_FILE } from '../shared/mobilePack'
import type { NasConn, NasVia, OverlayConfig } from './native'
import { appSubFile, dropSource, initLibrary, listGroups, listWorks, readSource, refOf, sourceInfo, workDetail, worksIn, APP_SUB } from './library'
import { decodeText, isEnvMade, langOfText, parseSubtitle } from './envcore/subtitle'
import { extname } from './envcore/scan'
import { userOf, saveState, state } from './state'
import { change, flush } from './sync'
import type { MobileEdit } from '../shared/mobilePack'

export interface Toast {
  ok: boolean
  message: string
}

export const DEFAULTS: Settings = {
  sources: [],
  sePref: 'off',
  formatPref: 'mp3',
  seekStep: 5,
  volume: 1,
  rate: 1,
  repeat: 'off',
  shuffle: false,
  libSort: 'recent',
  libDir: 'desc',
  libLayout: 'grid',
  subMode: 'both',
  subSize: 22,
  subsVisible: true,
  lyricsPanel: true,
  resume: true,
  theme: 'light',
  pageSize: 50,
  overlaySize: 18,
  overlayOpacity: 0.86,
  overlayHideInApp: true
}

const SETTINGS_KEY = 'env-settings'
function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>) }
  } catch {
    return { ...DEFAULTS }
  }
}
let settings = loadSettings()

const progressListeners = new Set<(e: ProgressEvent) => void>()
const emit = (e: ProgressEvent): void => progressListeners.forEach((f) => f(e))

let ready: Promise<void> | null = null
async function start(): Promise<void> {
  const info = await native.appInfo()
  await initLibrary(info.dataDir, settings.sources)
}
const boot = (): Promise<void> => (ready ??= start())

// One change to a work: applied on the phone, and written for Envelope (PC)
// when the work's folder is shared (sync.ts).
type WorkEdit = MobileEdit extends infer E ? (E extends { work: string } ? Omit<E, 'work' | 'at'> : never) : never
function edit(id: number, e: WorkEdit, at = Date.now()): void {
  const r = refOf(id)
  if (r) change(r.source, r.rel, { ...e, work: r.rel, at } as MobileEdit)
}
const groupName = (id: number): string | undefined => state.groups.find((g) => g.id === id)?.name
const userById = (id: number): ReturnType<typeof userOf> => {
  const r = refOf(id)
  return userOf(r ? `${r.source}|${r.rel}` : '')
}

let scanning = false
// Read every library folder (the pack when there is one, else a scan).
// force: read packs again even when unchanged.
async function scanAll(force = false, only?: string): Promise<Toast> {
  if (scanning) return { ok: false, message: '이미 읽는 중입니다.' }
  scanning = true
  let packs = 0
  let scanned = 0
  const failed: string[] = []
  try {
    const list = settings.sources.filter((s) => !only || s.id === only)
    for (const s of list) {
      try {
        const r = await readSource(
          s,
          (done, total) => emit({ jobId: 0, label: '라이브러리 스캔', done, total, state: 'running' }),
          force
        )
        if (r.kind === 'pack') packs++
        else scanned++
      } catch (e) {
        failed.push(`${shownPath(s.path)} (${String((e as Error).message ?? e)})`)
      }
    }
  } finally {
    scanning = false
    emit({ jobId: 0, label: '라이브러리 스캔', done: 1, total: 1, state: 'done' })
  }
  const parts = [packs && `모바일 정보 파일 ${packs}곳`, scanned && `폴더 스캔 ${scanned}곳`].filter(Boolean)
  if (failed.length) return { ok: false, message: `읽지 못한 폴더: ${failed.join(', ')}` }
  return { ok: true, message: `라이브러리를 읽었습니다${parts.length ? ` (${parts.join(' · ')})` : ''}.` }
}

// "/nas/<id>/voice/works" → "voice/works" with the connection's name in front
let connNames = new Map<string, string>()
export function shownPath(p: string): string {
  if (!isNas(p)) return p.replace(/^\/storage\/emulated\/0/, '휴대폰')
  const { id, rel } = nasParts(p)
  return `${connNames.get(id) ?? 'NAS'}/${rel}`
}

// A picture's main colour (전체 자막 in the cover's colour): the most common
// hue bucket of its 미리 보기, skipping greys.
async function coverColour(path: string): Promise<string | null> {
  try {
    const img = new Image()
    img.src = thumbUrl(path)
    await img.decode()
    const c = document.createElement('canvas')
    c.width = c.height = 32
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(img, 0, 0, 32, 32)
    const px = g.getImageData(0, 0, 32, 32).data
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
    for (let i = 0; i < px.length; i += 4) {
      const [r, gg, b] = [px[i], px[i + 1], px[i + 2]]
      const max = Math.max(r, gg, b)
      const min = Math.min(r, gg, b)
      if (max - min < 24 || max < 40) continue
      const k = ((r >> 5) << 6) | ((gg >> 5) << 3) | (b >> 5)
      const x = buckets.get(k) ?? { n: 0, r: 0, g: 0, b: 0 }
      x.n++
      x.r += r
      x.g += gg
      x.b += b
      buckets.set(k, x)
    }
    const best = [...buckets.values()].sort((a, b) => b.n - a.n)[0]
    if (!best) return null
    const hex = (v: number): string => Math.round(v / best.n).toString(16).padStart(2, '0')
    return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`
  } catch {
    return null
  }
}

async function readSubtitle(path: string): Promise<SubtitleText> {
  if (path.startsWith(APP_SUB)) {
    const file = appSubFile(path)
    const text = file ? decodeText(await readBytes(file)) : ''
    const lang = path.slice(APP_SUB.length, path.indexOf(':', APP_SUB.length)) as SubLang
    return { path, lang, cues: parseSubtitle(text, '.vtt'), envMade: true }
  }
  const text = decodeText(await readBytes(path))
  const cues = parseSubtitle(text, extname(path))
  const named = path.toLowerCase().match(/\.(ja|jp|jpn|ko|kr|kor)\.[a-z]+$/)
  const lang: SubLang = named ? (/^j/.test(named[1]) ? 'ja' : 'ko') : langOfText(cues.slice(0, 40).map((c) => c.text).join(' '))
  return { path, lang, cues, envMade: isEnvMade(text) }
}

export const api = {
  // ---- start / settings ----
  start: boot,
  getSettings: async (): Promise<Settings> => (await boot(), settings),
  saveSettings: async (p: Partial<Settings>): Promise<Settings> => {
    settings = { ...settings, ...p }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    if (p.theme) void native.setTheme({ dark: p.theme === 'dark' })
    return settings
  },
  onProgress: (cb: (e: ProgressEvent) => void): (() => void) => {
    progressListeners.add(cb)
    return () => progressListeners.delete(cb)
  },

  // ---- library ----
  works: async (): Promise<WorkSummary[]> => (await boot(), listWorks(settings)),
  work: async (id: number): Promise<WorkDetail | null> => (await boot(), workDetail(id, settings)),
  groups: async (): Promise<Group[]> => listGroups(),
  scan: (force = false): Promise<Toast> => scanAll(force),
  // At start (and back from the background): folders with a 모바일 정보 파일 are
  // read again when Envelope wrote a new one; scanned folders wait for 다시 읽기.
  refreshPacks: async (): Promise<boolean> => {
    if (scanning) return false
    let changed = false
    for (const s of settings.sources) {
      const d = sourceInfo(s.id)
      // a scanned folder is read again only once Envelope has left a pack in it
      if (d?.kind === 'scan' && !(await native.fsStat({ path: joinPath(s.path, PACK_FILE) }).catch(() => null))?.exists) continue
      try {
        const before = d?.packMtime
        await readSource(s, (done, total) => emit({ jobId: 0, label: '라이브러리 스캔', done, total, state: 'running' }))
        if (sourceInfo(s.id)?.packMtime !== before || !d) changed = true
      } catch {
        // NAS not reachable now: the cached copy stays
      }
    }
    emit({ jobId: 0, label: '라이브러리 스캔', done: 1, total: 1, state: 'done' })
    return changed
  },
  addSource: async (path: string): Promise<Toast> => {
    if (settings.sources.some((s) => s.path === path)) return { ok: false, message: '이미 추가한 폴더입니다.' }
    const s: LibrarySource = { id: `s${Date.now().toString(36)}`, path }
    await api.saveSettings({ sources: [...settings.sources, s] })
    return scanAll(false, s.id)
  },
  removeSource: async (id: string): Promise<void> => {
    dropSource(id)
    await api.saveSettings({ sources: settings.sources.filter((s) => s.id !== id) })
  },
  sourceWorks: (id: string): number => worksIn(id),

  // ---- per work (shared with Envelope through the folder, sync.ts) ----
  setFavorite: async (ids: number[], on: boolean): Promise<void> => ids.forEach((id) => edit(id, { op: 'work', set: { favorite: on } })),
  setRank: async (ids: number[], r: number): Promise<void> => ids.forEach((id) => edit(id, { op: 'work', set: { rank: Math.max(0, Math.min(5, r)) } })),
  setGroupMembership: async (ids: number[], g: number, on: boolean): Promise<void> =>
    ids.forEach((id) => {
      const have = userById(id).groups.map(groupName).filter((x): x is string => !!x)
      const name = groupName(g)
      if (!name) return
      edit(id, { op: 'work', set: { groups: on ? [...new Set([...have, name])] : have.filter((x) => x !== name) } })
    }),
  createGroup: async (name: string, ids: number[] = []): Promise<number> => {
    const n = name.trim() || '그룹'
    change(null, null, { op: 'group', action: 'create', name: n, at: Date.now() })
    const id = state.groups.find((g) => g.name === n)!.id
    await api.setGroupMembership(ids, id, true)
    return id
  },
  renameGroup: async (id: number, name: string): Promise<void> => {
    const from = groupName(id)
    if (from && name.trim()) change(null, null, { op: 'group', action: 'rename', name: from, to: name.trim(), at: Date.now() })
  },
  deleteGroup: async (id: number): Promise<void> => {
    const n = groupName(id)
    if (n) change(null, null, { op: 'group', action: 'delete', name: n, at: Date.now() })
  },
  countPlay: async (id: number): Promise<number> => {
    edit(id, { op: 'play' })
    return userById(id).plays
  },
  setWorkPrefs: async (id: number, p: { sePref?: SePref; edition?: string }): Promise<void> => edit(id, { op: 'work', set: { ...p } }),
  resetProgress: async (id: number): Promise<void> => edit(id, { op: 'reset' }),
  saveProgress: async (p: { workId: number; groupKey: string; position: number; duration?: number; at?: number }): Promise<void> =>
    edit(p.workId, { op: 'progress', groupKey: p.groupKey, position: p.position, duration: p.duration ?? null }, p.at ?? Date.now()),
  setSubOffset: async (workId: number, groupKey: string, v: number): Promise<void> => edit(workId, { op: 'offset', groupKey, offset: v }),
  addBookmark: async (workId: number, groupKey: string, position: number, name: string): Promise<number> => {
    edit(workId, { op: 'bookmark', action: 'add', groupKey, position: Math.max(0, position), name: name.trim() || '북마크' })
    return userById(workId).bookmarks.find((b) => b.groupKey === groupKey && Math.abs(b.position - position) < 0.5)?.id ?? 0
  },
  deleteBookmark: async (id: number): Promise<void> => {
    for (const [key, u] of Object.entries(state.works)) {
      const b = u.bookmarks.find((x) => x.id === id)
      if (!b) continue
      const wid = state.ids[key]
      if (wid) edit(wid, { op: 'bookmark', action: 'delete', groupKey: b.groupKey, position: b.position })
    }
  },

  // ---- files ----
  thumbUrl: (path: string): string => thumbUrl(path),
  mediaUrl: (path: string): string => imgUrl(path),
  readSubtitle,
  coverColour,

  // ---- NAS / phone folders ----
  nasList: async (): Promise<NasConn[]> => {
    const { conns } = await native.nasList()
    connNames = new Map(conns.map((c) => [c.id, c.name]))
    return conns
  },
  nasTest: async (conn: Partial<NasConn>, via: NasVia, pw: { password?: string; smbPassword?: string }): Promise<number> =>
    (await native.nasTest({ conn, via, ...pw })).count,
  nasSave: async (conn: Partial<NasConn>, pw: { password?: string; smbPassword?: string }): Promise<string> => (await native.nasSave({ conn, ...pw })).id,
  nasRemove: (id: string): Promise<void> => native.nasRemove({ id }),
  nasVia: async (id: string): Promise<NasVia> => (await native.nasVia({ id })).via,
  listDirs: async (path: string): Promise<string[]> => {
    const { entries } = await native.fsReaddir({ path })
    return entries
      .filter((e) => e.isDir && !e.name.startsWith('.') && !e.name.startsWith('@') && e.name !== '#recycle')
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }))
  },
  pickFolder: async (): Promise<string | null> => {
    const st = await native.storageStatus()
    if (!st.granted && !(await native.requestStorage()).granted) return null
    return (await native.pickFolder()).path
  },
  nasPath,

  // ---- 떠 있는 자막 ----
  overlayStatus: () => native.overlayStatus(),
  overlayPermission: () => native.overlayPermission(),
  overlaySet: (c: OverlayConfig) => native.overlaySet(c),

  appInfo: () => native.appInfo(),
  toast: (text: string) => native.toast({ text }),
  clearCache: () => native.clearCache(),
  cacheInfo: () => native.cacheInfo()
}

export type Api = typeof api

declare global {
  interface Window {
    api: Api
  }
}

export function installBackend(): void {
  window.api = api
  window.addEventListener('pagehide', () => (saveState(true), void flush()))
  document.addEventListener('visibilitychange', () => document.hidden && (saveState(true), void flush()))
}
