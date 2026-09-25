# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

This repo expresses wayfinder maps with GitHub's **native** sub-issue and dependency relationships, so the frontier renders visually in GitHub's own UI without opening the map.
Both are GraphQL-only here: the installed `gh` is 2.46.0 with no extensions, so there is no porcelain command for either.

**The map** is an issue labelled `wayfinder:map`.
Find it with `gh issue list --label "wayfinder:map" --state open`.

**Tickets** are native sub-issues of the map, each labelled with exactly one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`.

Attach a ticket to the map:

```bash
gh api graphql -f query='mutation($p:ID!,$s:ID!){addSubIssue(input:{issueId:$p,subIssueId:$s}){issue{number}}}' \
  -F p=<map node id> -F s=<ticket node id>
```

**Blocking** uses native issue dependencies.
Note the field name is `blockingIssueId`, not `blockedByIssueId`:

```bash
gh api graphql -f query='mutation($i:ID!,$b:ID!){addBlockedBy(input:{issueId:$i,blockingIssueId:$b}){issue{number}}}' \
  -F i=<blocked ticket node id> -F b=<blocking ticket node id>
```

Resolve an issue number to a node id:

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){id}}}' \
  -F o=afrossard -F r=actual-budget-transformer -F n=<number> --jq '.data.repository.issue.id'
```

**The frontier** is the open, unblocked, unclaimed children.
One query renders the whole map at low resolution:

```bash
gh api graphql -f query='query{repository(owner:"afrossard",name:"actual-budget-transformer"){issue(number:<map>){subIssues(first:50){nodes{number title state assignees(first:3){nodes{login}} labels(first:5){nodes{name}} blockedBy(first:5){nodes{number}}}}}}}' \
  --jq '.data.repository.issue.subIssues.nodes[] | "\(.number) \(.state) blockedBy=\([.blockedBy.nodes[].number]|join(",")) assignee=\([.assignees.nodes[].login]|join(",")) \(.title)"'
```

A ticket with an empty `blockedBy` and an empty `assignee` is on the frontier.

**Claiming** a ticket is `gh issue edit <number> --add-assignee afrossard`, done *before* any work so concurrent sessions skip it.

**Resolving** is a resolution comment, then `gh issue close <number>`, then a one-line context pointer appended to the map's Decisions-so-far.
