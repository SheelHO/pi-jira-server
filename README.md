# pi-jira

[![Build](https://github.com/SheelHO/pi-jira-server/actions/workflows/build.yml/badge.svg)](https://github.com/SheelHO/pi-jira-server/actions/workflows/build.yml)

A Pi package that connects Pi to Jira Server/Data Center. It adds Jira tools and slash commands for reading tickets, viewing related work, listing attachment URLs, transitioning issues, assigning issues, and saving workflow/people/ticket data in local pi-hermes-memory.

## Install

```bash
pi install git:github.com/SheelHO/pi-jira
```

Reload Pi if it is already running:

```text
/reload
```

## Configuration

Create:

```text
~/.pi/agent/jira.json
```

Recommended config, using an environment variable for the token:

```json
{
  "baseUrl": "https://jira.example.co.uk",
  "token": "$JIRA_TOKEN",
  "authType": "bearer",
  "apiVersion": "2",
  "projectKey": "<projectKey>"
}
```

Set the token in your shell:

```bash
export JIRA_TOKEN="your-jira-token"
```

Lock down the config file:

```bash
chmod 600 ~/.pi/agent/jira.json
```

## Local pi-hermes-memory

This extension stores reusable Jira data locally at:

```text
~/.pi/agent/pi-hermes-memory/jira-extension-memory.json
```

This is a local file on your machine. The extension does not upload this memory file to the internet.

Stored data:

- workflow transitions
- direct project people
- tickets read through `/jira` or `jira_read_ticket`

Why:

- `/jira-update` fetches workflow/people once and saves them locally.
- `/jira-people` reads from local memory instead of calling Jira.
- `/jira <ticket>` uses a locally remembered ticket when available; otherwise it fetches it once and saves it locally.

Run `/jira-update` when workflow or people data needs refreshing.

## Commands

```text
/jira <ticket>
/jira-related <ticket>
/jira-tree <ticket>
/jira-attachments <ticket>
/jira-transition <ticket> In Progress
/jira-transition <ticket> In Progress <person>
/jira-assign <ticket>
/jira-assign <ticket> <person>
/jira-people
/jira-update
```

## Tools exposed to Pi

- `jira_read_ticket`
- `jira_related_tickets`
- `jira_ticket_attachments`
- `jira_ticket_images` deprecated alias
- `jira_epic_tree`
- `jira_transition_ticket`
- `jira_assign_ticket`
- `jira_project_people`
- `jira_update_workflow`

## Features

- Read a Jira ticket by key, using local pi-hermes-memory when available.
- Save fetched tickets locally for reuse.
- Show related tickets.
- Show a tree for an epic or a feature/ticket with linked epics.
- List clickable Jira attachment URLs.
- Transition a ticket to a target Jira status.
- Assign a ticket to yourself or a locally remembered direct project member.
- Save workflow statuses and direct project-role people for autocomplete.
- Avoid expanding huge Jira groups when listing project people.

## Attachments

`/jira-attachments <ticket>` lists Jira attachment URLs, for example:

```text
- image001.png (image/png) -> https://jira.example.gov.uk/secure/attachment/123/image001.png
```

It does not download files.

## Development

Install dependencies and run the TypeScript build check:

```bash
npm install
npm run build
```

Validate that Pi can load the package locally:

```bash
pi --no-extensions -e ./extensions/jira/index.ts --list-models '__unlikely__'
```

Expected result: both commands exit successfully and print no extension load errors.

## Notes

This extension was generated and iterated with AI assistance. Review and test it before using it against production Jira projects.
