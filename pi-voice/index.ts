import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PvRecorder } from "@picovoice/pvrecorder-node";
import { Type } from "typebox";
import { execFile, spawn } from "node:child_process";
import { appendFile, chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

const DEFAULT_MODEL = "microsoft/mai-transcribe-2";
const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions";
const SAMPLE_RATE = 16_000;
const FRAME_LENGTH = 512;
const SHORTCUT = "alt+shift+z";
const SHORTCUT_LABEL = "Alt+Shift+Z";
const WIDGET = "pi-voice";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "voice.json");
const AUTH_PATH = join(AGENT_DIR, "voice-auth.json");
const LEGACY_CONFIG_PATH = join(AGENT_DIR, "openrouter-voice.json");
/** Shown by `/voice-settings`; the key itself is never printed. */
const AUTH_FILE = AUTH_PATH.slice(AGENT_DIR.length + 1);
const CONFIG_FILE = CONFIG_PATH.slice(AGENT_DIR.length + 1);
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const SCRIPT_TIMEOUT_MS = 5_000;
const RESTORE_ATTEMPTS = 4;
const RESTORE_RETRY_DELAY_MS = 250;
/** Remembers which Pi process muted system output, so a crashed session's mute can be detected and lifted. */
const MUTE_MARKER_PATH = join(AGENT_DIR, "voice-mute.json");
/** Temporary diagnostic trail for the mute/restore lifecycle; remove once the restore issue is solved. */
const DEBUG_LOG_PATH = join(AGENT_DIR, "voice-debug.log");

function voiceLog(message: string): void {
  void (async () => {
    try {
      const line = `${new Date().toISOString()} pid=${process.pid} ${message}\n`;
      const logStat = await stat(DEBUG_LOG_PATH).catch(() => undefined);
      if ((logStat?.size ?? 0) > 262_144) await writeFile(DEBUG_LOG_PATH, line);
      else await appendFile(DEBUG_LOG_PATH, line);
    } catch {
      // Diagnostics must never break the audio paths.
    }
  })();
}
const execFileAsync = promisify(execFile);

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    const startedAt = Date.now();
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SCRIPT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const ms = Date.now() - startedAt;
      if (timedOut) {
        voiceLog(`osascript TIMEOUT (${ms}ms): ${script}`);
        reject(new Error("AppleScript timed out."));
      } else if (code !== 0) {
        const detail = stderr.trim() || `AppleScript exited with status ${code}.`;
        voiceLog(`osascript FAIL (${ms}ms): ${script} -> ${detail}`);
        reject(new Error(detail));
      } else {
        voiceLog(`osascript ok (${ms}ms): ${script} -> ${stdout.trim() || "(empty)"}`);
        resolve(stdout);
      }
    });
  });
}

type VoiceContext = Parameters<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>[0];

type Recording = {
  recorder: PvRecorder;
  frames: Int16Array[];
  apiKey: string;
  model: string;
  endpoint: string;
  systemOutputMutedByUs: boolean;
  stopping: boolean;
  readLoop: Promise<void>;
  error?: unknown;
};

type VoiceConfig = { apiKey?: unknown; model?: unknown; endpoint?: unknown };
/** Where the key in use came from. Environment, `/voice-login`, or a legacy `apiKey` in the config. */
type VoiceKeySource = "PI_VOICE_API_KEY" | "OPENROUTER_API_KEY" | typeof AUTH_FILE | typeof CONFIG_FILE;
type VoiceSettings = { apiKey: string; model: string; endpoint: string; keySource: VoiceKeySource };

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function readConfigFile(path: string): Promise<VoiceConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Settings must contain a JSON object.");
    }
    return parsed as VoiceConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read voice settings from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readVoiceConfig(): Promise<VoiceConfig> {
  return { ...(await readConfigFile(LEGACY_CONFIG_PATH)), ...(await readConfigFile(CONFIG_PATH)) };
}

async function currentEndpoint(): Promise<string> {
  const config = await readVoiceConfig();
  return nonEmptyString(process.env.PI_VOICE_ENDPOINT) ?? nonEmptyString(config.endpoint) ?? DEFAULT_ENDPOINT;
}

