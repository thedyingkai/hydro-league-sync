# XCPCIO Board integration

Hydro League Agent registers `league-xcpcio` as a separate scoreboard view. It
does not replace Hydro's `xcpcio` view or any Realboard route.

The server determines `public` versus `jury` from the authenticated Hydro
session. Contest owners and users with the hidden-scoreboard permission receive
the jury feed; all other users receive the public feed. Client query parameters
cannot select the jury feed. Hydro signs the exact hub request and proxies the
result through a same-origin `?json=true` endpoint, so the browser never learns
the site secret and never contacts the hub.

The HTML wrapper is served from `/hydro-league-xcpcio/index.html`. It accepts
only a same-origin `source` URL, appends `#allInOne=true`, and loads every
runtime asset from `/hydro-league-xcpcio/vendor`. Its content-security policy
sets `connect-src 'self'`; analytics and public CDN integrations from the
upstream HTML are not present.

An installed historical-scoreboard addon may deliberately point the same
wrapper at its same-origin `/scoreboard/xcpcio?json=true` endpoint. The wrapper
accepts that legacy endpoint without changing the authenticated server-side
public/jury decision or exposing credentials to the browser.

## Scoreboard-only fork

The distributed assets were rebuilt from XCPCIO tag `v0.85.4`, commit
`84dacae07884d90f6db6d6664e55f8552524ef08`. The source fork removes Rating,
Statistics, Resolver, Balloon, Countdown, Highcharts, highcharts-vue, and GSAP.
For an object-form medal configuration, the fork renders only its explicit
Gold, Silver, and Bronze counts; it removes XCPCIO Core's implicit unbounded
Honorable tier so manually entered awards remain authoritative. String presets
such as `ccpc` retain their upstream behavior. Historical warmup contests use
an empty medal object and therefore display no awards.
The exact changes and reviewed build details are in:

- `upstream/xcpcio-board-app-scoreboard-only/SCOREBOARD_ONLY.patch`
- `upstream/xcpcio-board-app-scoreboard-only/FORK.md`
- `upstream/xcpcio-board-app-scoreboard-only/LICENSE`

The official XCPCIO prebuilt bundle is not distributed. Build verification
pins the entire vendor tree by SHA-256, checks local import closure, rejects
Highcharts/GSAP markers, and requires the MIT license and runtime dependency
notices. The corresponding source ZIP includes the fork, exact patch, wrapper,
compiled assets, licenses, and notices.

Run the offline browser check after changing the fork or wrapper:

```text
npm run xcpcio:smoke -- "C:\path\to\chrome.exe"
```

The check serves only a loopback mock all-in-one feed, verifies that teams are
rendered, switches through overall, official, and custom award groups, and
checks the exact Gold/Silver/Bronze classes with no implicit Honorable class.
It also fails if the browser requests a non-loopback URL.
