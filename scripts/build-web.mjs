#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzip, brotliCompress, constants } from "node:zlib";
import { build } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(repo, "dist", "web");
await fs.rm(path.join(repo, "dist/.frontend-built"), { force: true });
await build({ configFile: path.join(repo, "frontend", "vite.config.js") });
const renderDir = path.join(repo, "dist", ".prerender");
try {
  await build({
    configFile: path.join(repo, "frontend", "vite.config.js"),
    logLevel: "warn",
    build: {
      ssr: path.join(repo, "frontend", "src", "prerender.jsx"),
      outDir: renderDir,
      emptyOutDir: true,
      copyPublicDir: false,
      rollupOptions: { output: { entryFileNames: "prerender.mjs" } },
    },
  });
  const { render } = await import(pathToFileURL(path.join(renderDir, "prerender.mjs")).href);
  const html = await fs.readFile(path.join(target, "index.html"), "utf8");
  for (const [file, route] of [
    ["index.html", "/"],
    ["workspace.html", "/workspace"],
    ["console.html", "/workspace/controls"],
  ]) {
    await fs.writeFile(
      path.join(target, file),
      html
        .replace('<div id="root"></div>', () => `<div id="root">${render(route)}</div>`)
        .replace(
          "<title>ASH — Intelligence that executes</title>",
          route !== "/" ? "<title>Ash · Workspace</title>" : "<title>ASH — Intelligence that executes</title>",
        ),
    );
  }
} finally {
  await fs.rm(renderDir, { recursive: true, force: true });
}
// Existing controls assets and compatibility URLs remain available.
for (const file of ["app.js", "styles.css"]) await fs.copyFile(path.join(repo, "web", file), path.join(target, file));
const zip = promisify(gzip),
  brotli = promisify(brotliCompress);
async function compress(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await compress(file);
      continue;
    }
    if (!/\.(?:html|css|js|svg)$/.test(file)) continue;
    const body = await fs.readFile(file);
    if (body.length < 512) continue;
    const [gz, br] = await Promise.all([zip(body), brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })]);
    await fs.writeFile(`${file}.gz`, gz);
    await fs.writeFile(`${file}.br`, br);
  }
}
await compress(target);
await fs.writeFile(path.join(repo, "dist/.frontend-built"), "built\n");
console.log("Ash frontend built: dist/web. Remote controls preserved at /console.");
