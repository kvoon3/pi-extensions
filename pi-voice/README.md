# @kvoon/pi-voice

Voice dictation for [Pi](https://github.com/earendil-works/pi) with a configurable speech-to-text service.

## Setup

Create `~/.pi/agent/voice.json` (or place it in the directory set by `PI_CODING_AGENT_DIR`):

```json
{
  "apiKey": "YOUR_API_KEY",
  "model": "provider/model-id",
  "endpoint": "https://api.example.com/v1/audio/transcriptions"
}
```

Restrict the file to your account:

```bash
chmod 600 ~/.pi/agent/voice.json
```

The `model` and `endpoint` fields are optional. You can also set `PI_VOICE_API_KEY`, `PI_VOICE_MODEL`, and `PI_VOICE_ENDPOINT` in the environment; environment values override the file. If omitted, the extension uses its built-in defaults.

The endpoint must accept a bearer token and JSON containing `model` and base64 WAV audio in `input_audio`, then return a JSON response with a `text` field. Audio is sent to the configured endpoint for transcription.

Install the package dependencies and add the extension to Pi:

```bash
cd ~/i/pi-extensions/pi-voice
npm install
pi install ~/i/pi-extensions/pi-voice
```

Restart Pi to load the extension.

## Usage

- Press `Alt+Shift+Z` to start recording, then press it again to transcribe and insert the result into the editor.
- Run `/voice-start` to start recording from the command line.
- Run `/voice-cancel` to discard a recording.
- Run `/voice-settings` to show the active transcription configuration.
- The `transcribe_file` tool can transcribe local audio and video files; it requires `ffmpeg` on `PATH`.

On macOS, starting a voice recording mutes system audio output, so it works across apps without browser or player automation permissions. Recording stop, cancellation, or Pi shutdown restores output if it was unmuted before recording. The apps' audio continues playing silently while recording.
