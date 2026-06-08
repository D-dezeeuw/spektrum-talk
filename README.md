# Escape the Supply Chain: Bring a Time Machine

A conference talk, delivered as a slide deck that **runs on [Spektrum](https://github.com/D-dezeeuw/spektrum)** — the zero-dependency reactive engine the talk is about.

The deck isn't a normal slideshow. Every slide change is a recorded mutation in Spektrum's event store. Navigating **back** is a real `replay(cursor − 1)` — time-travel through history, not a re-render. The progress bar shows `cursor / history.length`, so scrubbing back visibly shrinks it. Press **H** during the talk to reveal the live history HUD.

## Run locally

ES modules don't load from `file://`, so serve it over HTTP:

```bash
python3 -m http.server
# then open http://localhost:8000
```

or

```bash
npx serve .
```

## Controls

| Key | Action |
| --- | --- |
| `→` / `Space` / click-right | next slide (append event, or replay forward) |
| `←` / click-left | previous slide (`replay(cursor − 1)`) |
| `Home` | jump to start (`replay(0)`) |
| `H` | toggle the time-travel HUD |
| `F` | fullscreen |
| swipe | left/right on touch devices |

## How Spektrum is loaded

`index.html` uses an [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) pinned to a CDN version:

```html
<script type="importmap">
{ "imports": { "spektrum": "https://unpkg.com/spektrum@1.1.0" } }
</script>
```

**Going offline / venue wifi blocks CDNs?** Download the engine and switch to a local copy:

```bash
curl -L https://unpkg.com/spektrum@1.1.0 -o spektrum.js
```

then change the import map to:

```html
{ "imports": { "spektrum": "./spektrum.js" } }
```

There is **no fallback navigation by design** — if Spektrum fails to load, the deck shows a loud error screen with the exact cause rather than silently degrading.

## Deploy to GitHub Pages

This repo deploys straight from the branch root (no build step — fitting for a talk about not having one).

1. Create a new repo on GitHub (e.g. `spektrum-talk`).
2. Push this folder (see commands below).
3. Repo **Settings → Pages → Build and deployment**:
   - **Source:** Deploy from a branch
   - **Branch:** `main`, folder `/ (root)`
   - Save.
4. Wait ~1 minute. Your deck is live at `https://<your-username>.github.io/spektrum-talk/`.

## Still to fill in

- Your name and social handles on the title and closing slides (search the HTML for `your name`, `@you`, `your repo`).

## License

MIT — see [LICENSE](LICENSE).
