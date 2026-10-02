# @kvoon/pi-voice

Voice dictation for [Pi](https://github.com/earendil-works/pi) with a configurable speech-to-text service.

## Install

**npm**

```bash
pi install npm:@kvoon/pi-voice
```

**GitHub**

```bash
pi install git:github.com/kvoon3/pi-extensions
```

A git source points at the repository, not a subdirectory, so the git install adds every extension this monorepo ships. Select this one with `pi config`, or narrow the entry in `~/.pi/agent/settings.json`:

```json
{
  "source": "git:github.com/kvoon3/pi-extensions",
  "extensions": ["pi-voice/index.ts"]
}
```

Restart Pi to load the extension. The npm install brings `@picovoice/pvrecorder-node` in as a package dependency; with the git install it comes from the repository root's `npm install`, which Pi runs when it installs or updates the package.

## Setup

Save the API key with `/voice-login`, which writes `~/.pi/agent/voice-auth.json` with mode `600`. Only OpenRouter is supported for now; the command verifies the key and reports the remaining credit.

Everything that is not a secret goes in `~/.pi/agent/voice.json` (or the directory set by `PI_CODING_AGENT_DIR`) so the file can be tracked with your dotfiles:

```json
{
  "model": "microsoft/mai-transcribe-2",
  "endpoint": "https://openrouter.ai/api/v1/audio/transcriptions"
}
```

Both fields are optional. The key is taken from `PI_VOICE_API_KEY`, then `OPENROUTER_API_KEY`, then `voice-auth.json`, then a legacy `apiKey` in `voice.json`. `PI_VOICE_MODEL` and `PI_VOICE_ENDPOINT` override the file. Run `/voice-settings` to see the active model, the endpoint host, and where the key came from; keys are never printed.

The endpoint must accept a bearer token and JSON containing `model` and base64 WAV audio in `input_audio`, then return a JSON response with a `text` field. Audio is sent to the configured endpoint for transcription.

## Usage

- Run `/voice-login` to save an OpenRouter API key.
- Press `Alt+Shift+Z` to start recording, then press it again to transcribe and insert the result into the editor.
- Run `/voice-start` to start recording from the command line.
- Run `/voice-cancel` to discard a recording.
- Run `/voice-settings` to show the active transcription configuration.
- The `transcribe_file` tool can transcribe local audio and video files; it requires `ffmpeg` on `PATH`.

On macOS, starting a voice recording mutes system audio output, so it works across apps without browser or player automation permissions. Recording stop, cancellation, or Pi shutdown restores output if it was unmuted before recording. Restore verifies the result and retries; if it still fails, Pi shows a warning so the system is not left muted silently. A marker file records which Pi process muted the output, so a mute left behind by a crashed session is detected and lifted on the next recording. The apps' audio continues playing silently while recording.
