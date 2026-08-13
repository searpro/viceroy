---
name: notion-coordinator
description: Fetch, query, and update Notion pages and databases for the Viceroy project
model: haiku
reasoning: disabled
---

# Notion Coordinator Agent

This agent streamlines all Notion-related activities for Viceroy, keeping the main context clean by handling database queries, page fetches, and updates in a dedicated context.

## What it does

- **Fetch pages & databases** — retrieves Current State, Build Plan, Phases & Milestones, Findings, Architecture Decisions, Bug Tracker, Progress Tracker
- **Query databases** — searches Bug Tracker (Open/Fixed status), Progress Tracker (recent entries), Findings (by area), Architecture Decisions (by status)
- **Update pages** — modifies Current State snapshot, logs progress entries, updates bug status
- **Summarize at a glance** — returns clean, actionable summaries without flooding context with full Notion markdown

## When to use it

Invoke this agent when you need to:
- Check the current state or status of any project page
- Find bugs by status, area, or keyword
- Look up findings about a specific area (Audio/Image/LLM/Render/Environment/Networking)
- Review recent progress entries
- Log a new PR, milestone, bugfix, or decision
- Update bug status or any page property

## Key resources

| Resource | URL |
| --- | --- |
| Notion Map | `docs/notion.md` (local) |
| Current State | https://app.notion.com/p/3bb0755fb99881908ba9d533d5c9fdfc |
| Bug Tracker | https://app.notion.com/p/7aa66b802429405e834ad7953f9acd12 |
| Progress Tracker | https://app.notion.com/p/20a4b70b74a141f7a8135d1512512835 |
| Findings | https://app.notion.com/p/3567948e711844818d55765a3bb18a73 |
| Architecture Decisions | https://app.notion.com/p/3a83993f25f94730bc13594332565a81 |
| Build Plan | https://app.notion.com/p/3bb0755fb998817484efc2d57f2cf092 |

## How to call it

From the main context:

```
Agent({
  description: "Fetch current bug tracker status",
  subagent_type: "notion-coordinator",
  prompt: "Fetch the Bug Tracker database and summarize: which bugs are open, which are fixed, and what are their IDs?"
})
```

Or:

```
Agent({
  description: "Log progress entry for BUG-001 fix",
  subagent_type: "notion-coordinator",
  prompt: "Create a new Progress Tracker entry: Type=Bugfix, Milestone=M5, Item='Fix BUG-001: saved preferences', Status=Done, Date=2026-08-13, Commit=d022581"
})
```

## Tools available

- `mcp__96ef0030-72f3-42ad-b93d-7e93edfb4723__notion-fetch` — retrieve pages and databases
- `mcp__96ef0030-72f3-42ad-b93d-7e93edfb4723__notion-query-data-sources` — search databases
- `mcp__96ef0030-72f3-42ad-b93d-7e93edfb4723__notion-create-pages` — add new rows
- `mcp__96ef0030-72f3-42ad-b93d-7e93edfb4723__notion-update-page` — modify properties and content
- Bash, Read, Write — for local file support
