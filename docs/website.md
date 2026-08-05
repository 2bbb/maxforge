# Project website

The public project site is <https://2bit.jp/maxforge/>. Its deployable,
dependency-free source lives in `site/`; it is not generated from the README and
does not require Jekyll or a Node.js build.

## Local validation

Run the same structural check used by CI:

```bash
python3 scripts/verify-pages.py site
node --check site/main.js
```

The verifier rejects a missing entry page, stylesheet, script, favicon,
`.nojekyll` marker, local asset, local anchor, unofficial-project disclaimer,
or npx quickstart.

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
