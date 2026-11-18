// What the user did on the phone, per work ("<source>|<work rel>"): 즐겨찾기,
// 평점, 그룹, 감상 횟수, 이어 듣기 위치, 북마크, 자막 싱크, SE / 판 선택. Kept in
// localStorage (small; the library itself is cached in files), written a
// moment after each change and when the app goes to the background.
import type { SePref } from '../shared/types'

export interface WorkUser {
  favorite: boolean
  rank: number
  groups: number[]
  plays: number
  lastPlayedAt: number | null
  lastGroup: string | null
  sePref: SePref | null
  edition: string | null
  progress: Record<string, { position: number; duration: number | null; at: number }>
  offsets: Record<string, number>
  bookmarks: { id: number; groupKey: string; position: number; name: string; createdAt: number }[]
}

interface State {
  ids: Record<string, number>
  nextId: number
  works: Record<string, WorkUser>
  groups: { id: number; name: string }[]
  nextGroup: number
}

const KEY = 'env-state'

function load(): State {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '') as State
    if (s && s.ids && s.works) return s
  } catch {
    // first start
  }
  return { ids: {}, nextId: 1, works: {}, groups: [], nextGroup: 1 }
}

export const state: State = load()

let timer: ReturnType<typeof setTimeout> | null = null
export function saveState(now = false): void {
  if (timer) clearTimeout(timer)
  timer = null
  const write = (): void => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      // storage full: kept in memory for this run
    }
  }
  if (now) write()
  else timer = setTimeout(write, 800)
}

const blank = (): WorkUser => ({
  favorite: false,
  rank: 0,
  groups: [],
  plays: 0,
  lastPlayedAt: null,
  lastGroup: null,
  sePref: null,
  edition: null,
  progress: {},
  offsets: {},
  bookmarks: []
})

// Read-only view (a work never touched has no entry).
export function userOf(key: string): WorkUser {
  return state.works[key] ?? blank()
}

// For a change: the entry, made when missing.
export function editUser(key: string): WorkUser {
  let u = state.works[key]
  if (!u) {
    u = blank()
    state.works[key] = u
  }
  return u
}

export function workUsers(): [string, WorkUser][] {
  return Object.entries(state.works)
}

export function groupIdByName(name: string): number {
  const g = state.groups.find((x) => x.name === name)
  if (g) return g.id
  const id = state.nextGroup++
  state.groups.push({ id, name })
  return id
}
