import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // The macOS-only natives live in optionalDependencies (so a Windows npm install
    // doesn't fail on them); still externalize them so they're never bundled.
    plugins: [externalizeDepsPlugin({ include: ['audiotee', 'screencapturekit-audio-capture'] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
