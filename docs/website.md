# Project website

The public project site is <https://2bit.jp/maxforge/>. Its deployable,
dependency-free source lives in `site/`; it is not generated from the README and
does not require Jekyll or a Node.js build.

`site/index.html` is the product overview. `site/docs/index.html` is the
operational documentation for installation, CLI commands, DSL authoring, MCP
target selection, the native external, recovery, Skills, and current safety
limits. Keep detailed protocol schemas in the repository Markdown and link to
them from the HTML guide instead of duplicating every schema.

## Local validation

Run the same structural check used by CI:

```bash
python3 scripts/verify-pages.py site
node --check site/main.js
```

The verifier recursively checks every HTML page. It rejects missing titles,
language metadata, primary headings, duplicate IDs, local files, cross-page
anchors, required documentation sections, safety disclosures, sitemap entries,
the unofficial-project disclaimer, or the npx quickstart. The site uses the
Pages artifact workflow, so it does not pass through Jekyll and does not need a
`.nojekyll` marker.

For a local visual preview:

```bash
python3 -m http.server 8000 --directory site
```

Then open <http://127.0.0.1:8000/>.

## Deployment

`.github/workflows/deploy-pages.yml` deploys `site/` through the official GitHub
Pages artifact workflow after a relevant push to `main`. It can also be run
manually with `workflow_dispatch`. The deployment job uses the `github-pages`
environment and only receives `pages: write` and `id-token: write` in addition
to read-only repository contents.

The repository Pages source must remain configured as **GitHub Actions**
(`build_type: workflow`). Do not switch it to a branch source: `site/` is not an
allowed branch-source path, and duplicating it into `/docs` or a generated
branch creates two sources of truth.
