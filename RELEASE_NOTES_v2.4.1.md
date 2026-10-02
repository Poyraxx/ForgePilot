## What's New in v2.4.1

- Fixed reuse of earlier web search results when redirecting invented URLs to discovered sources. Previous-turn searches no longer depend on message timestamps.
- Stabilized Windows command smoke tests and removed real browser/network access from the web error unit test.
- Releases stay drafts until Windows, macOS, and Linux builds all succeed, preventing incomplete public downloads.

### Included UI and Agent Updates

- Safe Markdown answers with tables, task lists, code blocks, and message/code copying.
- Expandable, highlighted file diffs inside chat.
- A compact, auto-growing composer, Enter to send, Shift+Enter for a new line, and collapsed reasoning and source lists.
- Source links open directly in the browser; duplicated header controls are removed.
- Lightweight streaming updates instead of resending the conversation for each chunk.
- Root-level `AGENTS.md` instructions and on-demand project skills from `.agents/skills`, `.claude/skills`, and `.opencode/skills`.
- Approximate context-size budgeting and bounded tool output without altering stored history or splitting native tool-call pairs.
- Built-in file writes and patches refuse to overwrite externally changed files, including saved-thread recovery.
- Ambiguous patches need a larger exact match or explicit `replaceAll`; LF excerpts preserve Windows CRLF line endings.
- Only HTTP/HTTPS links open externally. Model HTML does not execute and remote Markdown images are not fetched automatically.

### Downloads

- Windows: x64 portable `.exe`.
- macOS: Apple Silicon `arm64` and Intel `x64` `.dmg` or `.zip`.
- Linux: x64 `.AppImage` and Debian/Ubuntu `.deb`.

Local model servers and hosted provider credentials are configured separately. Document extraction requires the documented Python dependencies. macOS builds are unsigned and not notarized.
