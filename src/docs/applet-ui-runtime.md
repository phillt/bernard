---
title: Building an applet with a UI runtime
description: When plain DOM code stops being enough, and how to use the served Preact runtime instead. Read before hand-writing innerHTML or a render loop in an applet.
---
# The UI runtime

Most applets need no library. One form, one button, one result block — write
plain DOM code and stop.

Reach for the runtime when the page has **a LIST that changes, or more than
about four controls**. That is the point where hand-written `innerHTML` starts
producing subtle bugs: stale rows, lost focus, event handlers wired twice.

## Loading it

```html
<script src="/__bernard/ui.js"></script>
```

A plain `<script src>`, before your own inline script, exactly like the applet
client. It attaches one global, `htmPreact`.

## Using it

```html
<div id="root"></div>
<script>
  const { html, render, useState, useEffect } = htmPreact;

  function App() {
    const [items, setItems] = useState([]);
    const [text, setText] = useState('');

    useEffect(() => {
      bernard.store.get('items').then((saved) => setItems(saved || []));
    }, []);

    async function add() {
      const next = [...items, { id: Date.now(), text }];
      setItems(next);
      setText('');
      await bernard.store.set('items', next);
    }

    return html`
      <div class="field">
        <label for="t">New item</label>
        <input id="t" value=${text} onInput=${(e) => setText(e.target.value)} />
      </div>
      <div class="actions">
        <button onClick=${add} disabled=${!text}>Add</button>
      </div>
      <ul class="cards">
        ${items.map((i) => html`<li key=${i.id}>${i.text}</li>`)}
      </ul>
    `;
  }

  render(html`<${App} />`, document.getElementById('root'));
</script>
```

`html` is a tagged template — no build step, no JSX, no compiler. Interpolate
with `${}`. A component is `<${Name} />`, with the closing tag written `<//>`
when it wraps children.

## What it gives you

`html`, `render`, `h`, `Component`, `createContext`, and the hooks:
`useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`, `useReducer`,
`useContext`, `useLayoutEffect`, `useImperativeHandle`, `useErrorBoundary`,
`useDebugValue`.

There is no `Fragment` export. Return an array, or wrap in an element.

That is Preact's API. Anything written for React hooks works, with two
differences worth knowing: the DOM property is `onInput`, not `onChange`, and
`class` works as well as `className`.

## Styling stays the same

The runtime changes nothing about CSS. Use the classes the served stylesheet
already handles — `.field`, `.actions`, `.cards`, `.output` — and the
components look right with no styles of your own. Never write a `style`
attribute in a template; the policy discards it exactly as it discards one in
static markup.

## Why this one

The security policy has no `unsafe-eval`, so anything that compiles templates
at runtime cannot run — that rules out Vue's full build and Alpine. This
runtime contains no dynamic evaluation at all, which is asserted against the
bytes actually served.

Do not load a library from a CDN. Nothing off-origin loads without the person
granting that origin first, and a script tag that silently does not run is the
worst failure available.
