import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

async function createForkedSession(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return undefined;

  const timestamp = new Date().toISOString();
  const id = randomUUID();
  const header = ctx.sessionManager.getHeader();
  const forkFile = path.join(
    path.dirname(sessionFile),
    `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`,
  );
  const lines = [
    JSON.stringify({
      type: "session",
      version: header?.version ?? 3,
      id,
      timestamp,
      cwd: header?.cwd ?? ctx.cwd,
      parentSession: sessionFile,
    }),
    ...ctx.sessionManager.getBranch().map(JSON.stringify),
  ].join("\n") + "\n";

  await fs.writeFile(forkFile, lines, "utf8");
  return forkFile;
}

function errorText(result: { stderr?: string; stdout?: string }): string {
  return result.stderr?.trim() || result.stdout?.trim() || "unknown error";
}

async function startPiAgent(
  pi: ExtensionAPI,
  agentName: string,
  paneId: string,
  forkFile: string | undefined,
) {
  const args = ["agent", "start", agentName, "--kind", "pi", "--pane", paneId];
  if (forkFile) args.push("--", "--session", forkFile);

  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await pi.exec("herdr", args);
    if (result.code === 0 || !errorText(result).includes("agent_pane_busy")) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return pi.exec("herdr", args);
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("split-fork", {
    description: "Fork this session into a new Pi agent in a Herdr pane. Usage: /split-fork [right|down] [optional prompt]",
    handler: async (args, ctx) => {
      const wasBusy = !ctx.isIdle();
      const input = args.trim();
      const [first, ...rest] = input.split(/\s+/);
      const hasDirection = first === "right" || first === "down";
      const direction = first === "down" ? "down" : "right";
      const prompt = hasDirection ? rest.join(" ") : input;
      const forkFile = await createForkedSession(ctx);

      const split = await pi.exec("herdr", [
        "pane", "split", "--current", "--direction", direction, "--cwd", ctx.cwd, "--focus",
      ]);
      if (split.code !== 0) {
        ctx.ui.notify(`Failed to create Herdr pane: ${errorText(split)}`, "error");
        return;
      }

      let paneId: string | undefined;
      try {
        paneId = JSON.parse(split.stdout).result?.pane?.pane_id;
      } catch {}
      if (!paneId) {
        ctx.ui.notify("Herdr created a pane but returned no pane ID.", "error");
        return;
      }

      const agentName = `fork-${randomUUID().slice(0, 8)}`;
      const started = await startPiAgent(pi, agentName, paneId, forkFile);
      if (started.code !== 0) {
        ctx.ui.notify(`Herdr pane ${paneId} opened, but Pi failed to start: ${errorText(started)}`, "error");
        return;
      }

      if (prompt) {
        const sent = await pi.exec("herdr", ["agent", "prompt", agentName, prompt]);
        if (sent.code !== 0) {
          ctx.ui.notify(`Fork started, but the prompt was not sent: ${errorText(sent)}`, "warning");
          return;
        }
      }

      ctx.ui.notify(`Forked into Herdr pane ${paneId}${prompt ? " and sent prompt" : ""}.`, "info");
      if (wasBusy) {
        ctx.ui.notify("The fork contains committed entries only; the original in-flight turn continues.", "info");
      }
    },
  });
}
