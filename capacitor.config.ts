import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.alterstare.envelope',
  appName: 'Envelope',
  webDir: 'dist',
  android: {
    // Covers, pictures and subtitle files come from https://localhost/_s/… (the
    // native interceptor); audio is read by the player itself. No mixed content.
    allowMixedContent: false
  }
}

export default config
