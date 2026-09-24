/**
 * Recent-models selector for pi.
 *
 * The built-in /model selector sorts by current → default → provider.
 * This extension adds a recency-first selector:
 *
 *   - ctrl+l opens it (replaces the built-in /model selector)
 *   - /model-recent opens it too
 *   - ↑↓ navigate, type to fuzzy-filter, enter to switch, esc to cancel
 *   - ctrl+d removes the highlighted model from the recent list
 *
 * ctrl+l is intercepted by replacing the editor component with a CustomEditor
 * subclass — app.model.select is a reserved keybinding that extension
 * shortcuts cannot override, but a custom editor sees raw input first.
 *
 * History is recorded from model_select events (set | cycle | restore)
 * into ~/.pi/agent/recent-models.json, capped at 50 entries, most recent first.
 * The selector lists recent models first (that still exist and are available),
 * then the rest of the catalogue by provider/id.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HISTORY_FILE = "recent-models.json";
const HISTORY_CAP = 50;
const MAX_VISIBLE = 10;

interface HistoryEntry {
  provider: string;
  id: string;
}

function historyPath(): string {
  return join(getAgentDir(), HISTORY_FILE);
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = JSON.parse(readFileSync(historyPath(), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is HistoryEntry =>
        typeof e?.provider === "string" && typeof e?.id === "string",
    );
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  try {
    writeFileSync(historyPath(), JSON.stringify(entries, null, 2) + "\n", "utf8");
  } catch {
    // best effort — losing history is fine
  }
}

function removeEntry(entries: HistoryEntry[], provider: string, id: string): HistoryEntry[] {
  return entries.filter((e) => !(e.provider === provider && e.id === id));
}

function recordUse(provider: string, id: string): void {
  const rest = removeEntry(loadHistory(), provider, id);
  saveHistory([{ provider, id }, ...rest].slice(0, HISTORY_CAP));
}

function forgetUse(provider: string, id: string): void {
  saveHistory(removeEntry(loadHistory(), provider, id));
}

interface ModelItem {
  model: Model<any>;
  recent: boolean;
}

function buildItems(models: readonly Model<any>[], history: HistoryEntry[]): ModelItem[] {
  const rank = new Map<string, number>();
  history.forEach((e, i) => rank.set(`${e.provider}\0${e.id}`, i));
  const items: ModelItem[] = models.map((model) => ({
    model,
    recent: rank.has(`${model.provider}\0${model.id}`),
  }));
  items.sort((a, b) => {
    const ra = rank.get(`${a.model.provider}\0${a.model.id}`) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(`${b.model.provider}\0${b.model.id}`) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb; // most recently used first
    return `${a.model.provider}/${a.model.id}`.localeCompare(`${b.model.provider}/${b.model.id}`);
  });
  return items;
}

function itemSearchText(item: ModelItem): string {
  const { id, provider, name } = item.model;
  return `${provider} ${provider}/${id} ${id} ${name ?? ""}`;
}

interface ThemeLike {
  fg(color: string, text: string): string;
}

/**
 * Searchable model list ordered most-recently-used first.
 * Mirrors the built-in ModelSelectorComponent's input routing, but sorts by
 * recency and marks the recent/other boundary.
 */
class RecentModelSelector extends Container {
  private readonly models: readonly Model<any>[];
  private items: ModelItem[];
  private filtered: ModelItem[];
  private notice: string | undefined;
  private selectedIndex = 0;
  private readonly currentModel: Model<any> | undefined;
  private readonly searchInput: Input;
  private readonly listContainer = new Container();
  private readonly onPick: (model: Model<any>) => void;
  private readonly onClose: () => void;
  private readonly theme: ThemeLike;
  private readonly tui: { requestRender(): void };

  _focused = false;
  get focused() {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    tui: { requestRender(): void },
    theme: ThemeLike,
    models: readonly Model<any>[],
    currentModel: Model<any> | undefined,
    onPick: (model: Model<any>) => void,
    onClose: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.models = models;
    this.items = buildItems(models, loadHistory());
    this.filtered = this.items;
    this.currentModel = currentModel;
    this.onPick = onPick;
    this.onClose = onClose;

    this.addChild(
      new Text(theme.fg("dim", "  Models sorted by recent use · /model for the built-in order"), 0, 0),
    );
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => {
      const item = this.filtered[this.selectedIndex];
      if (item) this.pick(item);
    };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(theme.fg("dim", "  ↑↓ navigate · enter select · ctrl+d remove recent · esc cancel"), 0, 0),
    );

