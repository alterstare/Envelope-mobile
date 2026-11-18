// The library on the phone. Each 라이브러리 폴더 (NAS or phone) is read from
// Envelope's 모바일 정보 파일 when the folder has one (.envelope/mobile.envpack —
// repaired / translated names, lengths, DLsite info, the program's subtitles),
// else scanned with Envelope's own scan (envcore/scan.ts). Either way a folder
// becomes a list of PackWork, cached in the app's files, and the screens get
// Envelope's WorkSummary / WorkDetail built from it (ports of core/library).
//
// What the user does on the phone (즐겨찾기, 평점, 그룹, 이어 듣기, 북마크, 싱크 …)
// is kept on the phone (state.ts). A work seen for the first time in a pack
// starts from the PC's state.
import type { Bookmark, Edition, Group, LibrarySource, Settings, SubFile, TrackGroup, TrackVersion, WorkDetail, WorkSummary, SePref, FormatPref } from '../shared/types'
import type { MobilePack, PackTrack, PackWork } from '../shared/mobilePack'
import { PACK_FILE, PACK_FORMAT } from '../shared/mobilePack'
import { native, joinPath, readGzipText } from './native'
import { naturalCompare } from './envcore/normalize'
import { contentLangOfName, langOfName } from './envcore/subtitle'
import { findWorks, scanWork, splitByTrackCode } from './envcore/scan'
import type { ScannedWork } from './envcore/scan'
import { userOf, workUsers, saveState, state, groupIdByName } from './state'
import type { WorkUser } from './state'

export const FINISHED_MARGIN = 10 // s before the end that count as heard to the end
export const APP_SUB = 'envsub:'

// One library folder as last read.
export interface SourceData {
  id: string
  root: string
  kind: 'pack' | 'scan'
  readAt: number
  packAt: number // pack's createdAt (0 = scanned)
  packMtime: number
  works: PackWork[]
  subs: Record<string, Record<string, string>>
}

const sources = new Map<string, SourceData>()
let dataDir = ''
// numeric ids the screens use ⇄ "<source>|<work rel>"
const keyOfId = new Map<number, string>()

export async function initLibrary(dir: string, list: LibrarySource[]): Promise<void> {
  dataDir = dir
  for (const s of list) {
    try {
      const d = JSON.parse((await native.fsReadText({ path: cachePath(s.id) })).data) as SourceData
      if (d.root === s.path) sources.set(s.id, d)
    } catch {
      // not read yet
    }
  }
  indexIds()
}

const cachePath = (id: string): string => `${dataDir}/library-${id}.json`

function indexIds(): void {
  keyOfId.clear()
  for (const [sid, d] of sources) for (const w of d.works) keyOfId.set(idOf(`${sid}|${w.rel}`), `${sid}|${w.rel}`)
}

function idOf(key: string): number {
  let id = state.ids[key]
  if (!id) {
    id = state.nextId++
    state.ids[key] = id
    saveState()
  }
  return id
}

export const hasSource = (id: string): boolean => sources.has(id)
export const sourceInfo = (id: string): SourceData | undefined => sources.get(id)

export function dropSource(id: string): void {
  sources.delete(id)
  indexIds()
}

// ---- reading a folder ----

export interface ReadResult {
  kind: 'pack' | 'scan'
  works: number
}

// The pack when the folder has one, else a scan. onStep(done, total) while scanning.
export async function readSource(s: LibrarySource, onStep: (done: number, total: number) => void, force = false): Promise<ReadResult> {
  const packPath = joinPath(s.path, PACK_FILE)
  const st = await native.fsStat({ path: packPath }).catch(() => null)
  let data: SourceData
  if (st?.exists) {
    const old = sources.get(s.id)
    if (!force && old?.kind === 'pack' && old.packMtime === st.mtime) return { kind: 'pack', works: old.works.length }
    onStep(0, 0)
    const pack = JSON.parse(await readGzipText(packPath)) as MobilePack
    if (pack.format !== PACK_FORMAT) throw new Error('모바일 정보 파일을 읽을 수 없습니다 (형식이 다름)')
    data = { id: s.id, root: s.path, kind: 'pack', readAt: Date.now(), packAt: pack.createdAt, packMtime: st.mtime, works: pack.works, subs: pack.subs ?? {} }
    importPack(s.id, pack)
  } else {
    const dirs = await findWorks(s.path)
    const works: PackWork[] = []
    for (let i = 0; i < dirs.length; i++) {
      onStep(i, dirs.length)
      const w = await scanWork(dirs[i])
      for (const part of splitByTrackCode(w) ?? [w]) works.push(fromScan(s.path, part))
    }
    onStep(dirs.length, dirs.length)
    data = { id: s.id, root: s.path, kind: 'scan', readAt: Date.now(), packAt: 0, packMtime: 0, works, subs: {} }
  }
  sources.set(s.id, data)
  indexIds()
  await native.fsWriteText({ path: cachePath(s.id), data: JSON.stringify(data) })
  return { kind: data.kind, works: data.works.length }
}

