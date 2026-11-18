// Screen state (Envelope's store, trimmed for the phone: no LP tabs, file
// tools, window modes or Halftone embedding; settings save at once).
import { create } from 'zustand'
import type { Group, ProgressEvent, Settings, SubtitleText, WorkDetail, WorkSummary } from '../../shared/types'
import type { OverlayState } from '../../backend/native'
import type { ContentKey } from './workInfo'

// library → work page → now playing (full player with subtitles)
export type View = 'library' | 'work' | 'now' | 'settings'
export type SleepMode = 'off' | 'time' | 'track' | 'work'
export type ListenState = 'new' | 'listening' | 'done'

export interface Toast {
  ok: boolean
  message: string
}

export interface NowPlaying {
  work: WorkDetail
  groupKey: string
  trackId: number
}

// Subtitles of the track playing: the Japanese original and the Korean
// translation when both exist, else whichever there is.
export interface Subs {
  trackId: number
  ja: SubtitleText | null
  ko: SubtitleText | null
  other: SubtitleText | null
  borrowed: boolean // taken from another version of the track (SE 포함 ↔ 제외)
}

export interface LibFilter {
  favorites: boolean
  listen: Record<ListenState, boolean>
  content: Record<ContentKey, boolean> // 언어 분류 › 자막 · 대본 (missing = shown)
  voice: Record<string, boolean> // 언어 분류 › 음성 (missing = shown)
  age: Record<'r18' | 'general' | 'unknown', boolean> // 연령 분류
  groups: number[] | null // null = all; [] + ungrouped
  ungrouped: boolean
}

export const ALL_FILTER: LibFilter = {
  favorites: false,
  listen: { new: true, listening: true, done: true },
  content: {},
  voice: {},
  age: { r18: true, general: true, unknown: true },
  groups: null,
  ungrouped: true
}

export interface State {
  view: View
  settings: Settings | null
  works: WorkSummary[]
  groups: Group[]
  query: string
  libPage: { key: string; page: number }
  filter: LibFilter
  shown: WorkDetail | null // work open on the work page
  now: NowPlaying | null // what the player holds
  playing: boolean
  time: number
  duration: number
  sleep: { mode: SleepMode; endsAt: number | null; minutes: number }
  imgIndex: number
  subs: Subs | null
  editing: boolean // (the PC's subtitle editor; never on the phone)
  scan: ProgressEvent | null
  overlay: OverlayState // 떠 있는 자막
  toast: Toast | null
  history: { view: View; workId: number | null }[]
  historyAt: number

  setView: (v: View) => void
  setQuery: (q: string) => void
  setFilter: (f: Partial<LibFilter>) => void
  loadSettings: () => Promise<void>
  saveSettings: (p: Partial<Settings>) => Promise<void>
  loadWorks: () => Promise<void>
  loadGroups: () => Promise<void>
  openWork: (id: number) => Promise<void>
  refreshWork: (id?: number) => Promise<void>
  patchWork: (id: number, p: Partial<WorkSummary & WorkDetail>) => void
  showToast: (t: Toast) => void
  navBack: () => void
}

const MAX_HISTORY = 50
let navigating = false // set while back moves, so it isn't recorded again
let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useStore = create<State>((set, get) => ({
  view: 'library',
  settings: null,
  works: [],
  groups: [],
  query: '',
  libPage: { key: '', page: 0 },
  filter: ALL_FILTER,
  shown: null,
  now: null,
  playing: false,
  time: 0,
  duration: 0,
  sleep: { mode: 'off', endsAt: null, minutes: 30 },
  imgIndex: 0,
  subs: null,
  editing: false,
  scan: null,
  overlay: { allowed: false, enabled: false, locked: false, size: 18 },
  toast: null,
  history: [{ view: 'library', workId: null }],
  historyAt: 0,

  setView: (view) => {
    set({ view })
    record(view, view === 'work' ? (get().shown?.id ?? null) : null)
  },
  setQuery: (query) => set({ query }),
  setFilter: (f) => set({ filter: { ...get().filter, ...f } }),
  loadSettings: async () => set({ settings: await window.api.getSettings() }),
  saveSettings: async (p) => {
    const cur = get().settings
    if (cur) set({ settings: { ...cur, ...p } }) // instant; the saved copy follows
    set({ settings: await window.api.saveSettings(p) })
  },
  loadWorks: async () => set({ works: await window.api.works() }),
  loadGroups: async () => set({ groups: await window.api.groups() }),
  openWork: async (id) => {
    const w = await window.api.work(id)
    if (!w) return
    set({ shown: w, view: 'work' })
    record('work', id)
  },
  // Reload a work (default: the one shown) and the copy the player holds.
  refreshWork: async (id) => {
    const target = id ?? get().shown?.id
    if (target === undefined) return
    const w = await window.api.work(target)
    if (!w) return
    if (get().shown?.id === w.id) set({ shown: w })
    const now = get().now
    if (now?.work.id === w.id) set({ now: { ...now, work: w } })
  },
  // Local update after a change the backend has already saved.
  patchWork: (id, p) => {
    const { works, shown, now } = get()
    set({
      works: works.map((w) => (w.id === id ? { ...w, ...p } : w)),
      shown: shown?.id === id ? { ...shown, ...p } : shown,
      now: now?.work.id === id ? { ...now, work: { ...now.work, ...p } } : now
    })
  },
  showToast: (t) => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: t })
    toastTimer = setTimeout(() => set({ toast: null }), 4000)
  },
  navBack: () => void go(-1)
}))

function record(view: View, workId: number | null): void {
  if (navigating) return
  const { history, historyAt } = useStore.getState()
  const cur = history[historyAt]
  if (cur && cur.view === view && cur.workId === workId) return
  const next = [...history.slice(0, historyAt + 1), { view, workId }].slice(-MAX_HISTORY)
  useStore.setState({ history: next, historyAt: next.length - 1 })
}

async function go(dir: -1 | 1): Promise<void> {
  const st = useStore.getState()
  const at = st.historyAt + dir
  const h = st.history[at]
  if (!h) return
  navigating = true
  try {
    useStore.setState({ historyAt: at })
    if (h.view === 'work' && h.workId !== null) {
      const w = await window.api.work(h.workId)
      if (w) useStore.setState({ shown: w, view: 'work' })
    } else if (h.view !== 'now' || st.now) useStore.setState({ view: h.view })
    else useStore.setState({ view: 'library' })
  } finally {
    navigating = false
  }
}

export function listenState(w: WorkSummary): ListenState {
  if (w.tracks && w.finished === w.tracks) return 'done'
  return w.played > 0 ? 'listening' : 'new'
}
