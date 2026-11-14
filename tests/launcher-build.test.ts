import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { tempDir, cleanup } from "./helpers.js";

test("npm launcher retries failed builds and notices build configuration changes", async () => {
  const dir = await tempDir("ash build test ");
  try {
    for (const sub of ["scripts", "src", "web", "frontend", "dist", "node_modules/typescript/bin"])
      await fs.mkdir(path.join(dir, sub), { recursive: true });
    for (const script of ["ash.mjs", "build-server.mjs"])
      await fs.copyFile(path.join("scripts", script), path.join(dir, "scripts", script));
    await fs.writeFile(
      path.join(dir, "scripts", "build-web.mjs"),
      `import { promises as fs } from 'node:fs'; await fs.mkdir('dist/web', { recursive: true }); await fs.copyFile('web/index.html', 'dist/web/index.html');`,
    );
    await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(dir, "tsconfig.json"), "{}");
    await fs.writeFile(path.join(dir, "src", "index.ts"), "export {};");
    await fs.writeFile(path.join(dir, "web", "index.html"), "test");
    // Deliberately leave an emitted entry on failure to reproduce the old timestamp shortcut.
    await fs.writeFile(
      path.join(dir, "node_modules/typescript/bin/tsc"),
      `
const fs = require('node:fs');
fs.writeFileSync('dist/index.js', 'console.log("LAUNCHED")');
if (!fs.existsSync('compiler-ok')) process.exit(1);
`,
    );
    const launch = () =>
      spawnSync(process.execPath, [path.join(dir, "scripts", "ash.mjs"), "status"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 20_000,
      });
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = launch();
      assert.equal(failed.status, 1, failed.stderr);
      assert.doesNotMatch(failed.stdout, /LAUNCHED/);
      assert.match(failed.stderr, /Building Ash backend/);
    }
    await fs.writeFile(path.join(dir, "compiler-ok"), "yes");
    const built = launch();
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stdout, /LAUNCHED/);
    const cached = launch();
    assert.equal(cached.status, 0, cached.stderr);
    assert.doesNotMatch(cached.stderr, /Building Ash backend/);
    const stamp = await fs.stat(path.join(dir, "dist", ".server-built"));
    const changedAt = new Date(stamp.mtimeMs + 1);
    await fs.utimes(path.join(dir, "tsconfig.json"), changedAt, changedAt);
    const rebuilt = launch();
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.match(rebuilt.stderr, /Building Ash backend/);
  } finally {
    await cleanup(dir);
  }
});
