/**
 * Adapted from mitsuhiko/agent-stuff extensions/notify.ts (Apache-2.0).
 * Changes: kitty OSC 99 and Herdr transports, terminal/retry guards, Unicode-safe truncation.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, stripTerminalSequences } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: () => "",
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: () => "",
  quote: (text) => text,
  quoteBorder: () => "",
  hr: () => "",
  listBullet: () => "",
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

function formatBody(text: string): string {
  const rendered = new Markdown(text, 0, 0, plainMarkdownTheme).render(80).join("\n");
  const normalized = stripTerminalSequences(rendered)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(normalized);
  return characters.length > 200 ? `${characters.slice(0, 199).join("")}…` : normalized;
}

function notify(id: string, body: string): void {
  const title = body ? "π" : "Ready for input";
  // Base64 keeps arbitrary reply text from terminating the outer OSC sequence.
  const metadata = `i=${id}:e=1:a=focus:f=cGk=`;
  const titleSequence = `\x1b]99;${metadata}:p=title:d=0;${Buffer.from(title).toString("base64")}\x1b\\`;
  const bodySequence = `\x1b]99;${metadata}:p=body:d=1;${Buffer.from(body).toString("base64")}\x1b\\`;
  process.stdout.write(titleSequence + bodySequence);
}

export default function (pi: ExtensionAPI): void {
  // Reuse the ID to update this instance's previous notification.
  const id = `pi-${randomUUID()}`;

  pi.on("agent_end", async (event, ctx) => {
    if (ctx.mode !== "tui" || !process.stdout.isTTY) return;
    const isHerdr = process.env.HERDR_ENV === "1";
    const isKitty = process.env.TERM === "xterm-kitty" || Boolean(process.env.KITTY_WINDOW_ID);
    if (!isHerdr && !isKitty) return;

    const assistant = event.messages.filter((message) => message.role === "assistant").at(-1);
    // Pi 0.84 does not expose retry state to extensions. Failed and aborted
    // responses are skipped, including failures that will be retried.
    if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted") return;
    const text = assistant?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
    const body = formatBody(text);
    if (isHerdr) {
      try {
        const result = await pi.exec("herdr", [
          "notification", "show", body ? "π" : "Ready for input", "--body", body,
        ], { timeout: 3000 });
        if (result.code !== 0) {
          ctx.ui.notify("Herdr notification failed.", "warning");
        }
      } catch {
        ctx.ui.notify("Could not send notification through Herdr.", "warning");
      }
      return;
    }
    notify(id, body);
  });
}
