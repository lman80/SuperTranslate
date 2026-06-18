# SuperTranslate — How to use it

A live translation overlay. You and your colleague each speak your own language;
the window shows both the original and the translation, both directions.

## One-time setup (about 5 minutes)

You need two free keys. Both are pay-as-you-go and cost pennies — see "Cost" below.

### 1. Speech key (Soniox) — the "ears"
1. Go to **https://console.soniox.com** and sign up.
2. Create an API key and copy it.

### 2. Translation key (DeepSeek) — the "brain"
1. Go to **https://platform.deepseek.com/api_keys** and sign up.
2. Create an API key and copy it.
   - (Alternative: Qwen, at https://bailian.console.alibabacloud.com — you can switch
     the engine in Settings.)

### 3. Put the keys in the app
1. Open **SuperTranslate**.
2. The Settings panel opens automatically. Paste the Soniox key and the DeepSeek key.
3. Choose **You speak** (e.g. English) and **They speak** (e.g. Korean or Chinese).
4. Click **Save**.

## Using it
- Click **Start**.
- The first time, macOS will ask for **Microphone** and **Screen & System Audio
  Recording** permission — click Allow. (System Audio is how it hears the other person
  on a Zoom/Teams/etc. call. You may need to restart the app once after granting it.)
- Just talk. Your words and your colleague's words appear in both languages.
- Drag the window anywhere; it floats on top of your call. Click **Stop** when done.

## Cost (pay-as-you-go, you only pay for what you use)
- Speech (Soniox): about **$0.12 per hour** of conversation, per voice.
- Translation (DeepSeek/Qwen): **fractions of a cent** — effectively free for talking.
- Typical light use is a few dollars a month. Heavy daily use, maybe $10–40/month.

## If something doesn't work
- **No translations?** Check the DeepSeek key in Settings.
- **Can't hear the other person?** System Settings → Privacy & Security → Screen & System
  Audio Recording → enable SuperTranslate, then restart the app.
- **Nothing happens on Start?** Make sure the Soniox key is pasted in Settings.
