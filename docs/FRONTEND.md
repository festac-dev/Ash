# ASH browser frontend

The browser frontend uses React, Vite, Tailwind CSS, React Three Fiber/Three.js and Framer Motion. Its palette is ash grey, black and white. The terminal dashboard remains the default interface.

## Start and stop

- `npm start` launches the CLI dashboard. It compiles the TypeScript backend if necessary, but **does not compile or launch the frontend**.
- In both `npm start` and `npm run demo`, frontend starts OFF. Press **B** outside text inputs to start it and show the URL. Press **B** again to issue and display a one-time code. The third **B** closes it and revokes sessions/codes; the CLI keeps running. B works inside the access dialog too. The first browser launch builds assets if needed.
- `npm run web` starts the frontend and opens a browser.
- `npm run web:serve` starts it and prints the URL.
- `npm run web:stop` stops only the frontend listener.
- `npm run server:stop` stops the backend, frontend listener and engine.
- `npm run build:web` builds only the frontend.
- `npm run build` builds the backend, frontend and terminal client.

After updating Ash, finish active work and restart any already-running backend so it loads
the new B sequence. A service started before the update keeps its old code in memory.

The default address is **http://localhost:5050**. Configure `.env`:

```dotenv
ASH_SERVER_PORT=5050
```

Use `0` for an automatically selected frontend port. Local CLI instances use a separate private API port, allowing the browser listener to stop independently. Remote deployments retain the explicit bind address/port and TLS configuration. The local B listener always binds to loopback and requires the existing ASH authentication.

A fixed `ASH_SERVER_TOKEN` can be used for manual browser sign-in. The second B issues a fresh short-lived, single-use code; tokens are not saved in localStorage. Theme, desktop sidebar and dismissed feature-tour preferences are stored there.

Budget editing remains available in the Money screen and command palette; B is now the browser toggle. M = Money and R = Replay are unchanged.

The public landing page is `/`. The authenticated workspace is `/workspace`. Full task
controls at `/workspace/controls` (`/console` remains an alias) use the same workspace shell. Deep links such as
`/workspace/controls#tasks` survive authentication and refresh. The landing page never
requests private snapshots or events. Shared components provide themes, dialogs and globe rendering.

## First visit and appearance

The first successful sign-in to `/workspace` offers a three-slide feature introduction: tasks and
budgets, the 3D network, and decisions and receipts. Next/Back navigate, Skip or Escape
dismisses it, and Get started completes it. The Help button or `/workspace#guide`
reopens it after authentication. Before sign-in, only the token entry screen appears;
the guide and private workspace are not mounted. It never appears automatically on the landing page. Dismissal is stored
as `ash.quick-start.v1=seen`; blocked storage preserves dismissal for the current document only.

Sidebar links switch the content panel without replacing the header or sidebar. Hash
URLs preserve sections across reloads and browser Back/Forward. The desktop hamburger
collapses the sidebar to an icon rail; `ash.sidebar.collapsed` remembers that preference.
Small screens use a closed drawer by default, with a backdrop, focus containment and
Escape to close. Arrow keys and Home/End navigate sidebar links. Active links carry
`aria-current`; reduced-motion settings disable transitions. The drawer fills the
height below the header and scrolls independently on short landscape screens.
The landing footer fills any spare viewport height without covering page content.
On narrow screens, Disconnect uses a labeled icon; at 360 CSS pixels and below,
the header keeps the Ash mark while hiding the wordmark to prevent overlap.

Landing, overview and task controls share the locally bundled Manrope/Space Grotesk
fonts and ash-grey light/dark palette. Panels retain layered surfaces and optional
pointer tilt; reduced-motion preferences are respected. Normal screens use short
labels, statuses and contextual errors. Hosting, authentication internals and remote
setup belong in [REMOTE.md](REMOTE.md), [SECURITY.md](SECURITY.md) and the README.
Financial confirmations and simulation labels remain visible where needed.

## Development and platform support

