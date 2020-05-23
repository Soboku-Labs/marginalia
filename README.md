# notes-site

Turn folders of **LaTeX books**, **Markdown notes** and **PDFs** into one notes website:

- every collection (a book, a folder of notes or of PDFs) is a single scroll with a sidebar that follows the chapter being read;
- full-text search, plus a Ctrl/⌘K quick jump to any chapter;
- math with KaTeX and LaTeX TikZ pictures as SVG;
- highlights with comments, typed notes inside the page, and handwriting with an Apple Pencil, mouse or finger, all saved in the browser;
- PDFs shown in the page with pdf.js, searchable, and you can write on them;
- one command to deploy to Cloudflare Pages (free, works with private repositories).

## Install

notes-site runs on Node 18+ and calls a few command-line tools:

| You have | You need |
|---|---|
| Markdown | `pandoc` |
| PDFs | `pdfinfo`, `pdftotext` (poppler) |
| LaTeX books | `pandoc`, TeX Live with `latexmk`, `pdftocairo` (poppler) |

On macOS: `brew install pandoc poppler node`, plus MacTeX for LaTeX books.

Add it to your notes repository:

```
npm install --save-dev github:Vishesh-Gupta/notes-site#v0.1.0
npx notes-site init        # writes a starter notes-site.toml
npx notes-site build
npx notes-site serve       # http://localhost:8000
```

## Your documents

Each **collection** is a folder:

| Folder contains | Becomes |
|---|---|
| `main.tex` | A LaTeX book. Each `\include{chapters/...}` is a chapter. `\title{CODE --- Name}` gives the code and name. A first line `% !TEX program = xelatex` (or `lualatex`) picks the engine. |
| `*.md` | One chapter per file, in file-name order (`01-…`, `02-…`). The title is the first `# heading`, or front matter `title:`, or the file name. `README.md` names the collection and is not a chapter. |
| `*.pdf` | One chapter per PDF, pages drawn in the page. The title is the PDF's title, or the file name. |
| `*.md` and `*.pdf` | Both, interleaved by file name. |

Images next to the documents (png, jpg, svg, …) are copied over with the same relative paths, so `![x](images/x.svg)` and `\includegraphics{figures/x.png}` just work.

Collections are grouped as `notes-site.toml` says. Without a `[[group]]` or `[[collection]]`, every top-level folder that is a collection is one, and a top-level folder of collections becomes a group.

## notes-site.toml

```toml
title = "Course Notes"             # site title
description = "My notes."          # home page text
label = "Courses"                  # what collections are called in the menu
brand = "∑"                        # mark before the title
repo = "https://github.com/me/notes"   # GitHub link and per-collection source buttons
branch = "main"
storage = "my-notes"               # browser storage prefix (keep it fixed: notes are saved under it)
out = "_site"                      # where the site is written
cache = ".notes-site"              # figures, converted chapters, PDFs (add to .gitignore)

[[group]]                          # each subfolder of path is a collection
name = "Mathematics"
path = "Mathematics"

[[collection]]                     # or list collections one by one
path = "Misc/Reading list"
group = "Other"
code = "Reading"
title = "Papers I read"

[latex]
preamble = "common/preamble.tex"   # shared preamble (default: the files main.tex \input's);
                                   # its \newcommand's are used on the website, and it starts TikZ pictures
web_macros = "common/web-macros.tex"   # definitions used only on the website

[deploy]
cloudflare_project = "my-notes"
```

### LaTeX on the website

- The book's own preamble (everything in `main.tex` before `\begin{document}`) and the files it `\input`s give pandoc and KaTeX their `\newcommand`s.
- `definition`, `example`, `theorem`, `lemma`, `corollary`, `proposition` and `remark` become numbered boxes. A tcolorbox environment named `important` with a title (`\begin{important}[Title]`) becomes a callout.
- `lstlisting` code is highlighted.
- Every `tikzpicture` is compiled with the book's engine and shown as SVG, cached by content in `.notes-site/tikz`.
- `\zh{}`, `\zht{}`, `\ja{}` and `\ko{}` can be mapped to Chinese, Japanese and Korean `lang` spans through `web_macros` (`\renewcommand{\ja}[1]{\foreignlanguage{japanese}{#1}}`).

## Commands

```
notes-site build     PDFs of the LaTeX books, every page, the search index
notes-site pdf       only the LaTeX books' PDFs
notes-site check     strict build (fails on any warning) + every formula rendered with KaTeX
notes-site serve     preview the built site
notes-site login     log in to Cloudflare in the browser (once per computer)
notes-site deploy    build, then upload to Cloudflare Pages
notes-site upload    upload the already built site
notes-site init      write a starter notes-site.toml
```

Options: `--root DIR`, `--only NAME` (one collection; repeatable), `--no-pdf` (reuse the last PDFs), `--force` (rebuild every PDF), `--strict`, `--port N`.

Builds are incremental:
- A book's PDF is recompiled only when its folder or the shared preamble changed since its last clean build.
- Books compile in parallel, and chapters convert in parallel.
- Converted chapters and TikZ figures are reused from the cache until they change.
- `deploy` uploads only the files Cloudflare does not already have.

PDFs of LaTeX books fail the build on LaTeX errors, undefined references, missing characters, and chapter files that `main.tex` never includes.

## In the browser

| Key | Action |
|---|---|
| Ctrl/⌘K | quick jump to a collection or chapter |
| `/` | search |
| `[` / `]` | previous / next chapter |
| `n` | notes panel: typed notes, highlights, export to Markdown, backup and restore |
| `a` | add a typed note under the current paragraph (Markdown and `$math$`) |
| `d` | draw mode (an Apple Pencil always draws; a finger scrolls) |
| `f` | focus mode |

Everything you add is stored in the browser under the `storage` prefix.

## Deploying

`notes-site deploy` uses Cloudflare Pages through Wrangler. Run `notes-site login` once and set `[deploy] cloudflare_project`. In CI, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead.

## Developing

```
npm install
npm run typecheck
npm run build        # dist/node (the CLI) and dist/client (page scripts)
npm test             # strict build of example/: a LaTeX book, Markdown notes and a PDF
```
