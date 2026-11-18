// 떠 있는 자막: the subtitle lines in a small window over other apps (drawn by
// the player service — SubOverlay.java). Needs Android's "다른 앱 위에 표시"
// permission, asked through its settings page the first time.
import { useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../store'
import { native } from '../../../backend/native'
import { ClosedCaptionDisabledIcon, ClosedCaptionIcon, LockIcon, LockOpenIcon } from './icons'
import { Confirm } from './ui'

// The window's look from 설정 › 떠 있는 자막 goes along with every switch-on.
function look(): { size: number; opacity: number; hideInApp: boolean } {
  const s = useStore.getState().settings
  return { size: s?.overlaySize ?? 18, opacity: s?.overlayOpacity ?? 0.86, hideInApp: s?.overlayHideInApp ?? true }
}

export async function setOverlay(on: boolean): Promise<void> {
  await native.overlaySet({ enabled: on, ...look() })
  if (on) {
    const st = useStore.getState()
    st.showToast({
      ok: true,
      message: st.settings?.overlayHideInApp ?? true ? '떠 있는 자막을 켰습니다. 다른 앱으로 가면 보입니다.' : '떠 있는 자막을 켰습니다.'
    })
  }
}

export function setOverlayLock(locked: boolean): void {
  void native.overlaySet({ locked })
}

// The switch (지금 재생 utility row): asks for the permission when it isn't there.
export function OverlayButton({ className }: { className?: string }): JSX.Element {
  const o = useStore((s) => s.overlay)
  const [ask, setAsk] = useState(false)
  return (
    <>
      <button
        className={`mini icon ${className ?? ''} ${o.enabled ? 'on' : ''}`}
        title={o.enabled ? '떠 있는 자막 끄기' : '떠 있는 자막 켜기 (다른 앱 위에 자막만 표시)'}
        onClick={() => (o.enabled ? void setOverlay(false) : o.allowed ? void setOverlay(true) : setAsk(true))}
      >
        {o.enabled ? <ClosedCaptionIcon /> : <ClosedCaptionDisabledIcon />}
      </button>
      {ask && (
        <Confirm
          title="다른 앱 위에 표시 권한이 필요합니다"
          body="떠 있는 자막은 다른 앱을 쓰는 동안 그 위에 자막만 작게 띄웁니다. 다음 화면에서 Envelope의 '다른 앱 위에 표시'를 허용한 뒤 돌아오세요."
          ok="설정 열기"
          onCancel={() => setAsk(false)}
          onOk={async () => {
            setAsk(false)
            const r = await native.overlayPermission()
            useStore.setState({ overlay: r })
            if (r.allowed) await setOverlay(true)
          }}
        />
      )}
    </>
  )
}

// 잠금: touches pass through to the app below (also from the notification).
export function OverlayLock({ className }: { className?: string }): JSX.Element | null {
  const o = useStore((s) => s.overlay)
  if (!o.enabled) return null
  return (
    <button
      className={`mini icon ${className ?? ''} ${o.locked ? 'on' : ''}`}
      title={o.locked ? '떠 있는 자막 잠금 풀기 (끌어서 옮길 수 있게)' : '떠 있는 자막 잠그기 (터치가 아래 앱으로)'}
      onClick={() => setOverlayLock(!o.locked)}
    >
      {o.locked ? <LockIcon /> : <LockOpenIcon />}
    </button>
  )
}
