# SuperTranslate

A beautiful, simple **live speech-translation overlay** for **macOS and Windows**. You and the
other person each speak your own language; a floating window shows **both the original transcript
and the translation**, in real time, both directions — Korean · Chinese · English.

- 🎙️ Captures your **microphone** and the **other person's voice** from any call (Zoom, Teams, Meet, …)
- ⚡ **Streaming** transcription (Soniox) + translation (DeepSeek / Qwen / OpenRouter)
- 🔊 Optional **speak-aloud** dubbing — free built-in voices, or premium **ElevenLabs** HD voices
- 💸 Built-in **monthly spending cap** + live cost meter, so you never get a surprise bill
- 🪟 Frameless, always-on-top overlay that floats over your call

---

## Download & install

Grab the latest installer from the [**Releases**](../../releases/latest) page:

- **Windows:** `SuperTranslate-<version>-setup.exe`
- **macOS (Apple Silicon):** `SuperTranslate-<version>.dmg`

> The app isn't code-signed yet, so the OS will warn the first time:
> - **Windows:** SmartScreen → click **More info → Run anyway**.
> - **macOS:** right-click the app → **Open → Open**.

## Setup (≈5 minutes, one time)

You bring your own API keys (pay-as-you-go, pennies — see [Cost](#cost)):

1. **Speech (required):** [Soniox](https://console.soniox.com) → create an API key.
2. **Translation (required):** [DeepSeek](https://platform.deepseek.com/api_keys) → create an API key.
   *(Or pick Qwen / OpenRouter in Settings — both are prepaid.)*
3. **HD voice (optional):** [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) → API key.

Open SuperTranslate → the **Settings** panel opens → paste your keys → choose the two languages →
**Save** → **Start**. Grant the microphone (and, for calls, "Screen & System Audio Recording")
permission when asked.

## 🇨🇳 Using it from mainland China

Translation via **DeepSeek** works directly. But **Soniox** (speech) and **ElevenLabs** (voice) are
US services that may be **blocked or slow behind the Great Firewall** — you'll likely need a **VPN**
for those, or substitute a China-accessible provider. The built-in (free) voice works offline.

## Cost

- **Speech (Soniox):** ~**$0.12 / hour** of conversation, per voice.
- **Translation (DeepSeek):** fractions of a cent — effectively free.
- **HD voice (ElevenLabs):** ~**$0.10 / 1,000 characters** (optional; the free voice is $0).

Set a hard monthly cap in **Settings → Monthly spending limit**; the app stops automatically when
it's reached. DeepSeek, Qwen, and OpenRouter are **prepaid** (they can't bill beyond what you load).

---

## Build from source (developers)

Requires Node.js 22+.

```bash
npm install
npm run dev          # run in development
npm run build        # type-check + bundle
npm run pack:mac     # package a macOS app   → dist/
npm run pack:win     # package a Windows app → dist/
```

Stack: Electron + Vite + React + TypeScript. The main process owns all network calls and API keys;
the renderer only captures audio and renders the UI.

## License

[MIT](LICENSE)
