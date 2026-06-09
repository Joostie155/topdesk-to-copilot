# Privacy Policy — TOPdesk → Copilot

_Last updated: 2026-06-09_

## Overview
TOPdesk → Copilot is a browser extension that helps service desk
agents send ticket content from their TOPdesk environment to
Microsoft 365 Copilot for analysis and response drafting.

## What data is processed
The extension reads ticket data (text, metadata, optional attachments)
from the TOPdesk page that is open in your active browser tab,
and pastes that data into Microsoft 365 Copilot in another tab of
the same browser.

## What data is stored
The following is stored locally in your browser via
`chrome.storage.local`:

- Prompt templates you configure
- The most recently scraped ticket (auto-expires after 120 seconds)
- Your display name (optional, used inside prompts)
- User preferences (anonymisation toggle, auto-submit toggle,
  selected prompt)

No data is stored on any server controlled by the developer.

## What data is transmitted
- Ticket content is sent only to the Microsoft 365 Copilot tab you
  have open. This communication happens inside your browser; the
  extension does not relay it through any third-party server.
- TOPdesk REST and dispatcher endpoints are called only on the
  same origin as the TOPdesk tab you are visiting, using your
  existing session cookies, to fetch attachment metadata and files.

## What data is NOT collected
- No analytics, telemetry, crash reporting, or usage statistics
- No personally identifiable information leaves your browser
- No data is sold or shared with third parties
- The extension contains no remote code and loads no scripts from
  external servers

## Permissions
- **activeTab / scripting** — inject content scripts into the
  currently active TOPdesk and Copilot tabs.
- **storage** — persist your prompt config and the pending ticket.
- **clipboardWrite** — copy ticket content as a fallback when the
  keyboard shortcut is used.
- **tabGroups** — place the newly opened Copilot tab in the same
  tab group as the source TOPdesk tab, if one exists.

## Anonymisation
When the "Anonimiseer" toggle is enabled, the extension replaces
email addresses, phone numbers, BSNs, and names with placeholders
before sending content to Copilot. This is a best-effort heuristic
and not a guarantee.

## Trademarks
TOPdesk is a trademark of TOPdesk B.V. Microsoft 365 and Copilot
are trademarks of Microsoft Corporation. This extension is an
independent project and is not affiliated with, endorsed by, or
sponsored by either company.

## Contact
For questions or to report an issue, open an issue on the project's
GitHub repository:
<https://github.com/Joostie155/topdesk-to-copilot>

## Changes
Material changes to this policy will be reflected in updates to
this document and noted in the extension's release notes.
