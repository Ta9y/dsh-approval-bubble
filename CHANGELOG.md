# Changelog

All notable changes to this project are documented here.

## [1.0.0] - 2026-10-24

First public release.

### Added

- Bubble overlay for background sessions with pending interactions:
  - permission approvals (`拒绝` / `允许一次`, plus translate and copy);
  - option questions (single / multi select, custom answer, skip / previous / next / submit, multi-question paging, recommended badge);
  - plan review (headline + summary, expandable plan text, approve, open session).
- Row anchor slot + `shell.overlay` bubble layer, rendered through a React portal into `document.body`.
- Draggable bubbles: drag by the header; the position is pinned; clamped to the viewport.
- Responsive width: ~26% of the window width (268–420px), updated live on window resize.
- Color coding: amber for permission approvals (`--dsw-alias-state-warn-*`), blue for questions / plan review (`--dsw-alias-state-business-primary`).
- Bottom-right fallback stack when the session row is not visible (collapsed workspace, icon rail, scrolled out).
- Host translation route (`/dsh-approval-bubble/translate`) using the DSH `translator` service when available, with Bing/Google anonymous endpoints as fallback.
- Bilingual README (Chinese / English) and bilingual plugin display metadata.

### Security notes

- The plugin never auto-approves and never weakens approval policy; every grant requires a user click.
- `允许一次` / "Allow once" grants elevated execution for one tool call and can run outside the workspace sandbox — see the high-risk section in the README.
- Translate sends bubble text to Microsoft Bing; do not translate sensitive content.
- No telemetry, no session logging, no local storage.