Run `npm run web:serve`, then `npm run web:dev` for Vite's development server on port 5051. `ASH_WEB_DEV_PORT` changes that development port; its API proxy targets `ASH_SERVER_PORT`. Production serves frontend and API requests from the same origin.

Rollup is pinned to the portable `@rollup/wasm-node` implementation, and Tailwind uses its JavaScript PostCSS plugin. No Rollup Android native addon, Tailwind Oxide or Lightning CSS native addon is required. esbuild/tsx still use the matching platform binary. Install dependencies in the runtime you use (`npm ci` in Ubuntu, or `npm ci` in native Termux); copying a `node_modules` directory between runtimes can leave the wrong binary. Both Linux ARM64 and Android ARM64 esbuild binaries were retained in this shared workspace and tested. The TUI is built without cgo by default. Native Android builds target a static Linux binary, which runs directly on the Android kernel and avoids an Android cgo linker requirement.

## File structure

```text
frontend/
  index.html
  vite.config.js
  public/assets/             # Procedural SVG fallback and ash-grey brand mark
  src/
    App.jsx                  # Route boundary: public landing vs private workspace
    LandingApp.jsx           # Public introduction and ambient globe; no private data
    WorkspaceApp.jsx         # Authentication, task overview, network and tools
    main.jsx                 # Hydration (production), React mount (development), local fonts
    prerender.jsx            # Public/disconnected HTML at build time
    styles.css               # Responsive ash palette, dark/light themes, focus/motion rules
    lib/api.js               # Same-origin HttpOnly-cookie API client
    lib/useAsh.jsx           # Session, SSE, snapshots and deduplicated activity
    lib/network.js           # Read-only event and entity adapter (DOM-independent)
    components/
      Dialog.jsx             # Native accessible modal and focus restoration
      PanelBoundary.jsx      # Recovery when an optional dialog chunk fails
      FeatureCard.jsx        # Shared depth panels; motion loaded on first mouse hover
      QuickStart.jsx         # Authenticated, dismissible workspace feature tour
      ControlsPanel.jsx      # Existing controls mounted within the shared shell
      WorkspaceDialogs.jsx   # Sign-in, drafts, chat, read-only task/agent/receipt views
      TrackSection.jsx       # Six local track checks and the shared journey verdict
      globe/AshGlobe.jsx      # Lazy-loading, static fallback, controls and visibility
      globe/GlobeScene.jsx    # BufferGeometry particles, routes, nodes and event pulses
src/server/frontend.ts       # Independently controlled browser listener
src/server/frontend-build.ts # On-demand build, separate from CLI startup
scripts/build-web.mjs         # Vite, public prerender, gzip/Brotli, preserved /console
scripts/test-web.mjs          # Chromium desktop/mobile, auth, events, fallback and axe tests
scripts/test-tracks-web.mjs   # Track verification checks without requiring WebGL
```

The procedural globe uses a small number of draw calls for 1,300–2,600 particles. It has no Earth texture or GLB download. Background dots and orbital lines are decorative. Labelled nodes are actual task steps and selected agents from the active task; route lines represent dependencies and recorded marketplace assignments. The accessible node list provides the same details without interacting with 3D.

The globe starts automatically on desktop and mobile, without start/step/replay buttons. Three.js loads separately, with DPR capped at 1.5 and an adaptive particle budget. If WebGL fails, a lightweight 2D canvas projects the same sphere and network nodes. Both renderers support dragging, keyboard exploration, reduced motion and offscreen/background suspension. Actual renderer/frame metrics are recorded by browser verification; fallback measurements must not be presented as GPU measurements.