    this.updateList();
  }

  private pick(item: ModelItem): void {
    this.onPick(item.model);
  }

  private updateList(): void {
    const theme = this.theme;
    this.listContainer.clear();
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filtered.length - MAX_VISIBLE),
    );
    const end = Math.min(start + MAX_VISIBLE, this.filtered.length);

    let lastRecent: boolean | undefined;
    for (let i = start; i < end; i++) {
      const item = this.filtered[i];
      if (!item) continue;
      if (item.recent !== lastRecent) {
        lastRecent = item.recent;
        const label = item.recent ? "── recent ──" : "── other ──";
        this.listContainer.addChild(new Text(theme.fg("muted", `  ${label}`), 0, 0));
      }
      const selected = i === this.selectedIndex;
      const isCurrent =
        this.currentModel &&
        this.currentModel.provider === item.model.provider &&
        this.currentModel.id === item.model.id;
      const cursor = selected ? theme.fg("accent", "→ ") : "  ";
      const currentMarker = isCurrent ? theme.fg("accent", "✓ ") : "  ";
      const modelText = selected ? theme.fg("accent", item.model.id) : item.model.id;
      const providerBadge = theme.fg("muted", `[${item.model.provider}]`);
      this.listContainer.addChild(
        new Text(`${cursor}${currentMarker}${modelText} ${providerBadge}`, 0, 0),
      );
    }

    if (start > 0 || end < this.filtered.length) {
      this.listContainer.addChild(
        new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0),
      );
    }
    if (this.filtered.length === 0) {
      this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
    } else {
      const selected = this.filtered[this.selectedIndex];
      this.listContainer.addChild(
        new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0),
      );
    }
    if (this.notice) {
      this.listContainer.addChild(new Text(theme.fg("warning", `  ${this.notice}`), 0, 0));
    }
  }

  /** Drop the highlighted model from recent history; it stays under `── other ──`. */
  private forgetSelected(): void {
    const item = this.filtered[this.selectedIndex];
    if (!item) return;
    if (!item.recent) {
      this.notice = `${item.model.id} is not in recent history`;
    } else {
      forgetUse(item.model.provider, item.model.id);
      this.items = buildItems(this.models, loadHistory());
      this.filtered = fuzzyFilter(this.items, this.searchInput.getValue(), itemSearchText);
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
      this.notice = `Removed ${item.model.id} from recent`;
    }
    this.updateList();
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.up")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
      this.updateList();
    } else if (kb.matches(keyData, "tui.select.down")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      const item = this.filtered[this.selectedIndex];
      if (item) this.pick(item);
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      this.onClose();
    } else if (matchesKey(keyData, Key.ctrl("d"))) {
      this.forgetSelected();
    } else {
      this.searchInput.handleInput(keyData);
      const query = this.searchInput.getValue();
      this.filtered = fuzzyFilter(this.items, query, itemSearchText);
      this.selectedIndex = 0;
      this.notice = undefined;
      this.updateList();
    }
  }
}

/**
 * Editor subclass that swallows ctrl+l before the app keybinding pipeline
 * can route it to the built-in /model selector. Everything else falls through
 * unchanged (super keeps autocomplete, app actions, etc.).
 */
class RecentModelEditor extends CustomEditor {
  onOpenRecentModels: (() => void) | undefined;

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (!this.isShowingAutocomplete() && kb.matches(data, "app.model.select")) {
      this.onOpenRecentModels?.();
      return;
    }
    super.handleInput(data);
  }
}

/** Exported for tests. */
export const __internals = { buildItems, itemSearchText, removeEntry, HISTORY_CAP };

export default function (pi: ExtensionAPI): void {
  pi.on("model_select", (event) => {
    recordUse(event.model.provider, event.model.id);
  });

  const openSelector = async (ctx: Pick<ExtensionCommandContext, "mode" | "hasUI" | "ui" | "scopedModels" | "modelRegistry" | "model">): Promise<void> => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    const models =
      ctx.scopedModels.length > 0
        ? ctx.scopedModels.map((s) => s.model)
        : ctx.modelRegistry.getAvailable();
    if (models.length === 0) {
      ctx.ui.notify("No models available. Use /login to add providers.", "warning");
      return;
    }

    const picked = await ctx.ui.custom<Model<any> | null>((tui, theme, _keybindings, done) => {
      return new RecentModelSelector(
        tui,
        theme,
        models,
        ctx.model,
        (model) => done(model),
        () => done(null),
      );
    });

    if (picked) {
      const ok = await pi.setModel(picked);
      if (!ok) ctx.ui.notify(`No API key for ${picked.provider}/${picked.id}`, "error");
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new RecentModelEditor(tui, theme, keybindings);
      editor.onOpenRecentModels = () => void openSelector(ctx);
      return editor;
    });
  });

  pi.registerCommand("model-recent", {
    description: "Select a model, recently-used first",
    handler: async (_args, ctx) => openSelector(ctx),
  });
}