const relOf = (root: string, p: string): string => p.slice(root.replace(/\/+$/, '').length + 1)

function fromScan(root: string, w: ScannedWork): PackWork {
  const rel = (p: string): string => relOf(root, p)
  const subsLangs: Record<string, 'user'> = {}
  for (const t of w.tracks) for (const s of t.subs) {
    const l = contentLangOfName(s.path) ?? s.lang
    if (l && l !== 'other') subsLangs[l] = 'user'
  }
  return {
    id: 0,
    rel: rel(w.path),
    code: w.code,
    title: w.title,
    folderTitle: w.title,
    dlTitle: null,
    cover: w.cover ? rel(w.cover) : null,
    images: w.images.map(rel),
    addedAt: w.addedAt ?? Date.now(),
    circle: null,
    voices: [],
    tags: [],
    content: { scripts: [], subs: subsLangs, voice: 'ja' },
    age: null,
    lang: 'ja',
    mojibake: false,
    sePref: null,
    edition: null,
    favorite: false,
    rank: 0,
    plays: 0,
    lastPlayedAt: null,
    lastGroup: null,
    groupIds: [],
    progress: {},
    offsets: {},
    bookmarks: [],
    tracks: w.tracks.map(
      (t, i): PackTrack => ({
        id: i + 1,
        rel: rel(t.path),
        title: t.title,
        ext: t.ext,
        kind: t.kind,
        role: t.role,
        edition: t.edition,
        editionKey: t.editionKey,
        se: t.se,
        formatDir: t.formatDir,
        groupKey: t.groupKey,
        sort: t.sort,
        duration: null,
        bitrate: null,
        relDir: t.relDir,
        subs: t.subs.map((s) => ({ rel: rel(s.path), lang: s.lang }))
      })
    )
  }
}

// A work first met in a pack takes the PC's state (groups by name).
function importPack(sid: string, pack: MobilePack): void {
  const names = new Map(pack.groups.map((g) => [g.id, g.name]))
  for (const w of pack.works) {
    const key = `${sid}|${w.rel}`
    if (state.works[key]) continue
    const u: WorkUser = {
      favorite: w.favorite,
      rank: w.rank,
      groups: w.groupIds.map((g) => names.get(g)).filter((x): x is string => !!x).map(groupIdByName),
      plays: w.plays,
      lastPlayedAt: w.lastPlayedAt,
      lastGroup: w.lastGroup,
      sePref: w.sePref,
      edition: w.edition,
      progress: Object.fromEntries(Object.entries(w.progress).map(([k, p]) => [k, { position: p.position, duration: p.duration, at: 0 }])),
      offsets: { ...w.offsets },
      bookmarks: w.bookmarks.map((b) => ({ id: state.nextId++, groupKey: b.groupKey, position: b.position, name: b.name, createdAt: b.createdAt }))
    }
    state.works[key] = u
  }
  saveState()
}

// ---- building what the screens show (core/library ports) ----

const LOSSLESS = new Set(['.wav', '.flac'])
export function chooseVersion(vs: TrackVersion[], se: SePref, format: FormatPref): TrackVersion {
  const seRank = (v: TrackVersion): number => (v.se === se ? 0 : v.se === 'unknown' ? 1 : 2)
  const fmtRank = (v: TrackVersion): number => (LOSSLESS.has(v.ext) === (format === 'lossless') ? 0 : 1)
  return [...vs].sort(
    (a, b) => seRank(a) - seRank(b) || fmtRank(a) - fmtRank(b) || (b.bitrate ?? 0) - (a.bitrate ?? 0) || naturalCompare(a.path, b.path)
  )[0]
}