/** Resolves the key from the environment, `/voice-login`, or a legacy `apiKey` in the config. */
async function readVoiceSettings(): Promise<VoiceSettings> {
  const config = await readVoiceConfig();
  const stored = await readConfigFile(AUTH_PATH);
  let apiKey = nonEmptyString(process.env.PI_VOICE_API_KEY);
  let keySource: VoiceKeySource = "PI_VOICE_API_KEY";
  if (!apiKey) {
    apiKey = nonEmptyString(process.env.OPENROUTER_API_KEY);
    keySource = "OPENROUTER_API_KEY";
  }
  if (!apiKey) {
    apiKey = nonEmptyString(stored.apiKey);
    keySource = AUTH_FILE;
  }
  if (!apiKey) {
    apiKey = nonEmptyString(config.apiKey);
    keySource = CONFIG_FILE;
  }
  if (!apiKey) {
    throw new Error(`Voice API key is missing. Run /voice-login, set PI_VOICE_API_KEY, or add "apiKey" to ${CONFIG_PATH}.`);
  }

  return {
    apiKey,
    keySource,
    model: nonEmptyString(process.env.PI_VOICE_MODEL) ?? nonEmptyString(config.model) ?? DEFAULT_MODEL,
    endpoint: await currentEndpoint(),
  };
}

/** Rejects a key OpenRouter refuses, and reports the remaining credit when the API provides it. */
async function checkOpenRouterKey(key: string): Promise<{ error?: string; note?: string }> {
  const response = await fetch(OPENROUTER_KEY_URL, { headers: { Authorization: `Bearer ${key}` } }).catch(() => undefined);
  if (!response) return {};
  if (response.status === 401 || response.status === 403) return { error: "OpenRouter rejected that key." };
  const body = await response.json().catch(() => undefined) as { data?: { limit_remaining?: unknown } } | undefined;
  const remaining = body?.data?.limit_remaining;
  return typeof remaining === "number" ? { note: `Remaining credit: $${remaining.toFixed(2)}.` } : {};
}

function wavFromFrames(frames: readonly Int16Array[]): Buffer {
  const sampleCount = frames.reduce((sum, frame) => sum + frame.length, 0);
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 1) {
      wav.writeInt16LE(frame[i] ?? 0, offset);
      offset += 2;
    }
  }
  return wav;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writeMuteMarker(): Promise<void> {
  await writeFile(MUTE_MARKER_PATH, `${JSON.stringify({ pid: process.pid })}\n`).catch(() => undefined);
}

async function clearMuteMarker(): Promise<void> {
  await rm(MUTE_MARKER_PATH, { force: true }).catch(() => undefined);
}

