import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

function notify(title: string, body: string) {
  const script = `display notification "${body}" with title "${title}" sound name "Purr"`;
  execSync(`osascript -e '${script}'`, { timeout: 3000 });
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event) => {
    const msgs = event.messages;
    const turns = msgs.filter((m) => m.role === "assistant").length;
    const tools = msgs.filter((m) => m.role === "toolResult").length;
    const errors = msgs.filter((m) => m.role === "toolResult" && m.isError).length;

    const firstTs = msgs[0]?.timestamp;
    const lastAssistant = msgs.filter((m) => m.role === "assistant").at(-1);
    const lastTs = lastAssistant?.timestamp ?? msgs.at(-1)?.timestamp;
    const duration = firstTs && lastTs ? lastTs - firstTs : undefined;

    const totalTokens = msgs
      .filter((m) => m.role === "assistant")
      .reduce((sum, m) => sum + (m.usage?.totalTokens ?? 0), 0);

    const totalCost = msgs
      .filter((m) => m.role === "assistant")
      .reduce((sum, m) => sum + (m.usage?.cost?.total ?? 0), 0);

    const parts: string[] = [];
    parts.push(`${turns} turn${turns !== 1 ? "s" : ""}`);
    if (tools > 0) parts.push(`${tools} tool${tools !== 1 ? "s" : ""}`);
    if (errors > 0) parts.push(`${errors} error${errors !== 1 ? "s" : ""}`);
    parts.push(totalTokens > 0 ? `${Math.round(totalTokens / 1000)}k tokens` : "");
    if (totalCost > 0) parts.push(`$${totalCost.toFixed(4)}`);
    if (duration) parts.push(fmtDuration(duration));

    const summary = parts.filter(Boolean).join(" · ");

    if (errors > 0) {
      notify("Pi", `⚠️ ${summary}`);
    } else {
      notify("Pi", `${summary} ✓`);
    }
  });
}
