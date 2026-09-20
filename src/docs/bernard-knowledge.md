---
title: Giving Bernard your documents
description: Knowledge libraries — ingesting files, folders and PDFs so Bernard can search and quote them, and how that differs from memory. Read when the user wants Bernard to know the contents of documents they have.
---

# Knowledge libraries

A library is a set of documents you have given Bernard to read: a handbook, a
folder of specs, a book, a PDF. Bernard searches them when a question touches
them and quotes the passage rather than recalling a gist of it.

This is your corpus, not Bernard's memory of you. Nothing here expires, nothing
is deduplicated away, and nothing is sent unless it is relevant.

## Making one

```
bernard knowledge create mybooks --title "Reference shelf"
bernard knowledge add mybooks ./docs ./README.md
```

`add` takes files, whole directories, and PDFs. A PDF needs `pdftotext`
installed; without it Bernard says so rather than silently skipping the file.

Ingesting is not instant — each document is split up and indexed — so it runs
in the foreground and reports progress. One document is committed at a time,
which means a run that dies part-way keeps what it had done, and running it
again skips anything that has not changed. `--force` re-ingests anyway.

## Using one

```
bernard knowledge search "how do we roll back" --library mybooks
bernard knowledge read mybooks ./docs/deploy.md --from 4 --to 8
```

`search` looks across every library unless `--library` narrows it, `--limit`
caps the results, and `--neighbours` widens each hit with the passages either
side of it — useful when a hit lands mid-explanation.

`read` pulls a range of a document back in order, which is how you go from "this
passage looks right" to reading the section around it.

`bernard knowledge list` shows the libraries, `stats` shows what is in one, and
`remove <id>` deletes a whole library — or `remove <id> <uri>` a single
document from it.

Inside a session, Bernard searches and reads libraries itself. It **cannot
add** to one: ingesting reads arbitrary paths off your disk, so that stays a
command you type.

## Searching

Two things happen at once. One matches on meaning, so a question phrased
differently from the document still finds it. The other matches on the exact
words, which is what finds a file name, an error code or a function name — the
things meaning-based search is worst at.

Results come back with enough around them to be readable, and consecutive hits
from one document are stitched together rather than returned as fragments.

## Library or memory

- A **library** is documents you own, searched on demand, quoted exactly.
- **Memory** is short facts about you and your work, sent along automatically.
  See `bernard-memory`.

"Remember that I prefer dark themes" is memory. "Here are our six runbooks" is
a library. Putting a book in memory would send the whole thing on every call;
putting a preference in a library means it only turns up if you happen to ask
about it.

A specialist can be restricted to particular libraries, so an agent answering
questions about one product does not quote another's manual.
