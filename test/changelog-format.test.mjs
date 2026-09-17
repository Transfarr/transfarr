import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("changelog has the package version and documented changes", () => {
  const content = readFileSync(
    new URL("../CHANGELOG.md", import.meta.url),
    "utf8",
  );
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url)),
  );
  assert.ok(content.includes(`# v${pkg.version}`));
  assert.ok(content.startsWith("# Next\n\n* "));
  for (const line of content.split("\n").filter(Boolean))
    assert.match(
      line,
      /^(# (Next|v\d+\.\d+\.\d+)|\* (Added|Fixed|Changed|Removed) .+)$/,
    );
});
