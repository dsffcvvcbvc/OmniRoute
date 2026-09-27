# AISIX dashboard-SPA E2E suite

Playwright suite that drives the **exported dashboard SPA in a real browser
against a real AISIX gateway**. It exists to answer one question the serving
layer could not: _does the app actually boot, hydrate, and render?_

Everything here is real. There is no interceptor, no `page.route`, no fixture
server and no stubbed response anywhere in the directory — every request in
every test is answered by the deployed Rust binary, and every assertion reads
what that binary returned or what the browser did with it. The one thing a test
supplies is the admin key, as a request header, which is what an ingress in
front of the admin port does and the only way the shipped SPA can obtain a
credential that lives in the gateway's own config.

## How to run

```bash
# 1. Deploy the export artifact somewhere OUTSIDE the repo.
#    Artifact 10932864997 = run 36324605931 = `omniroute-dashboard-out`.
mkdir -p ~/.aisix/dashboard
curl -L -H "Authorization: Bearer $GH_TOKEN" \
  "https://api.github.com/repos/dsffcvvcbvc/OmniRoute/actions/artifacts/10932864997/zip" \
  -o /tmp/dashboard-out.zip
unzip -q /tmp/dashboard-out.zip -d ~/.aisix/dashboard
rm -f /tmp/dashboard-out.zip
# 3950 files, ~193 MiB, 705 *.html. The binary serves this directory; see
# crates/aisix-admin/src/resources_handler.rs::dashboard_root().

# 2. Start the gateway. It REQUIRES --config. Admin port 3001; the dashboard
#    is same-origin under /dashboard, which is why no CORS is involved.
pkill -x aisix
AISIX_DASHBOARD_DIR=$HOME/.aisix/dashboard setsid --fork \
  /home/ernur/.aisix/aisix --config /home/ernur/.aisix/config.yaml \
  > /tmp/aisix.log 2>&1 < /dev/null
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/dashboard   # 200

# 3. Read the admin key out of the gateway config WITHOUT echoing it, and run.
#    The key is only ever passed through the environment: it is never written
#    to a file, never logged, never committed, and every string the suite
#    persists is scrubbed through `scrub()` in harness.ts first.
export AISIX_SPA_ADMIN_KEY="$(
  python3 -c "import re,sys; t=open('/home/ernur/.aisix/config.yaml').read(); \
print(re.search(r'admin_keys:\s*\[(.*?)\]', t, re.S).group(1).strip().strip(chr(34)+chr(39)))"
)"

npx playwright test -c playwright.aisix-spa.config.ts
```

Stop the gateway with `pkill -x aisix`. **Never `pkill -f aisix`** — the `-f`
pattern also matches the invoking shell and kills the session.

| Env var                  | Default                 | Meaning                                                                                                                         |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `AISIX_SPA_BASE_URL`     | `http://127.0.0.1:3001` | gateway admin origin                                                                                                            |
| `AISIX_SPA_ADMIN_KEY`    | _(unset)_               | `admin.admin_keys[0]`. Optional only for the signed-out assertions; the signed-in ones fail with instructions if it is missing. |
| `AISIX_SPA_EVIDENCE_DIR` | `aisix-spa-evidence`    | where scrubbed JSON evidence lands                                                                                              |

### Why this is a separate Playwright config

`playwright.config.ts` boots a Next.js dev server on `:20128` and runs
`tests/e2e/**`. These specs drive an already-running gateway and live in
`tests/aisix-spa-e2e/`, **outside** that config's `testDir`, so `npm run
test:e2e` and the CI e2e job can never pick them up and fail for want of a dev
server. Nothing in `npm run test:all` runs this suite; it is a deployment
acceptance run, and the artifact it tests is produced by the manual
`Dashboard SPA Export` workflow.

### Why trace is off

`extraHTTPHeaders` puts a live gateway credential on every request, and a
Playwright trace archives request headers verbatim. The suite therefore records
its own scrubbed JSON evidence into `aisix-spa-evidence/` and never writes the
key to disk. Turn trace on only against a throwaway gateway whose key you are
happy to publish.

## What each file covers

| File                           | Claim it defends                                                                                                                                                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-hydration.spec.ts`         | The app boots and hydrates. Served bytes are not hydration, so nothing here reads the HTML: it asserts the content region settles, no uncaught exception and no hydration mismatch is logged, and that two purely client-side controls (theme, sidebar collapse) change the document when operated. |
| `02-deep-link.spec.ts`         | Deep routes render on a **cold URL entry** and again after a **refresh**. These are `<Suspense fallback={null}>` shells, so `readSettledContent` distinguishes "still loading" (text keeps changing) from "rendered nothing" (text settles empty).                                                  |
| `03-client-navigation.spec.ts` | The same dynamic routes reached by clicking. Client-side-ness is asserted with a `window` marker, which survives a router navigation and cannot survive a document load — the fallback a wrong RSC content type produces.                                                                           |
| `04-locale.spec.ts`            | `ja` and `ar` (non-Latin, one right-to-left) actually switch, `<html lang>`/`dir` follow, the visible copy carries that writing system, **and the choice survives a reload**. The last half is separate because a preference that is stored and then ignored on entry is not a preference.          |
| `05-static-assets.spec.ts`     | Every `/_next/**` request the browser makes returns 2xx, RSC payloads are accepted as flight responses, a refresh re-proves the tree, and no subresource failure reaches the console. Guarded against a vacuous pass by asserting a minimum request count.                                          |
| `06-absent-routes.spec.ts`     | Unknown URLs are answered honestly: ≥400, no redirect chain, a body the operator can read, and the browser left where it started. Plus the inverse control, so "everything 404s" cannot pass.                                                                                                       |
| `07-admin-surfaces.spec.ts`    | Providers and combos distinguish **refused** from **ready**. The signed-in assertions are made against what the real gateway holds (read over HTTP), never a count written into the test. Signed-out and wrong-key tests clear the credential themselves, so they always run.                       |
| `08-request-budget.spec.ts`    | A failed read does not become an unbounded retry loop, and does not surface as an uncaught exception. Also that every image the catalog renders actually loads.                                                                                                                                     |

## Assertion discipline

- **No skips.** `07` fails with instructions if no admin key is exported,
  rather than skipping. The signed-out and wrong-key cases actively clear the
  credential so they cannot be skipped by an environment that has one.
- **Nothing can pass vacuously.** Every list assertion is preceded by an
  assertion that the list is non-empty, so a test that captured nothing fails
  loudly instead of green.
- **No weakening.** A red assertion here is a finding about the deployed
  system, labelled as such in the run report — `KNOWN-GAP` (waiting on a named
  fix) or `REAL-BUG` (with a file:line) — not a reason to relax an expectation.
