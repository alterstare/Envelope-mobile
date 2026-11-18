// The Android side (EnvPlugin.java). Paths: phone files are absolute paths;
// "/nas/<connId>/<path>" is a file on that NAS connection (SMB / WebDAV).
import { registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'

export interface NasConn {
  id: string
  name: string
  type: 'webdav' | 'smb' | 'both' // what's entered (both = SMB when reachable)
  url: string // WebDAV
  user: string
  insecure: boolean // https with a self-signed certificate
  hasPassword?: boolean
  host: string // SMB
  port: number // 0 = 445
  share: string // "tunnel, voice"
  smbUser: string
  domain: string
  hasSmbPassword?: boolean
}

export type NasVia = 'smb' | 'webdav'

export interface FsEntry {
  name: string
  exists: boolean
  isDir: boolean
  isFile: boolean
  size: number
  mtime: number
}

export interface QueueItem {
  key: string
  path: string
  title: string
  artist: string
  album: string
}

export interface CueArrays {
  s: number[]
  e: number[]
  t: string[]
}

export interface PlayerState {
  index: number
  key: string | null
  keys: string[]
  position: number
  duration: number
  playing: boolean
  ended: boolean
  overlayAllowed?: boolean
}

export interface OverlayState {
  allowed: boolean
  enabled: boolean
  locked: boolean
  size: number
}

export interface OverlayConfig {
  enabled?: boolean
  locked?: boolean
  size?: number
  opacity?: number
  hideInApp?: boolean
}

interface EnvPlugin {
  nasList(): Promise<{ conns: NasConn[] }>
  nasTest(o: { conn: Partial<NasConn>; via: NasVia; password?: string; smbPassword?: string }): Promise<{ count: number }>
  nasSave(o: { conn: Partial<NasConn>; password?: string; smbPassword?: string }): Promise<{ id: string }>
  nasVia(o: { id: string; recheck?: boolean }): Promise<{ via: NasVia }>
  nasRemove(o: { id: string }): Promise<void>
  fsReadText(o: { path: string }): Promise<{ data: string }>
  fsWriteText(o: { path: string; data: string }): Promise<void>
  fsStat(o: { path: string }): Promise<FsEntry>
  fsReaddir(o: { path: string }): Promise<{ entries: FsEntry[] }>
  fsMkdir(o: { path: string }): Promise<void>
  pickFolder(): Promise<{ path: string | null }>
  storageStatus(): Promise<{ granted: boolean }>
  requestStorage(): Promise<{ granted: boolean }>
  appInfo(): Promise<{ version: string; code: number; dataDir: string }>
  setTheme(o: { dark: boolean }): Promise<void>
  toast(o: { text: string }): Promise<void>
  exitApp(): Promise<void>
  cacheInfo(): Promise<{ bytes: number; files: number }>
  clearCache(): Promise<void>
  openUrl(o: { url: string }): Promise<void> // https only, in the browser
  playerLoad(o: { items: QueueItem[]; index: number; start: number; play: boolean; cover: string }): Promise<void>
  playerControl(o: { op: 'play' | 'pause' | 'seek' | 'seekTo' | 'next' | 'prev' | 'rate' | 'repeat' | 'shuffle' | 'stop'; value?: number }): Promise<void>
  playerCues(o: { index: number; orig: CueArrays | null; trans: CueArrays | null; offset: number }): Promise<void>
  playerOffset(o: { index: number; offset: number }): Promise<void>
  playerSubMode(o: { mode: string }): Promise<void>
  playerSleep(o: { mode: string; minutes: number }): Promise<void>
  playerState(): Promise<PlayerState>
  playerDrain(): Promise<{ progress: Record<string, { p: number; d: number; t: number }> }>
  overlaySet(o: OverlayConfig): Promise<void>
  overlayStatus(): Promise<OverlayState>
  overlayPermission(): Promise<OverlayState>
  addListener(ev: 'back' | 'resume' | 'pause', cb: () => void): Promise<PluginListenerHandle>
  addListener(ev: 'player', cb: (s: PlayerState) => void): Promise<PluginListenerHandle>
  addListener(ev: 'overlay', cb: (s: OverlayState) => void): Promise<PluginListenerHandle>
  addListener(ev: 'sleep', cb: (s: { mode: string; endsAt: number }) => void): Promise<PluginListenerHandle>
  addListener(ev: 'error', cb: (s: { message: string }) => void): Promise<PluginListenerHandle>
}

export const native = registerPlugin<EnvPlugin>('Envelope')

export const isNas = (p: string): boolean => p.startsWith('/nas/')

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Served by EnvWebViewClient.java (same origin as the app):
//   img — a picture as it is (NAS ones through the phone's cache)
//   th  — a 미리 보기 (480px) of a picture
//   raw — a file as it is now, no cache (모바일 정보 파일, subtitle files)
export const imgUrl = (path: string): string => `https://localhost/_s/img/${b64url(path)}`
export const thumbUrl = (path: string, version = 0): string => `https://localhost/_s/th/${b64url(path)}?m=${version}`
export const rawUrl = (path: string): string => `https://localhost/_s/raw/${b64url(path)}?t=${Date.now()}`

// "/nas/<id>/a/b" ⇄ id + "a/b"
export function nasParts(p: string): { id: string; rel: string } {
  const rest = p.slice('/nas/'.length)
  const i = rest.indexOf('/')
  return i < 0 ? { id: rest, rel: '' } : { id: rest.slice(0, i), rel: rest.slice(i + 1).replace(/\/+$/, '') }
}
export const nasPath = (id: string, rel: string): string => `/nas/${id}${rel ? '/' + rel.replace(/^\/+/, '') : ''}`
export const joinPath = (a: string, b: string): string => (b ? `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}` : a)

// A file's bytes (phone or NAS).
export async function readBytes(path: string): Promise<ArrayBuffer> {
  const r = await fetch(rawUrl(path))
  if (!r.ok) throw new Error(r.status === 404 ? `ENOENT: ${path}` : `HTTP ${r.status}`)
  return r.arrayBuffer()
}

// A gzip file's text (the 모바일 정보 파일).
export async function readGzipText(path: string): Promise<string> {
  const r = await fetch(rawUrl(path))
  if (!r.ok || !r.body) throw new Error(r.status === 404 ? `ENOENT: ${path}` : `HTTP ${r.status}`)
  const stream = r.body.pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}