function editionsOf(tracks: PackTrack[]): Edition[] {
  const m = new Map<string, string>()
  for (const t of tracks) if (t.role === 'main' && !m.has(t.editionKey)) m.set(t.editionKey, t.edition || '기본')
  if (m.size <= 1) return []
  return [...m].map(([key, label]) => ({ key, label })).sort((a, b) => naturalCompare(a.label, b.label))
}

const abs = (root: string, rel: string): string => joinPath(root, rel)

function subFile(sid: string, root: string, s: { rel: string; lang: SubFile['lang'] }): SubFile {
  if (s.rel.startsWith(APP_SUB)) {
    const rest = s.rel.slice(APP_SUB.length)
    const at = rest.indexOf(':')
    return { path: `${APP_SUB}${rest.slice(0, at)}:${sid}|${rest.slice(at + 1)}`, lang: s.lang }
  }
  const path = abs(root, s.rel)
  return { path, lang: s.lang ?? langOfName(path) }
}

function versionOf(sid: string, root: string, t: PackTrack): TrackVersion {
  return {
    id: t.id,
    path: abs(root, t.rel),
    title: t.title,
    ext: t.ext,
    kind: t.kind,
    se: t.se,
    formatDir: t.formatDir,
    relDir: t.relDir,
    bitrate: t.bitrate,
    duration: t.duration,
    subs: t.subs.map((s) => subFile(sid, root, s))
  }
}

function buildGroups(sid: string, root: string, w: PackWork, u: WorkUser, s: Settings): { groups: TrackGroup[]; editions: Edition[]; edition: string } {
  const editions = editionsOf(w.tracks)
  const want = u.edition ?? w.edition
  const edition = editions.length ? (editions.some((e) => e.key === want) ? want! : editions[0].key) : ''
  const sePref = u.sePref ?? w.sePref ?? s.sePref
  const byGroup = new Map<string, PackTrack[]>()
  for (const t of w.tracks) {
    if (t.role === 'main' && editions.length && t.editionKey !== edition) continue
    const g = byGroup.get(t.groupKey)
    if (g) g.push(t)
    else byGroup.set(t.groupKey, [t])
  }
  const roleOrder = { main: 0, extra: 1, sample: 2 }
  const groups = [...byGroup.entries()]
    .sort(([, a], [, b]) => roleOrder[a[0].role] - roleOrder[b[0].role] || a[0].sort - b[0].sort)
    .map(([key, rows]): TrackGroup => {
      const versions = rows.map((t) => versionOf(sid, root, t))
      const chosen = chooseVersion(versions, sePref, s.formatPref)
      const p = u.progress[key]
      // a length the player learned on the phone fills one the scan didn't know
      const duration = chosen.duration ?? versions.find((v) => v.duration)?.duration ?? p?.duration ?? null
      const d = p?.duration ?? duration
      return {
        key,
        title: chosen.title,
        role: rows[0].role,
        versions,
        chosen: chosen.id,
        position: p?.position ?? 0,
        duration,
        finished: !!p && !!d && p.position >= d - FINISHED_MARGIN,
        subOffset: u.offsets[key] ?? 0
      }
    })
  return { groups, editions, edition }
}

function each(fn: (sid: string, d: SourceData, w: PackWork, key: string) => void): void {
  for (const [sid, d] of sources) for (const w of d.works) fn(sid, d, w, `${sid}|${w.rel}`)
}

let shuffleSeed = (Math.random() * 2 ** 32) >>> 0
let lastSort: Settings['libSort'] | null = null
function shuffleKey(id: number): number {
  let h = (id ^ shuffleSeed) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  return (h ^ (h >>> 16)) >>> 0
}

