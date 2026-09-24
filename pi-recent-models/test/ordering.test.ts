import { test, assert } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(pathToFileURL(resolve(pkgRoot, "index.ts")).href) as {
  __internals: {
    buildItems: (models: any[], history: { provider: string; id: string }[]) => any[];
    itemSearchText: (item: any) => string;
    removeEntry: (
      entries: { provider: string; id: string }[],
      provider: string,
      id: string,
    ) => { provider: string; id: string }[];
  };
};

const m = (provider: string, id: string, name = id) => ({ provider, id, name });

test("buildItems: recent first in history order, then rest alphabetical", () => {
  const models = [m("a", "1"), m("b", "2"), m("c", "3"), m("d", "4")];
  const history = [
    { provider: "c", id: "3" },
    { provider: "a", id: "1" },
  ];
  const items = mod.__internals.buildItems(models, history);
  assert.deepEqual(
    items.map((i) => i.model.provider),
    ["c", "a", "b", "d"],
  );
  assert.deepEqual(
    items.map((i) => i.recent),
    [true, true, false, false],
  );
});

test("buildItems: history entries missing from catalogue are ignored", () => {
  const models = [m("a", "1")];
  const history = [{ provider: "gone", id: "x" }];
  const items = mod.__internals.buildItems(models, history);
  assert.equal(items.length, 1);
  assert.equal(items[0].recent, false);
});

test("removeEntry: drops only the exact provider/id pair, order preserved", () => {
  const history = [
    { provider: "a", id: "1" },
    { provider: "b", id: "2" },
    { provider: "a", id: "1" },
  ];
  assert.deepEqual(mod.__internals.removeEntry(history, "a", "1"), [{ provider: "b", id: "2" }]);
  assert.deepEqual(mod.__internals.removeEntry(history, "a", "2"), history);
});

test("itemSearchText includes provider, id and name for fuzzy matching", () => {
  const text = mod.__internals.itemSearchText({ model: m("workbuddy", "glm-5.3", "GLM 5.3") });
  assert.ok(text.includes("workbuddy"));
  assert.ok(text.includes("glm-5.3"));
  assert.ok(text.includes("GLM 5.3"));
});
