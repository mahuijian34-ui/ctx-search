# ctx-search

**Full-text search over compressed AI-agent session logs.**

Long-running AI agents lose their memory. Once the context window is compacted, the agent can no longer recall what it decided an hour ago — file paths, numbers, prior conclusions. `ctx-search` gives it a way back: it decompresses the session archive and makes every past message searchable.

This is a small, dependency-free tool that turns a compressed session log into queryable history.

---

## The problem

Agent runtimes persist conversations to disk for durability. Those logs are usually:

- **compressed** (e.g. zstd) to keep disk usage sane;
- **append-only**, so compression happens in many small frames;
- **structured** (JSONL), with the actual content nested a few levels deep.

The result is an archive that is technically complete but practically unreadable. When an agent needs to answer *"what did we decide about the database migration?"*, it cannot grep a multi-frame zstd archive, and its own in-memory context may already have been compacted away.

## The approach

`ctx-search` addresses this in three steps:

1. **Multi-frame decompression.** Naive decompression of a concatenated zstd stream returns only the *first* frame — in practice often a few hundred bytes. The tool splits the file on the zstd magic number and decompresses each frame independently, then concatenates the results.
2. **Structured parsing.** Each JSONL line is one event. The tool parses them and recursively extracts every string field from the event payload, which is where the human-readable content actually lives.
3. **Keyword retrieval.** A simple case-insensitive substring search returns each hit with surrounding context, plus its position in the session, so the caller can judge recency.

## Quick start

```bash
# List available session archives (largest first)
node ctx.js list

# Search a session for a keyword
node ctx.js search "database migration"

# Show the earliest 5 hits instead of the most recent
node ctx.js search "database migration" --before=5

# Inspect the tail of a session
node ctx.js tail --n=10

# Show corpus statistics
node ctx.js stats
```

The session directory is auto-detected from common runtime locations (`~/.dsh/sessions` and
equivalents). Override it when your runtime stores sessions elsewhere:

```bash
node ctx.js search "keyword" --root=/path/to/sessions
CTX_SEARCH_ROOT=/path/to/sessions node ctx.js list
```

A tiny synthetic session is bundled for trying the tool without any real data:

```bash
node ctx.js search "migration" --root=./examples
```

No installation, no dependencies, no build step. Node.js ≥ 22.15 (built-in `zlib.zstdDecompressSync`).

## Example

```
$ node ctx.js search "deploy" --before=2
session 61b79ec3… | 12564 messages | 73 hits for "deploy"
======================================================================
[#7429] …we decided to deploy after the migration completes, because…
[#8112] …the deploy script lives at scripts/deploy.sh and takes…
```

## Design notes

- **Read-only.** The tool never modifies session archives.
- **No index by default.** Decompressing a 10 MB archive takes roughly two seconds, which is acceptable for interactive lookup. An optional on-disk index is a natural extension.
- **Content-agnostic.** The parser walks the payload recursively rather than assuming a schema, so it survives format changes that keep JSONL structure.
- **Recovering from truncated frames.** If a frame is corrupt (e.g. the process died mid-write), that frame is skipped and the remaining history stays searchable.

## Limitations

- Decompression is full-file; very large archives will be slow without an index.
- Search is exact substring matching, not semantic retrieval.
- The tool is a **recall** aid, not a memory system: it retrieves what was said, it does not distil knowledge. Distilled state belongs in files the agent maintains deliberately.

## Why this matters

Agent memory is usually framed as a vector-database problem. But a large fraction of real "forgetting" is simpler: the transcript exists on disk, and nothing can read it back. `ctx-search` closes that gap with a few hundred lines and no infrastructure.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and pull requests welcome, particularly:

- an on-disk index for repeated queries over large archives;
- support for additional session formats;
- fuzzy matching for OCR'd or slightly corrupted text.