export function listWorks(s: Settings): WorkSummary[] {
  const out: WorkSummary[] = []
  each((sid, d, w, key) => {
    const u = userOf(key)
    const { groups } = buildGroups(sid, d.root, w, u, s)
    const main = groups.filter((g) => g.role === 'main')
    const known = main.filter((g) => g.duration)
    out.push({
      id: idOf(key),
      path: abs(d.root, w.rel),
      code: w.code,
      title: w.title,
      cover: w.cover ? abs(d.root, w.cover) : null,
      tracks: main.length,
      duration: known.length ? known.reduce((n, g) => n + g.duration!, 0) : null,
      played: main.filter((g) => g.position > 0).length,
      finished: main.filter((g) => g.finished).length,
      addedAt: w.addedAt,
      lastPlayedAt: u.lastPlayedAt,
      mojibake: w.mojibake,
      favorite: u.favorite,
      rank: u.rank,
      plays: u.plays,
      groupIds: u.groups,
      lang: w.lang,
      subtitled: main.filter((g) => g.versions.some((v) => v.subs.length)).length,
      folderTitle: w.folderTitle,
      circle: w.circle,
      voices: w.voices,
      tags: w.tags,
      content: w.content,
      age: w.age,
      dlFetched: !!w.dlTitle,
      covers: { folder: null, dlsite: null, pref: null }
    })
  })
  const by: Record<Settings['libSort'], (a: WorkSummary, b: WorkSummary) => number> = {
    recent: (a, b) => (a.lastPlayedAt ?? 0) - (b.lastPlayedAt ?? 0) || a.addedAt - b.addedAt,
    added: (a, b) => a.addedAt - b.addedAt,
    title: (a, b) => naturalCompare(a.title, b.title),
    code: (a, b) => naturalCompare(a.code ?? '~', b.code ?? '~'),
    length: (a, b) => (a.duration ?? 0) - (b.duration ?? 0),
    rank: (a, b) => a.rank - b.rank || naturalCompare(b.title, a.title),
    plays: (a, b) => a.plays - b.plays || (a.lastPlayedAt ?? 0) - (b.lastPlayedAt ?? 0),
    random: (a, b) => shuffleKey(a.id) - shuffleKey(b.id)
  }
  if (s.libSort === 'random' && lastSort !== 'random') shuffleSeed = (Math.random() * 2 ** 32) >>> 0
  lastSort = s.libSort
  out.sort(by[s.libSort] ?? by.recent)
  return s.libDir === 'desc' ? out.reverse() : out
}

function find(id: number): { sid: string; d: SourceData; w: PackWork; key: string } | null {
  const key = keyOfId.get(id)
  if (!key) return null
  const at = key.indexOf('|')
  const sid = key.slice(0, at)
  const d = sources.get(sid)
  const w = d?.works.find((x) => x.rel === key.slice(at + 1))
  return d && w ? { sid, d, w, key } : null
}

export const workKey = (id: number): string | null => keyOfId.get(id) ?? null

export function workDetail(id: number, s: Settings): WorkDetail | null {
  const f = find(id)
  if (!f) return null
  const { sid, d, w, key } = f
  const u = userOf(key)
  const { groups, editions, edition } = buildGroups(sid, d.root, w, u, s)
  const order = groups.map((g) => g.key)
  const bookmarks: Bookmark[] = u.bookmarks
    .map((b) => ({ ...b, workId: id }))
    .sort((a, b) => order.indexOf(a.groupKey) - order.indexOf(b.groupKey) || a.position - b.position)
  return {
    id,
    path: abs(d.root, w.rel),
    code: w.code,
    title: w.title,
    cover: w.cover ? abs(d.root, w.cover) : null,
    images: w.images.map((x) => abs(d.root, x)),
    editions,
    edition,
    sePref: u.sePref ?? w.sePref ?? s.sePref,
    hasSeChoice: groups.some((g) => g.versions.some((v) => v.se === 'on') && g.versions.some((v) => v.se === 'off')),
    groups,
    lastGroup: u.lastGroup,
    mojibake: w.mojibake,
    favorite: u.favorite,
    rank: u.rank,
    groupIds: u.groups,
    lang: w.lang,
    folderTitle: w.folderTitle,
    dlTitle: w.dlTitle,
    circle: w.circle,
    tags: w.tags,
    content: w.content,
    age: w.age,
    voices: w.voices,
    bookmarks
  }
}

// The text of a subtitle kept in Envelope ("envsub:<lang>:<source>|<track rel>").
export function appSubText(path: string): string | null {
  const rest = path.slice(APP_SUB.length)
  const at = rest.indexOf(':')
  const lang = rest.slice(0, at)
  const ref = rest.slice(at + 1)
  const bar = ref.indexOf('|')
  return sources.get(ref.slice(0, bar))?.subs[ref.slice(bar + 1)]?.[lang] ?? null
}

export function listGroups(): Group[] {
  const users = workUsers()
  const live = new Set<string>()
  each((_s, _d, _w, key) => live.add(key))
  return state.groups.map((g) => ({
    id: g.id,
    name: g.name,
    count: [...users].filter(([k, u]) => live.has(k) && u.groups.includes(g.id)).length
  }))
}

export function worksIn(sourceId: string): number {
  return sources.get(sourceId)?.works.length ?? 0
}
