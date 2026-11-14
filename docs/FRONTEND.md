# Browser frontend

The React/Vite frontend shares the backend with the terminal clients.

| Route | Purpose |
| --- | --- |
| `/` | Public introduction; does not fetch private tasks or events |
| `/workspace` | Authenticated overview, task navigation and network view |
| `/workspace/controls` | Planning, approvals, execution, preferences and receipts |
| `/console` | Compatibility route for the full controls |

## Access

Browser access starts OFF unless `ASH_SERVER_UI=true` is configured. In the terminal,
B starts the listener, a second B displays a one-time code, and a third B closes
browser access and revokes codes/sessions. `ash frontend on`, `code`, `status`, `off`
and `logout-all` provide explicit commands. Enter codes in the sign-in form, not URLs.

Codes expire after five minutes by default and work once. Sign-in creates an
HttpOnly cookie session. See [REMOTE.md](REMOTE.md) for SSH tunnels and public HTTPS,
and [SECURITY.md](SECURITY.md) for the access boundary.

## Navigation and appearance

The first successful sign-in offers a dismissible feature tour; Help reopens it.
Sidebar links preserve the workspace shell and support Back/Forward navigation.
Desktop users can collapse the sidebar to an icon rail. Small screens use a drawer
with keyboard focus containment and Escape to close. Appearance preferences are
stored locally; blocked browser storage does not prevent operation.

Dark and light themes use local Manrope and Space Grotesk fonts. Theme changes apply
foreground/background colors together. Controls support keyboard focus and reduced
motion. The network view has a labelled node list for access without interacting
with the canvas.

The globe loads Three.js separately and adapts its particle count and pixel ratio.
A Canvas2D fallback handles unavailable WebGL. Both support dragging, keyboard
exploration and suspension when hidden; reduced motion disables automatic rotation.
Loading artwork and the renderer share framing, with an opacity handoff after the
first painted frame. Scrolling does not zoom the globe.

## Data and actions

The workspace fetches `/api/state` and subscribes to authenticated `/api/events`.
Initial/reconnected snapshots establish a baseline rather than replaying old events.
Task and agent nodes come from recorded backend entities; decorative particles do
not represent users or agents. Simulation labels reflect the backend's actual mode.

Planning, approvals, budgets and execution remain backend operations. A chat reply
cannot approve spending. The mainnet panel previews transfer finality without saving
or assigning a payment; explicit CLI/API recording and settlement are separate.
See [API.md](API.md) and [COMMANDS.md](COMMANDS.md).

## Build and development

```sh
npm run build:web
npm run web:dev
```

Production output in `dist/web` includes separate landing/workspace HTML, fixed
compatibility controls, hashed assets, and gzip/Brotli variants. Public HTML is
prerendered; authentication and private data load only in the browser. Hashed assets
use immutable caching, while HTML and authenticated API responses use `no-store`.

`src/server/frontend-build.ts` builds on demand during local frontend activation.
The browser can also run from prebuilt production assets without source files.

## Tests

```sh
npx playwright install chromium
npm run test:web
npm run test:web:tracks
```

The browser suite covers sign-in, revocation, task forms, chat, events, navigation,
mobile input, theme transitions, reduced motion, renderer fallback and automated
WCAG A/AA checks. Its results are written to `test-results/browser/results.json`
and screenshots to `test-results/browser/screenshots/`. These generated artifacts
are ignored by Git and retained by CI.

Set `ASH_BROWSER_EXECUTABLE=/path/to/chromium` to use an installed browser and
`ASH_BROWSER_HEADED=1` to display it. Automated Chromium checks do not replace
physical-device testing or a full manual accessibility assessment.
