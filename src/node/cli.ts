#!/usr/bin/env node
// marginalia: build, check, preview and deploy a notes website.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkMath } from "./checkmath.js";
import { loadConfig } from "./config.js";
import { build, buildPdfsOnly } from "./site.js";

const HELP = `marginalia <command> [options]

Commands:
  build     build the website (PDFs of LaTeX books, pages, search index)
  pdf       only compile the LaTeX books' PDFs
  check     strict build + check every formula renders (what CI should run)
  serve     preview the built site (default http://localhost:8000)
  login     log in to Cloudflare in the browser (once per computer)
  deploy    build, then upload to Cloudflare Pages
  upload    upload the already built site
  init      write a starter marginalia.toml

Options:
  --root DIR      project folder with marginalia.toml (default: .)
  --only NAME     only this collection (code, slug or folder; repeatable; not for deploy)
  --no-pdf        skip compiling LaTeX PDFs (reuse the last ones)
  --force         rebuild every PDF, changed or not
  --strict        fail on any warning
  --port N        port for serve (default 8000)
`;

const WRANGLER = ["-y", "wrangler@4.20.0"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".wasm": "application/wasm", ".map": "application/json",
};

function npx(args: string[]): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, { stdio: "inherit" });
    child.on("close", (code) => done(code ?? 1));
  });
}

async function upload(out: string, project: string): Promise<number> {
  if (!existsSync(join(out, "index.html"))) {
    console.error(`No site in ${out}: run marginalia build (or deploy) first.`);
    return 1;
  }
  // Creating the project fails harmlessly when it already exists.
  await new Promise((done) => spawn(process.platform === "win32" ? "npx.cmd" : "npx",
    [...WRANGLER, "pages", "project", "create", project, "--production-branch=main"], { stdio: "ignore" }).on("close", done));
  return npx([...WRANGLER, "pages", "deploy", out, `--project-name=${project}`, "--branch=main", "--commit-dirty=true"]);
}

function serve(dir: string, port: number) {
  createServer((req, res) => {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(dir, path));
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  }).listen(port, () => console.log(`Serving ${dir} on http://localhost:${port}`));
}

const STARTER = `# Marginalia configuration. Every key is optional.
title = "My Notes"
description = "Notes I took, as one searchable website."
label = "Notes"            # what the collections are called in the menu
# repo = "https://github.com/you/your-notes"   # GitHub link and per-collection source buttons
# storage = "my-notes"     # browser storage prefix for highlights, typed notes and handwriting

# Each subfolder of a group's path is one collection: a LaTeX book (main.tex),
# Markdown files and/or PDFs. Without any [[group]] or [[collection]], top-level
# folders are found automatically.
# [[group]]
# name = "Mathematics"
# path = "Mathematics"

# [[collection]]
# path = "Misc/Reading list"
# group = "Other"

# [latex]
# preamble = "common/preamble.tex"     # shared preamble the books \\input
# web_macros = "website/web-macros.tex"  # extra definitions used only on the website

[deploy]
cloudflare_project = "my-notes"
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string", default: "." },
      only: { type: "string", multiple: true },
      "no-pdf": { type: "boolean" },
      force: { type: "boolean" },
      strict: { type: "boolean" },
      port: { type: "string", default: "8000" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (!command || values.help) {
    console.log(HELP);
    return command ? 0 : 1;
  }
  if (command === "init") {
    const file = resolve(values.root ?? ".", "marginalia.toml");
    if (existsSync(file)) { console.error(`${file} already exists`); return 1; }
    writeFileSync(file, STARTER);
    console.log(`Wrote ${file}`);
    return 0;
  }
  const config = loadConfig(values.root);
  const opts = { pdf: !values["no-pdf"], force: values.force, strict: values.strict, only: values.only };
  const project = config.deploy.cloudflareProject;

  switch (command) {
    case "build": {
      const { warnings, failedPdfs } = await build(config, opts);
      if (failedPdfs) { console.error(`${failedPdfs} PDF(s) failed`); return 1; }
      if (opts.strict && warnings.length) { console.error(`${warnings.length} warning(s); failing because of --strict`); return 1; }
      return 0;
    }
    case "pdf": {
      const failed = await buildPdfsOnly(config, opts);
      if (failed) console.error(`${failed} PDF(s) failed`);
      return failed ? 1 : 0;
    }
    case "check": {
      const { warnings, failedPdfs } = await build(config, { ...opts, strict: true });
      const { formulas, failures } = checkMath(config.out);
      console.log(`checked ${formulas} formulas`);
      if (failures.length) console.error(failures.slice(0, 50).join("\n") + `\n${failures.length} formula(s) failed to render`);
      if (warnings.length) console.error(`${warnings.length} warning(s)`);
      return failedPdfs || warnings.length || failures.length ? 1 : 0;
    }
    case "serve":
      if (!existsSync(join(config.out, "index.html"))) { console.error(`No site in ${config.out}: run marginalia build first.`); return 1; }
      serve(config.out, Number(values.port));
      return -1; // keep running
    case "login":
      return npx([...WRANGLER, "login"]);
    case "deploy":
    case "upload": {
      if (!project) { console.error("Set [deploy] cloudflare_project in marginalia.toml."); return 1; }
      if (values.only?.length) { console.error("A deploy replaces the whole site: run it without --only."); return 1; }
      if (command === "deploy") {
        const { failedPdfs } = await build(config, opts);
        if (failedPdfs) { console.error(`${failedPdfs} PDF(s) failed; not deploying`); return 1; }
      }
      return upload(config.out, project);
    }
    default:
      console.error(`Unknown command ${command}\n\n${HELP}`);
      return 1;
  }
}

main().then((code) => { if (code >= 0) process.exitCode = code; }, (e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
