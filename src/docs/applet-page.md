---
title: The applet page contract
description: The four lines every applet page must have, what the security policy silently discards, and how the page talks to Bernard. Read before writing or editing an applet's HTML.
---
# Writing an applet page

An applet is one HTML file served from its own origin, plus a manifest
declaring what it can do. The page is written by passing `page` to `applet`
`create` or `update`. Omit it and Bernard scaffolds one from the declared
actions — a good starting point to read back and edit.

## The four required lines

```html
<title>What this applet is</title>
<link rel="stylesheet" href="/__bernard/tokens.css" />
<link rel="manifest" href="/__bernard/manifest.webmanifest" />
<script src="/__bernard/applet.js"></script>
```

Write these at the top, before your own markup. Do not add `<!DOCTYPE>`,
`<html>`, `<head>` or `<body>` — the page is served as-is and the browser
supplies them.

The client script must be a **plain** `<script src>`, never
`type="module"`. A module is deferred, so an inline script calling `bernard`
would run first and fail with `bernard is not defined`.

## What the security policy discards, silently

The page is served with a strict content security policy. Three things are
dropped by the browser with no error, so the page simply looks or behaves
wrong:

- **`<style>` blocks and `style="..."` attributes.** Style with the variables
  from `/__bernard/tokens.css`, or ship a separate `.css` file and link it.
- **Anything loaded from another origin** — an image, a font, a stylesheet, a
  `fetch`. An applet may ask for specific origins; until the person grants
  them, nothing off-origin loads.
- **Hand-rolled requests to the host.** They omit the session header and get a
  403. Use the client.

Inline `<script>` for your own event handlers is fine and expected. `eval` and
`new Function` are not — no library that needs them will run.

## Talking to Bernard

The client gives the page two things.

```html
<script src="/__bernard/applet.js"></script>
<script>
  document.getElementById('go').addEventListener('click', async () => {
    const out = document.getElementById('out');
    out.textContent = 'Working…';
    try {
      const result = await bernard.invoke('summarize', { text: input.value });
      out.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      out.textContent = err.message;
    }
  });
</script>
```

`bernard.invoke(action, args)` runs one of the applet's declared actions and
**throws** on failure rather than returning an error envelope — a forgotten
`if (!ok)` leaves a dead button, an uncaught throw is loud. Always show the
message somewhere.

`bernard.store` is a small key-value store private to this applet, for anything
the page must remember between visits:

```js
await bernard.store.set('draft', { text: 'hello' });
const draft = await bernard.store.get('draft');
const all = await bernard.store.list('note:');
await bernard.store.delete('draft');
```

Values are JSON. `list` takes a key prefix. The store is per applet — no other
applet can read it.

## What gets refused at the write path

A page is checked before it is written, and refused when it could not work:

- a missing stylesheet, manifest or client link
- an inline `<style>` block or `style="..."` attribute
- speaking the host protocol directly instead of using the client
- invoking an action the manifest does not declare

Refusals list every problem at once. Fix them together, in one edit.

Warnings — a hard-coded colour, a `getElementById` matching no id in the
markup, an unlinked `.css` file — are worth reading but do not block the write.
