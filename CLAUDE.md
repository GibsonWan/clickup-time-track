# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

No build step — open `index.html` directly in a browser, or serve with any static file server:

```bash
python -m http.server 8000
```

There are no dependencies to install, no package manager, no compilation.

## Architecture

Three vanilla files; no frameworks, no build tools, zero npm dependencies.

| File | Role |
|------|------|
| `index.html` | Markup for the 3-step UI workflow |
| `app.js` | All logic: API calls, state, parsing, rendering, export |
| `style.css` | Full design system using CSS custom properties |

### Data flow

1. User pastes a ClickUp API token → validated against `/user` and `/team` endpoints → stored in `sessionStorage`
2. User picks a date range → converted to Unix timestamps
3. `fetchAllTimeEntries` hits `/team/{teamId}/time_entries` → if task location fields are missing, falls back to parallel `/task/{taskId}` calls
4. `parseEntry` maps raw API fields to a normalised entry object (project code, info, duration in hours, formatted date)
5. `renderTable` builds the preview; `exportCSV` serialises to RFC 4180 CSV with a UTF-8 BOM for Excel compatibility

### State

A single global object in `app.js`:

```js
let state = { token, user, teamId, entries }
```

`token` is also persisted to `sessionStorage` so the page survives a refresh.

### Project code extraction (`parseEntry`)

The trickiest logic. Three patterns tried in order:

1. Leading: `(CODE) List Name` → extracts `CODE`
2. Trailing numeric: `List Name (195154245335)` → treated as a raw ID
3. Fallback: `listId` or `folderId` from the API response

### CSS design system

Custom properties defined at `:root` in `style.css`. Key tokens:

```
--bg        warm beige background
--surface   card white
--accent    warm brown (primary actions)
--success / --error
--radius    13px
```

Fonts: Cormorant Garamond (headings) + Sora (body) loaded from Google Fonts.

## ClickUp API

Base URL: `https://api.clickup.com/api/v2`  
Auth: `Authorization: {token}` header (no `Bearer` prefix — ClickUp v2 convention).

Endpoints used:
- `GET /user` — validate token, get user profile
- `GET /team` — get workspace list (first team used)
- `GET /team/{teamId}/time_entries?start_date=&end_date=&assignee=` — main data fetch
- `GET /task/{taskId}` — fallback when location data is absent from time entry