The production build prerenders the public, disconnected page so its text and fallback artwork can paint before JavaScript runs. React hydrates that markup; authentication and all private statistics are loaded only in the browser. Theme selection runs before paint to preserve a saved light/dark preference. Dialogs load on demand, and card tilt loads a small Motion runtime on first mouse hover. The final initial JavaScript bundle is approximately 275 KB (85 KB gzip); the separately loaded Three.js chunk is approximately 940 KB (253 KB gzip). See VERIFICATION.md for the current measurements and limitations. The two primary local fonts are preloaded, and `font-display: swap` keeps text readable while ensuring the intended fonts appear once loaded. The fallback globe preload carries high fetch priority.

Public HTML, scripts, styles and SVGs have prebuilt gzip/Brotli versions, selected with `Accept-Encoding`; compression adds no per-request CPU work. Hashed assets use immutable caching. HTML and authenticated API responses remain `no-store`, while fixed-name artwork and theme assets revalidate. The existing content security policy and authorization remain in place.

## Event contract and evidence

The frontend reads `/api/state` and subscribes to authenticated `/api/events`. It never reads engine internals. The adapter produces:

```js
{
  id: 'deduplication key',
  type: 'verification.passed',
  nodeId: 'task_id:subtask_id', // null for task-wide events
  taskId: 'task_id',
  at: 'ISO timestamp',
  detail: 'Backend evidence in words',
  simulated: false
}
```

| Normalized event | Current evidence |
| --- | --- |
| `agent.discovered` | A newly recorded selected vendor in a subsequent task snapshot |
| `agent.assigned` | A newly recorded marketplace job id |
| `task.started` | A transition to an active execution phase or `JOB_IN_PROGRESS` |
| `task.completed` | Completed subtask state or `TASK_COMPLETED` |
| `agent.communication` | `DELIVERABLE_RECEIVED`; a delivery, not a claim of agent chat traffic |
| `verification.passed` / `verification.failed` | A new verification record and its result |
| `transaction.confirmed` | Payment status changes to RELEASED/SIMULATED_RELEASED; marketplace settlement, **not blockchain finality** |
| `execution.failed` | Backend subtask/task/verifier error events |
| `agent.connected`, `transaction.submitted` | Reserved; no current backend evidence, so no animation is fabricated |

Initial snapshots, reconnect baselines and switching tasks do not replay old events as live. Activity pulses expire. A disconnected or inactive globe explicitly says ambient. Simulation labels are shown whenever the actual ASH backend is in simulation mode. Active-agent counts require a recorded assignment and running work; verified receipt counts are limited to the latest 25 receipts and require a healthy receipt chain. No user counts, testimonials, subscription prices or blockchain activity have been invented. Budget views preserve the real per-task authorization model and approval controls.

`POST /api/frontend/cycle` advances start → code → stop on the server. Overlapping access changes return 409. `GET /api/frontend` includes `next_action`.

`POST /api/frontend` is bearer-only. `{}` toggles; `{ "running": true }` starts idempotently; `{ "running": false }` stops. GET returns status. This controls the listener only. Browser cookies cannot invoke it. Existing planning, approval and financial controls remain in the backend and `/console`.

## Validation

`npm test` runs backend and adapter tests. `npm run test:tui` checks terminal controls including B. `npm run test:web` runs Chromium interaction tests, captures desktop/light/mobile screenshots, and runs axe WCAG A/AA audits. Install the test browser with `npx playwright install chromium` if needed. Browser results and measured rendering information are saved in `frontend-browser-results.json`; screenshots are in `screenshots/`. These software-rendered measurements are not a guarantee of hardware GPU performance. See the completion report for the checks actually executed.

`npm run test:web:tracks` builds the frontend if needed and tests the six-track browser flow against a temporary local backend. It covers sign-in, a single-track run, all-six verification, rerunning one track while retaining the other results, a failed request and retry, responsive layout, and disconnect. It uses the same automatically started globe; WebGL is not required because the canvas fallback is functional. The same checks also run in `npm run test:web`; that broader suite checks interaction using WebGL or the functional Canvas2D fallback.

