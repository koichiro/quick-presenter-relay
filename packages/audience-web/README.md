# Quick Presenter Audience Web

Shared browser UI for Relay Protocol `1`, package version `1.0.2`. Apache-2.0;
see LICENSE and NOTICE. No runtime dependencies or build step are required.
Install with `npm install quick-presenter-audience-web@1.0.2`.

The package exports its mobile join page (`/index.html`), browser ES module
(`/audience.js`), license and notice. The root export provides `mountAudience`
with injected browser APIs for conformance tests. A compatible adapter serves the
page at `/join/{room}` and the module at `/assets/audience.js`, preserving notices.
The browser derives its WebSocket endpoint from the current origin and room path.
Do not inject presenter credentials, operator secrets or presentation content.

Load these exported files from the installed package; do not maintain adapter-owned
copies. HTTP/HTTPS and authentication belong to adapters and shared protocol
contracts, not this UI package. Wire compatibility and browser asset identity are verified separately.

## Browser behavior

The join page uses the native audience layout: dark presentation theme, Anonymous
by default, a right-side Send button, Enter-to-send and Shift+Enter for new lines.
IME composition confirmation never sends. Unicode limits use code points and UTF-8
bytes, and accepted comments clear only an unchanged draft.

A token is retained only in tab-scoped session storage keyed by the room path.
New join links replace it; malformed explicit tokens remove the retained token.
Reload restores the token without replaying messages. If tab storage is blocked,
the token fragment stays available for reload. Neither localStorage nor cookies
are used. Disconnect offers Reconnect; pending drafts are never sent automatically.
Sending is serialized until a correlated receipt or a four-second timeout.