async function readMuteMarkerPid(): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(MUTE_MARKER_PATH, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

async function isSystemOutputMuted(): Promise<boolean> {
  const stdout = await runAppleScript("output muted of (get volume settings)");
  return stdout.trim().toLowerCase() === "true";
}

async function setSystemOutputMuted(muted: boolean): Promise<void> {
  await runAppleScript(`set volume output muted ${muted ? "true" : "false"}`);
}

type SystemMuteResult = { mutedByUs: boolean; failed: boolean };

async function muteSystemOutput(): Promise<SystemMuteResult> {
  const t0 = Date.now();
  if (process.platform !== "darwin") return { mutedByUs: false, failed: false };

  let failed = false;
  let wasMuted = false;
  try {
    wasMuted = await isSystemOutputMuted();
  } catch {
    failed = true;
  }

  const markerPid = await readMuteMarkerPid();
  voiceLog(`mute: begin wasMuted=${wasMuted} marker=${markerPid ?? "none"}`);
  if (markerPid !== undefined) {
    await clearMuteMarker();
    if (markerPid === process.pid) {
      // Our own previous recording failed to restore audio, so the current mute is ours: keep ownership.
      voiceLog(`mute: own leftover marker -> claim ownership without muting (${Date.now() - t0}ms)`);
      return { mutedByUs: true, failed };
    }
    if (!pidAlive(markerPid)) {
      // A previous Pi session died before restoring audio it muted; lift it before recording.
      if (wasMuted) {
        try {
          await setSystemOutputMuted(false);
          wasMuted = false;
          voiceLog("mute: lifted crashed-session leftover mute");
        } catch {
          failed = true;
        }
      }
    }
  }

  if (wasMuted) {
    voiceLog(`mute: was already muted by user -> no ownership (${Date.now() - t0}ms)`);
    return { mutedByUs: false, failed };
  }

  try {
    await setSystemOutputMuted(true);
    await writeMuteMarker();
    voiceLog(`mute: muted + marker written (${Date.now() - t0}ms)`);
    return { mutedByUs: true, failed };
  } catch {
    const mutedByUs = await isSystemOutputMuted().catch(() => false);
    if (mutedByUs) await writeMuteMarker();
    voiceLog(`mute: set-true threw; verify says muted=${mutedByUs} (${Date.now() - t0}ms)`);
    return { mutedByUs, failed: true };
  }
}

/** Unmutes system audio, verifying and retrying; returns false if audio is still muted afterwards. */
async function restoreSystemOutput(mutedByUs: boolean): Promise<boolean> {
  const t0 = Date.now();
  if (process.platform !== "darwin" || !mutedByUs) {
    voiceLog(`restore: skip (platform darwin=${process.platform === "darwin"}, mutedByUs=${mutedByUs})`);
    return true;
  }
  voiceLog("restore: begin");
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt += 1) {
    try {
      const stateBefore = await isSystemOutputMuted();
      if (!stateBefore) {
        await clearMuteMarker();
        voiceLog(`restore: already unmuted -> ok (${Date.now() - t0}ms)`);
        return true;
      }
      await setSystemOutputMuted(false);
      const stateAfter = await isSystemOutputMuted();
      if (!stateAfter) {
        await clearMuteMarker();
        voiceLog(`restore: unmuted + verified (attempt ${attempt}, ${Date.now() - t0}ms)`);
        return true;
      }
      voiceLog(`restore: set-false did not stick (attempt ${attempt})`);
    } catch (error) {
      voiceLog(`restore: attempt ${attempt} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (attempt < RESTORE_ATTEMPTS) await sleep(RESTORE_RETRY_DELAY_MS);
  }
  voiceLog(`restore: ALL ATTEMPTS FAILED, still muted (${Date.now() - t0}ms)`);
  return false;
}
async function transcribe(
  wav: Buffer,
  settings: Pick<VoiceSettings, "apiKey" | "model" | "endpoint">,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(60_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      input_audio: { data: wav.toString("base64"), format: "wav" },
    }),
    signal: requestSignal,
  });

  const body = await response.json().catch(() => ({})) as {
    text?: unknown;
    error?: { message?: unknown };
  };
  if (!response.ok) {
    const detail = typeof body.error?.message === "string" ? body.error.message : response.statusText;
    throw new Error(`Voice transcription failed (${response.status}): ${detail}`);
  }
  if (typeof body.text !== "string") throw new Error("The transcription service returned no transcript.");
  return body.text.trim();
}

function startRecording(settings: VoiceSettings, systemOutputMutedByUs: boolean): Recording {
  const recorder = new PvRecorder(FRAME_LENGTH, -1);
  try {
    if (recorder.sampleRate !== SAMPLE_RATE) {
      throw new Error(`Microphone sample rate ${recorder.sampleRate} Hz is unsupported; expected ${SAMPLE_RATE} Hz.`);
    }
    recorder.start();
    const recording: Recording = {
      recorder,
      frames: [],
      apiKey: settings.apiKey,
      model: settings.model,
      endpoint: settings.endpoint,
      systemOutputMutedByUs,
      stopping: false,
      readLoop: Promise.resolve(),
    };
    recording.readLoop = (async () => {
      try {
        while (!recording.stopping && recorder.isRecording) {
          const frame = await recorder.read();
          if (!recording.stopping) recording.frames.push(frame);
        }
      } catch (error) {
        if (!recording.stopping) recording.error = error;
      }
    })();
    return recording;
  } catch (error) {
    recorder.release();
    throw error;
  }
}

async function stopRecording(recording: Recording, ctx?: VoiceContext): Promise<void> {
  recording.stopping = true;
  voiceLog(`stop: entry frames=${recording.frames.length} mutedByUs=${recording.systemOutputMutedByUs}`);
  // Restore audio before awaiting mic teardown so a slow or hung cleanup cannot leave macOS muted.
  if (!(await restoreSystemOutput(recording.systemOutputMutedByUs))) {
    voiceLog("stop: restore FAILED -> notifying user");
    ctx?.ui.notify("Could not unmute macOS output after recording; please unmute it manually.", "warning");
  }
  try {
    if (recording.recorder.isRecording) recording.recorder.stop();
  } finally {
    await recording.readLoop;
    recording.recorder.release();
  }
  if (recording.error) throw recording.error;
}

export default function piVoice(pi: ExtensionAPI): void {
  let recording: Recording | undefined;
  let operation = false;
  let shuttingDown = false;
  let requestController: AbortController | undefined;

  const clearWidget = (ctx: Parameters<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>[0]) => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
  };

  async function beginRecording(ctx: Parameters<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>[0]): Promise<void> {
    const settings = await readVoiceSettings();
    if (shuttingDown) return;
    voiceLog("begin: recording requested");
    const { mutedByUs, failed } = await muteSystemOutput();
    if (shuttingDown) {
      await restoreSystemOutput(mutedByUs);
      return;
    }
    try {
      recording = startRecording(settings, mutedByUs);
    } catch (error) {
      await restoreSystemOutput(mutedByUs);
      throw error;
    }
    ctx.ui.setWidget(WIDGET, [`Recording · ${SHORTCUT_LABEL} to transcribe`]);
    if (failed) ctx.ui.notify("Could not mute macOS output; system audio may be audible during recording.", "warning");
    voiceLog("begin: recorder started");
  }

  async function toggle(ctx: Parameters<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>[0]): Promise<void> {
    if (shuttingDown || !ctx.hasUI || operation) return;
    operation = true;
    try {
      if (!recording) {
        await beginRecording(ctx);
        return;
      }

      const current = recording;
      recording = undefined;
      clearWidget(ctx);
      await stopRecording(current, ctx);
      if (current.frames.length === 0) {
        ctx.ui.notify("No audio was captured.", "warning");
        return;
      }

      ctx.ui.notify(`Transcribing with ${current.model}…`, "info");
      requestController = new AbortController();
      const transcript = await transcribe(wavFromFrames(current.frames), current, requestController.signal);
      requestController = undefined;
      if (transcript && !shuttingDown) {
        ctx.ui.pasteToEditor(transcript);
        ctx.ui.notify("Transcript inserted.", "info");
      } else if (!shuttingDown) {
        ctx.ui.notify("No speech detected.", "warning");
      }
    } catch (error) {
      requestController = undefined;
      if (!shuttingDown) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      operation = false;
    }
  }

  pi.registerShortcut(SHORTCUT, {
    description: "Record speech and transcribe it with the configured service",
    handler: toggle,
  });

  pi.registerCommand("voice-start", {
    description: "Start voice dictation recording",
    handler: async (_args, ctx) => {
      if (shuttingDown || !ctx.hasUI) return;
      if (recording) {
        ctx.ui.notify("Voice recording is already active.", "info");
        return;
      }
      if (operation) {
        ctx.ui.notify("A voice operation is already in progress.", "warning");
        return;
      }
      operation = true;
      try {
        await beginRecording(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        operation = false;
      }
    },
  });

  const showSettings = async (_args: string, ctx: Parameters<typeof toggle>[0]): Promise<void> => {
    try {
      const settings = await readVoiceSettings();
      const host = hostOf(settings.endpoint);
      ctx.ui.notify(
        `Voice: ${settings.model}${host ? ` → ${host}` : ""} · key from ${settings.keySource} · shortcut ${SHORTCUT_LABEL}`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };
  pi.registerCommand("voice-settings", { description: "Show voice transcription settings", handler: showSettings });
  pi.registerCommand("transcribe", { description: "Show voice transcription settings", handler: showSettings });
  pi.registerCommand("voice-login", {
    description: "Save an OpenRouter API key for voice transcription",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Voice login needs an interactive session.", "error");
        return;
      }
      const key = (await ctx.ui.input("OpenRouter API key", "sk-or-v1-…"))?.trim();
      if (!key) {
        ctx.ui.notify("Voice login cancelled.", "info");
        return;
      }
      const check = hostOf(await currentEndpoint()) === "openrouter.ai" ? await checkOpenRouterKey(key) : {};
      if (check.error) {
        ctx.ui.notify(check.error, "error");
        return;
      }
      await writeFile(AUTH_PATH, `${JSON.stringify({ apiKey: key }, null, 2)}\n`, { mode: 0o600 });
      await chmod(AUTH_PATH, 0o600);
      ctx.ui.notify(`Voice key saved to ${AUTH_PATH}.${check.note ? ` ${check.note}` : ""}`, "info");
    },
  });
  pi.registerCommand("voice-cancel", {
    description: "Discard the current recording",
    handler: async (_args, ctx) => {
      if (operation) {
        ctx.ui.notify("A voice operation is already in progress.", "warning");
        return;
      }
      if (!recording) {
        ctx.ui.notify("There is no active voice recording.", "info");
        return;
      }
      const current = recording;
      recording = undefined;
      operation = true;
      try {
        clearWidget(ctx);
        await stopRecording(current, ctx).catch(() => undefined);
        ctx.ui.notify("Recording discarded.", "info");
      } finally {
        operation = false;
      }
    },
  });

  pi.registerTool({
    name: "transcribe_file",
    label: "Transcribe File",
    description: "Transcribe a local audio or video file with the configured speech-to-text service. Requires ffmpeg on PATH.",
    promptSnippet: "Transcribe a local audio or video file",
    parameters: Type.Object({
      path: Type.String({ description: "Audio or video file path, absolute or relative to the current working directory" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const inputPath = resolve(ctx.cwd, params.path.trim().replace(/^@/, ""));
      const fileStat = await stat(inputPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`Media file not found: ${inputPath}`);
        throw error;
      });
      if (!fileStat.isFile()) throw new Error(`Media path is not a regular file: ${inputPath}`);
      const { stdout } = await execFileAsync("ffmpeg", [
        "-v", "error", "-i", inputPath, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "wav", "pipe:1",
      ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, signal });
      const settings = await readVoiceSettings();
      const text = await transcribe(Buffer.from(stdout), settings, signal);
      return { content: [{ type: "text", text: text || "No speech detected." }], details: undefined };
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    requestController?.abort(new Error("Pi is shutting down"));
    if (recording) {
      await stopRecording(recording, ctx).catch(() => undefined);
      recording = undefined;
    }
    clearWidget(ctx);
  });
}
