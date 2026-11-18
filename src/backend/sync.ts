// Sharing with Envelope (PC) through the library folder, the way Sorta 모바일
// does (shared/mobilePack.ts): every change on the phone is an edit, applied
// here at once (state.ts) and — for a folder that has Envelope's pack — written
// as `.envelope/mobile/<device>-<time>.json` a moment later. Envelope applies
// and deletes those files and writes the pack again. The edits are kept in a
// journal (localStorage) and laid over every pack read until their file is
// gone and the pack is newer than they are.
import type { MobileEdit, MobileEditFile } from '../shared/mobilePack'
import { EDITS_FORMAT, PACK_EDITS, sameBookmark } from '../shared/mobilePack'
import { joinPath, native } from './native'
import { editUser, groupIdByName, saveState, state } from './state'

const FLUSH_MS = 2500 // after a change
const PROGRESS_FLUSH_MS = 30_000 // only listening positions changed: fewer files while playing
const JOURNAL_KEY = 'env-journal'

interface Entry {
  source: string
  file: string // path on the NAS ('' = not written yet)
  createdAt: number
  edits: MobileEdit[]
}

function device(): string {
  let d = localStorage.getItem('env-device')
  if (!d) {
    d = `phone${Math.random().toString(36).slice(2, 8)}`
    localStorage.setItem('env-device', d)
  }
  return d
}

let journal: Entry[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? '[]') as Entry[]
  } catch {
    return []
  }
})()
const saveJournal = (): void => localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal))

// ---- applying an edit to the phone's state ----

export function applyLocal(key: string | null, e: MobileEdit): void {
  if (e.op === 'group') {
    const g = state.groups.find((x) => x.name === e.name)
    if (e.action === 'create') groupIdByName(e.name)
    else if (e.action === 'rename' && g && e.to && !state.groups.some((x) => x.name === e.to)) g.name = e.to
    else if (e.action === 'delete' && g) {
      state.groups = state.groups.filter((x) => x !== g)
      for (const u of Object.values(state.works)) u.groups = u.groups.filter((x) => x !== g.id)
    }
    saveState()
    return
  }
  if (!key) return
  const u = editUser(key)
  if (e.op === 'work') {
    const s = e.set
    if (s.favorite !== undefined) u.favorite = s.favorite
    if (s.rank !== undefined) u.rank = Math.max(0, Math.min(5, s.rank))
    if (s.sePref !== undefined) u.sePref = s.sePref
    if (s.edition !== undefined) u.edition = s.edition
    if (s.groups) u.groups = s.groups.map(groupIdByName)
  } else if (e.op === 'progress') {
    const old = u.progress[e.groupKey]
    if (old && old.at > e.at) return
    u.progress[e.groupKey] = { position: e.position, duration: e.duration ?? old?.duration ?? null, at: e.at }
    if ((u.lastPlayedAt ?? 0) <= e.at) {
      u.lastPlayedAt = e.at
      u.lastGroup = e.groupKey
    }
  } else if (e.op === 'reset') {
    for (const [k, p] of Object.entries(u.progress)) if (p.at <= e.at) delete u.progress[k]
    if (!Object.keys(u.progress).length) u.lastGroup = null
  } else if (e.op === 'play') u.plays++
  else if (e.op === 'offset') u.offsets[e.groupKey] = e.offset
  else if (e.op === 'bookmark') {
    if (e.action === 'add') {
      if (!u.bookmarks.some((b) => sameBookmark(b, e)))
        u.bookmarks.push({ id: state.nextId++, groupKey: e.groupKey, position: e.position, name: e.name ?? '북마크', createdAt: e.at })
    } else u.bookmarks = u.bookmarks.filter((b) => !sameBookmark(b, e))
  }
  saveState()
}

// ---- writing edits for Envelope ----

const pending = new Map<string, MobileEdit[]>() // source → edits not written yet
let timer: ReturnType<typeof setTimeout> | null = null
let roots: (id: string) => string | null = () => null // source id → its folder, when it has a pack

export function setShared(fn: (id: string) => string | null): void {
  roots = fn
}

// One change: applied here, and queued for the PC when the folder is shared.
export function change(source: string | null, rel: string | null, e: MobileEdit): void {
  applyLocal(source && rel !== null ? `${source}|${rel}` : null, e)
  const targets = e.op === 'group' ? [...new Set(Object.keys(state.ids).map((k) => k.slice(0, k.indexOf('|'))))] : source ? [source] : []
  let queued = false
  for (const s of targets) {
    if (!roots(s)) continue
    const list = pending.get(s) ?? []
    // listening positions: only the newest per track goes out
    if (e.op === 'progress') {
      const i = list.findIndex((x) => x.op === 'progress' && x.work === e.work && x.groupKey === e.groupKey)
      if (i >= 0) list.splice(i, 1)
    }
    list.push(e)
    pending.set(s, list)
    queued = true
  }
  if (!queued) return
  const onlyProgress = [...pending.values()].every((l) => l.every((x) => x.op === 'progress'))
  if (timer && onlyProgress) return // a sooner flush is already due, or the progress one
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void flush(), onlyProgress ? PROGRESS_FLUSH_MS : FLUSH_MS)
}

let packAt = new Map<string, number>()
export function notePack(source: string, createdAt: number): void {
  packAt.set(source, createdAt)
}

async function write(entry: Entry): Promise<void> {
  const root = roots(entry.source)
  if (!root) return
  const name = `${device()}-${entry.createdAt}.json`
  const file = joinPath(root, `${PACK_EDITS}/${name}`)
  const body: MobileEditFile = { format: EDITS_FORMAT, version: 1, device: device(), createdAt: entry.createdAt, basedOn: packAt.get(entry.source) ?? 0, edits: entry.edits }
  await native.fsWriteText({ path: file, data: JSON.stringify(body) })
  entry.file = file
}

// Pending edits → files (also when the app goes to the background).
export async function flush(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  for (const [source, edits] of pending) {
    if (!edits.length) continue
    pending.delete(source)
    const entry: Entry = { source, file: '', createdAt: Date.now(), edits }
    journal.push(entry)
    try {
      await write(entry)
    } catch {
      // NAS not reachable: written with the next pack read
    }
  }
  saveJournal()
}

// A pack was just read for `source` (its state already laid in): edits Envelope
// has applied are dropped, the rest are applied again on top (and unwritten
// ones written now). keyOf(rel) = the phone's key of a work.
export async function replay(source: string, createdAt: number, keyOf: (rel: string) => string): Promise<void> {
  notePack(source, createdAt)
  const keep: Entry[] = []
  for (const en of journal) {
    if (en.source !== source) {
      keep.push(en)
      continue
    }
    if (en.file) {
      const st = await native.fsStat({ path: en.file }).catch(() => null)
      if (st && !st.exists && en.createdAt <= createdAt) continue // applied by Envelope
    } else {
      try {
        await write(en)
      } catch {
        // still offline
      }
    }
    keep.push(en)
  }
  journal = keep
  saveJournal()
  for (const en of keep.filter((x) => x.source === source)) for (const e of en.edits) applyLocal('work' in e ? keyOf(e.work) : null, e)
  for (const e of pending.get(source) ?? []) applyLocal('work' in e ? keyOf(e.work) : null, e)
}
