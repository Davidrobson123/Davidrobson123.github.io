# Edge Sim Lab (auto-refreshing)

`index.html` is the page. GitHub Actions rebuilds it from the latest nflverse data every hour
(.github/workflows/refresh.yml) and publishes it straight to GitHub Pages (Settings → Pages → Source: GitHub Actions).
A run that finds no new data leaves the page alone (data_fingerprint.txt). The Run workflow button always rebuilds and publishes.

- `roles.json`: hand-set roles for players new to a team (edit or remove entries as their numbers catch up).
- `viz/record.json`: last week's headline record shown on the page (updated from the Edge Ledger in Claude).
- The Edge Ledger and the Claude-hosted pages are updated separately, in Claude.

Each run: export with the latest injury reports and rosters → roles.json (each role switches itself off after 3 games
with the new team) → starting-QB checks → at-a-glance numbers → playoff chances (10,000 seasons) → safety checks
(nothing is published if they fail; GitHub emails you) → prediction history (history/, frozen at kick-off, scored
automatically into viz/record.json once the week is finished) → page. After the regular season it builds the playoff weeks.
