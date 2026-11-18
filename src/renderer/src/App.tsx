// Envelope 모바일: the PC app's small-window screens (Spotify mobile) on a
// phone — library → work page → 지금 재생, the mini player at the bottom, 설정
// from the library head. Android back closes the topmost thing (touch.ts),
// else steps back, and on the library puts the app behind (playback goes on).
import { useEffect } from 'react'
import type { JSX } from 'react'
import { useStore } from './store'
import { drain, onPlayerState, restore } from './player'
import { popBack } from './touch'
import { native } from '../../backend/native'
import Library from './components/Library'
import WorkPage from './components/WorkPage'
import NowView from './components/NowView'
import NowBar from './components/NowBar'
import SubStrip from './components/SubStrip'
import SettingsView from './components/SettingsView'
import { arrowText } from './arrowText'

function back(): void {
  if (popBack()) return
  const st = useStore.getState()
  if (st.view === 'library') {
    void native.exitApp()
    return
  }
  if (st.view === 'settings') return st.setView('library')
  if (st.historyAt > 0) st.navBack()
  else st.setView('library')
}

export default function App(): JSX.Element {
  const view = useStore((s) => s.view)
  const settings = useStore((s) => s.settings)
  const now = useStore((s) => s.now)
  const toast = useStore((s) => s.toast)
  const shownId = useStore((s) => s.shown?.id)

  useEffect(() => {
    const s = useStore.getState()
    void (async () => {
      await s.loadSettings()
      await s.loadWorks()
      void s.loadGroups()
      await restore()
      await drain()
      void native.overlayStatus().then((o) => useStore.setState({ overlay: o }))
      // a new 모바일 정보 파일 from Envelope (PC) → the list again
      if (await window.api.refreshPacks()) {
        void s.loadWorks()
        void s.loadGroups()
      }
    })()
    const offProgress = window.api.onProgress((e) => useStore.setState({ scan: e }))
    const handles = [
      native.addListener('player', onPlayerState),
      native.addListener('overlay', (o) => useStore.setState({ overlay: o })),
      native.addListener('sleep', (x) =>
        useStore.setState((st) => ({ sleep: { ...st.sleep, mode: x.mode as 'off' | 'time' | 'track' | 'work', endsAt: x.mode === 'time' ? x.endsAt : null } }))
      ),
      native.addListener('error', () => useStore.getState().showToast({ ok: false, message: '이 파일을 재생할 수 없습니다. NAS 연결을 확인하세요.' })),
      native.addListener('back', back),
      // back from the background: what the player did meanwhile
      native.addListener('resume', () => {
        void drain()
        // what Envelope (PC) changed meanwhile
        void window.api.refreshPacks().then((c) => c && (void useStore.getState().loadWorks(), void useStore.getState().loadGroups()))
        void native.overlayStatus().then((o) => useStore.setState({ overlay: o }))
      })
    ]
    return () => {
      offProgress()
      handles.forEach((h) => void h.then((x) => x.remove()))
    }
  }, [])

  useEffect(() => {
    if (settings) document.documentElement.dataset.theme = settings.theme
  }, [settings?.theme]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`app view-${view} ${now ? 'has-now' : ''}`}>
      <div className="middle tabs-right">
        <main className="content" key={view === 'work' ? `work-${shownId}` : view}>
          {view === 'library' && <Library />}
          {view === 'work' && <WorkPage />}
          {view === 'now' && <NowView />}
          {view === 'settings' && <SettingsView />}
        </main>
        <SubStrip />
      </div>
      <NowBar />
      {toast && <div className={`toast ${toast.ok ? '' : 'bad'}`}>{arrowText(toast.message)}</div>}
    </div>
  )
}