The track cards appear only in demo mode and show deterministic local evidence separately from live-provider readiness. Live mode omits these simulation-only actions. After connecting, use **Run track** for an individual module or **Verify all six** for the shared journey. Completed cards change their action to **Run again**. A single-track rerun preserves the other cards but clears the old shared-journey verdict. None of these checks demonstrates real settlement, TEE attestation, or DAO execution.

### Historical baseline (before this branch)

The measurements below were inherited with the original work and are not final results for this branch. See [VERIFICATION.md](VERIFICATION.md) for the checks actually executed during this pass.

These are the initial implementation measurements. See [reviews/CODE_REVIEW.md](reviews/CODE_REVIEW.md) for the subsequent full-code review and current regression results.

- Backend suite: **131/131 passed on Linux Node 22**, including the new public HTML/compression/cache checks. The final frontend/remote suite also passed **6/6 on native Android Node 26**; the earlier full Android suite passed **130/130**.
- Production backend, browser and TUI builds passed. The TUI also compiled to Windows AMD64; an actual Windows terminal was not available.
- Real PTY checks passed on Linux and native Android: conversation persistence, clickable Send/New task/Cancel, `/task` handoff, Money/Replay, resizing, B opening/closing the frontend, port release and surviving core API. A direct `npm start` check confirmed that starting the CLI does not rebuild the frontend.
- Go tests and TypeScript checking passed. The nginx TLS integration passed secure-cookie, auth, CSRF and SSE checks.
- Chromium browser checks passed for interaction, task drafts, chat, backend-derived event states, light/dark themes, touch, reduced motion, visibility pause and unavailable-WebGL fallback. Both themes had **zero automated WCAG A/AA violations**. Automated audits do not replace manual accessibility review.
- Software Mesa/llvmpipe inside Termux Ubuntu measured **1.3–13.3 FPS** across runs (latest: **15.1 FPS**), **6 draw calls**, **1,300 particles**, pixel ratio **1** after adaptive reduction. This establishes a software-rendered baseline; 60 FPS on a hardware GPU has not been measured. Chromium's bundled ARM64 SwiftShader crashed in this environment, so the completed WebGL checks used Mesa with a virtual display. `ASH_BROWSER_ARGS` accepts a JSON array of extra test-browser flags.

[Browser results](frontend-browser-results.json), [desktop globe](screenshots/frontend-hero.png), [light theme](screenshots/frontend-light.png), [mobile](screenshots/frontend-mobile.png), [CLI workspace](screenshots/cli-home.png), [task form](screenshots/cli-task-form.png).

Live marketplace spending, real provider credentials and blockchain finality were not exercised. Simulation remains explicitly labelled. The six project workstreams remain planning scopes; these UI checks do not establish new testnet product evidence.

The mobile fallback is preloaded and uses grouped SVG paths instead of 1,600 individual circle elements (about 41 KB). Public text is included in the initial HTML. [Lighthouse mobile measurements](frontend-lighthouse-results.json) record the actual scores from this constrained runtime; a 90+ performance score is not claimed.


### Historical browser loading measurements

These are mobile Lighthouse runs in the same Termux/Ubuntu environment, using the static mobile globe and simulated throttling. Host load and software rendering affect repeatability. The first prerender/compression pass scored 56; font preloading and avoiding late font swaps brought the final run to 61.

| Metric | Earlier baseline | Final run |
| --- | --- | --- |
| Performance score | 58 | 61 |
| Accessibility / best practices / SEO | 100 / 100 / 100 | 100 / 100 / 100 |
| First contentful paint | 1.0 s | 2.5 s |
| Largest contentful paint | 4.2 s | 3.1 s |
| Total blocking time | 2,100 ms | 2,090 ms |
| Layout shift | 0.007 | 0 |
| Initial JavaScript, uncompressed | approximately 409 KB | approximately 268 KB |

The initial script is served at approximately 83 KB with compression. Largest-content paint and layout stability improved, while first paint was slower in this run. Main-thread/layout work remains a limitation; the 90+ performance target has not been met in this environment. No hardware-GPU frame-rate improvement is claimed.
