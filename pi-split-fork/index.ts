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
    ...ctx.sessionManager.getBranch().map((entry) => JSON.stringify(entry)),
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

type ForkTarget = "right" | "down" | "tab" | "workspace";

async function createTargetPane(
  pi: ExtensionAPI,
  target: ForkTarget,
  cwd: string,
): Promise<{ paneId?: string; error?: string }> {
  if (target === "tab" || target === "workspace") {
    const sub = target === "tab" ? "tab" : "workspace";
    const result = await pi.exec("herdr", [
      sub, "create", "--cwd", cwd, "--focus",
    ]);
    if (result.code !== 0) return { error: errorText(result) };
    try {
      const paneId = JSON.parse(result.stdout).result?.root_pane?.pane_id;
      if (paneId) return { paneId };
      return { error: `Herdr created a ${sub} but returned no root pane ID.` };
    } catch {
      return { error: `Herdr created a ${sub} but returned unparseable output.` };
    }
  }

  const result = await pi.exec("herdr", [
    "pane", "split", "--current", "--direction", target, "--cwd", cwd, "--focus",
  ]);
  if (result.code !== 0) return { error: errorText(result) };
  try {
    const paneId = JSON.parse(result.stdout).result?.pane?.pane_id;
    if (paneId) return { paneId };
    return { error: "Herdr created a pane but returned no pane ID." };
  } catch {
    return { error: "Herdr created a pane but returned unparseable output." };
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("split-fork", {
    description: "Fork this session into a new Pi agent in a Herdr pane, tab, or workspace. Usage: /split-fork [right|down|tab|workspace] [optional prompt]",
    getArgumentCompletions: (prefix) => {
      if (prefix.includes(" ")) return null;
      const targets = [
        { value: "right", label: "right", description: "Split beside the current pane" },
        { value: "down", label: "down", description: "Split below the current pane" },
        { value: "tab", label: "tab", description: "Create a new Herdr tab" },
        { value: "workspace", label: "workspace", description: "Create a new Herdr workspace" },
      ].filter(({ value }) => value.startsWith(prefix));
      return targets.length > 0 ? targets : null;
    },
    handler: async (args, ctx) => {
      const wasBusy = !ctx.isIdle();
      const input = args.trim();
      const [first, ...rest] = input.split(/\s+/);
      const hasTarget = first === "right" || first === "down" || first === "tab" || first === "workspace";
      const target: ForkTarget = hasTarget ? (first as ForkTarget) : "right";
      const prompt = hasTarget ? rest.join(" ") : input;
      const forkFile = await createForkedSession(ctx);

      const { paneId, error } = await createTargetPane(pi, target, ctx.cwd);
      if (error || !paneId) {
        const what = target === "workspace" ? "workspace" : target === "tab" ? "tab" : "pane";
        ctx.ui.notify(`Failed to create Herdr ${what}: ${error ?? "no pane ID"}`, "error");
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

      const where = target === "workspace" ? `workspace (pane ${paneId})` : target === "tab" ? `tab (pane ${paneId})` : `pane ${paneId}`;
      ctx.ui.notify(`Forked into Herdr ${where}${prompt ? " and sent prompt" : ""}.`, "info");
      if (wasBusy) {
        ctx.ui.notify("The fork contains committed entries only; the original in-flight turn continues.", "info");
      }
    },
  });
}
