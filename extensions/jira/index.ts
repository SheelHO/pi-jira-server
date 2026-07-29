import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type JiraConfig = { baseUrl: string; token: string; authType?: "bearer" | "basic"; apiVersion?: "2" | "3"; projectKey?: string };
type JiraIssue = { key: string; self?: string; fields?: Record<string, any> };
type Transition = { id: string; name: string; to?: { name?: string } };
type JiraUser = { name?: string; key?: string; displayName?: string; emailAddress?: string };

const CONFIG_PATH = join(homedir(), ".pi", "agent", "jira.json");
const HERMES_MEMORY_PATH = join(homedir(), ".pi", "agent", "pi-hermes-memory", "jira-extension-memory.json");
const DEFAULT_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "reporter", "description", "created", "updated", "labels", "components", "fixVersions", "attachment", "parent", "subtasks", "issuelinks"];
const workflow = new Map<string, string[]>();
let people: JiraUser[] = [];
let tickets: Record<string, JiraIssue> = {};
let defaultProject = "";

async function readConfig(): Promise<JiraConfig> {
	const config = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as JiraConfig;
	if (!config.baseUrl || !config.token) throw new Error(`Missing baseUrl/token in ${CONFIG_PATH}`);
	if (config.token.startsWith("$")) config.token = process.env[config.token.slice(1)] ?? "";
	if (!config.token) throw new Error("Jira token is empty");
	defaultProject = config.projectKey ?? defaultProject;
	return { ...config, baseUrl: config.baseUrl.replace(/\/+$/, ""), authType: config.authType ?? "bearer", apiVersion: config.apiVersion ?? "2" };
}

function authHeader(config: JiraConfig): string {
	return `${config.authType === "basic" ? "Basic" : "Bearer"} ${config.token}`;
}

type JiraMemory = { defaultProject?: string; workflow?: Array<[string, string[]]>; people?: JiraUser[]; tickets?: Record<string, JiraIssue>; updatedAt?: string };

async function loadHermesMemory(): Promise<void> {
	const memory = JSON.parse(await readFile(HERMES_MEMORY_PATH, "utf8").catch(() => "{}")) as JiraMemory;
	workflow.clear();
	for (const [from, tos] of memory.workflow ?? []) workflow.set(from, tos);
	people = memory.people ?? [];
	tickets = memory.tickets ?? {};
	defaultProject = memory.defaultProject ?? defaultProject;
}

async function saveHermesMemory(): Promise<void> {
	await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(join(homedir(), ".pi", "agent", "pi-hermes-memory"), { recursive: true }).then(() => writeFile(HERMES_MEMORY_PATH, JSON.stringify({ defaultProject, workflow: [...workflow.entries()], people, tickets, updatedAt: new Date().toISOString() }, null, 2))));
}

async function ensureDefaultProject(ctx: any): Promise<string> {
    if (defaultProject) {
        return defaultProject;
    }

    const project = (
        await ctx.ui.input(
            "Default Jira project",
            "e.g. ABC"
        )
    )?.trim().toUpperCase();

    if (!project) {
        throw new Error("A Jira project is required.");
    }

    defaultProject = project;
    await saveHermesMemory();

    return project;
}

function keyOf(key: string): string {
	const value = key.trim().toUpperCase();
	if (!/^[A-Z][A-Z0-9]+-\d+$/.test(value)) throw new Error(`Invalid Jira issue key: ${key}`);
	return value;
}

async function jira<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
	const config = await readConfig();
	const response = await fetch(`${config.baseUrl}/rest/api/${config.apiVersion}${path}`, {
		...init,
		headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: authHeader(config), ...(init.headers ?? {}) },
		signal,
	});
	if (!response.ok) throw new Error(`Jira ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 500)}`);
	return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

async function fetchIssue(key: string, fields = DEFAULT_FIELDS, signal?: AbortSignal): Promise<JiraIssue> {
	return jira<JiraIssue>(`/issue/${encodeURIComponent(keyOf(key))}?fields=${encodeURIComponent(fields.join(","))}`, {}, signal);
}

async function readIssue(key: string, fields = DEFAULT_FIELDS, signal?: AbortSignal): Promise<{ issue: JiraIssue; fromMemory: boolean }> {
	const issueKey = keyOf(key);
	if (fields === DEFAULT_FIELDS && tickets[issueKey]) return { issue: tickets[issueKey], fromMemory: true };
	const issue = await fetchIssue(issueKey, fields, signal);
	if (fields === DEFAULT_FIELDS) {
		tickets[issueKey] = issue;
		await saveHermesMemory();
	}
	return { issue, fromMemory: false };
}

async function search(jql: string, fields = ["summary", "status", "issuetype", "priority", "assignee", "parent", "subtasks"], signal?: AbortSignal): Promise<JiraIssue[]> {
	const result = await jira<{ issues: JiraIssue[] }>("/search", { method: "POST", body: JSON.stringify({ jql, maxResults: 200, fields }) }, signal);
	return result.issues ?? [];
}

function text(value: any): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(text).filter(Boolean).join(", ");
	if (typeof value === "object") return value.displayName ?? value.name ?? value.value ?? value.text ?? (Array.isArray(value.content) ? value.content.map(text).filter(Boolean).join(" ") : "");
	return String(value);
}

function row(issue: JiraIssue, rel = ""): string {
	const f = issue.fields ?? {};
	return `${issue.key} — ${text(f.issuetype) || "Issue"} — ${text(f.status) || "unknown"} — ${text(f.assignee) || "Unassigned"} — ${text(f.summary)}${rel ? ` (${rel})` : ""}`;
}

function formatIssue(issue: JiraIssue): string {
	const f = issue.fields ?? {};
	const lines = [`${issue.key}: ${text(f.summary) || "(no summary)"}`, `Status: ${text(f.status) || "unknown"}`, `Type: ${text(f.issuetype) || "unknown"}`, `Priority: ${text(f.priority) || "none"}`, `Assignee: ${text(f.assignee) || "unassigned"}`, `Reporter: ${text(f.reporter) || "unknown"}`];
	const attachments = f.attachment ?? [];
	if (attachments.length) {
		const imageCount = attachments.filter((a: any) => isImage(a.mimeType)).length;
		lines.push(`Attachments: ${attachments.length}${imageCount ? ` (${imageCount} image${imageCount === 1 ? "" : "s"})` : ""}`);
	}
	const description = text(f.description).trim();
	if (description) lines.push("", "Description:", description.slice(0, 6000));
	return lines.join("\n");
}

async function transitions(key: string, signal?: AbortSignal): Promise<Transition[]> {
	return (await jira<{ transitions: Transition[] }>(`/issue/${encodeURIComponent(keyOf(key))}/transitions`, {}, signal)).transitions ?? [];
}

async function transition(key: string, transitionId: string, signal?: AbortSignal): Promise<void> {
	await jira<void>(`/issue/${encodeURIComponent(keyOf(key))}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: transitionId } }) }, signal);
}

async function relatedTickets(key: string, signal?: AbortSignal): Promise<JiraIssue[]> {
	const root = await fetchIssue(key, ["summary", "status", "issuetype", "priority", "assignee", "issuelinks", "subtasks", "parent"], signal);
	const seen = new Set([root.key]);
	const out: JiraIssue[] = [];
	const add = (issue?: JiraIssue) => { if (issue?.key && !seen.has(issue.key)) { seen.add(issue.key); out.push(issue); } };
	for (const link of root.fields?.issuelinks ?? []) add(link.outwardIssue ?? link.inwardIssue);
	for (const subtask of root.fields?.subtasks ?? []) add(subtask);
	add(root.fields?.parent);
	for (const issue of [...out]) {
		if (text(issue.fields?.issuetype) !== "Epic") continue;
		for (const child of await search(`parent = ${issue.key}`, undefined, signal).catch(() => [])) add(child);
		for (const child of await search(`\"Epic Link\" = ${issue.key}`, undefined, signal).catch(() => [])) add(child);
	}
	return out.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

async function epicTree(key: string, signal?: AbortSignal): Promise<string> {
	const epic = await fetchIssue(key, ["summary", "status", "issuetype", "assignee"], signal);
	const children = [...await search(`parent = ${epic.key}`, undefined, signal).catch(() => []), ...await search(`\"Epic Link\" = ${epic.key}`, undefined, signal).catch(() => [])]
		.filter((issue, index, all) => all.findIndex((other) => other.key === issue.key) === index)
		.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
	const lines = [row(epic)];
	for (const child of children) {
		lines.push(`├─ ${row(child)}`);
		for (const sub of child.fields?.subtasks ?? []) lines.push(`│  └─ ${row(sub)}`);
	}
	return lines.join("\n");
}

async function ticketTree(key: string, signal?: AbortSignal): Promise<string> {
	const issue = await fetchIssue(key, ["summary", "status", "issuetype", "assignee", "subtasks", "issuelinks"], signal);
	if (text(issue.fields?.issuetype) === "Epic") return epicTree(issue.key, signal);

	const lines = [row(issue)];
	for (const sub of issue.fields?.subtasks ?? []) lines.push(`├─ ${row(sub)}`);

	const epics = (await relatedTickets(issue.key, signal)).filter((i) => text(i.fields?.issuetype) === "Epic");
	for (const [index, epic] of epics.entries()) {
		const branch = index === epics.length - 1 ? "└─" : "├─";
		const pad = index === epics.length - 1 ? "   " : "│  ";
		const [head, ...tail] = (await epicTree(epic.key, signal)).split("\n");
		lines.push(`${branch} ${head}`);
		lines.push(...tail.map((line) => `${pad}${line}`));
	}
	return lines.join("\n");
}

function isImage(mime?: string): boolean {
	return !!mime && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime);
}

function attachmentLinks(issue: JiraIssue) {
	const attachments = issue.fields?.attachment ?? [];
	if (!attachments.length) return { text: `${issue.key}: no attachments`, attachments: [] };
	const lines = [`${issue.key}: ${attachments.length} attachment(s)`];
	const linked = attachments.map((attachment: any) => ({ filename: attachment.filename, mimeType: attachment.mimeType, url: attachment.content }));
	for (const attachment of linked) lines.push(`- ${attachment.filename} (${attachment.mimeType ?? "unknown"}) -> ${attachment.url}`);
	return { text: lines.join("\n"), attachments: linked };
}

async function ticketAttachments(key: string, signal?: AbortSignal): Promise<string> {
	const issueKey = keyOf(key);
	return attachmentLinks(tickets[issueKey] ?? await fetchIssue(issueKey, ["summary", "attachment"], signal)).text;
}

function allStatuses(): string[] {
	return [...new Set([...workflow.keys(), ...[...workflow.values()].flat()])].filter(Boolean).sort();
}

async function refreshWorkflow(project = defaultProject, signal?: AbortSignal): Promise<string> {
	workflow.clear();
	const issues = await search(`project = ${project} ORDER BY updated DESC`, ["status"], signal);
	const seenStatuses = new Set<string>();
	for (const issue of issues) {
		const from = text(issue.fields?.status);
		if (!from || seenStatuses.has(from)) continue;
		seenStatuses.add(from);
		workflow.set(from, (await transitions(issue.key, signal)).map((t) => text(t.to)).filter(Boolean));
	}
	return [...workflow.entries()].map(([from, tos]) => `${from} -> ${tos.join(", ") || "(none)"}`).join("\n");
}

async function fetchProjectPeople(project = defaultProject, signal?: AbortSignal): Promise<JiraUser[]> {
	const roles = await jira<Record<string, string>>(`/project/${encodeURIComponent(project)}/role`, {}, signal);
	const byName = new Map<string, JiraUser>();

	for (const roleUrl of Object.values(roles)) {
		const role = await jira<{ actors?: Array<JiraUser & { type?: string }> }>(roleUrl.replace(/^.*\/rest\/api\/\d+/, ""), {}, signal);
		for (const actor of role.actors ?? []) {
			// Project groups like ho_it_jira_user expand to thousands of people; keep direct project members only.
			if (actor.type !== "atlassian-user-role-actor" || !actor.name) continue;
			byName.set(actor.name, actor);
		}
	}

	people = [...byName.values()].sort((a, b) => (a.displayName ?? a.name ?? "").localeCompare(b.displayName ?? b.name ?? ""));
	return people;
}

function projectPeople(): JiraUser[] {
	return people;
}

function userId(user: JiraUser): string {
	return user.name ?? user.key ?? user.emailAddress ?? user.displayName ?? "";
}

function findPerson(input?: string): JiraUser | undefined {
	if (!input) return undefined;
	const q = input.toLowerCase();
	return people.find((u) => [u.name, u.key, u.emailAddress, u.displayName].some((v) => v?.toLowerCase() === q))
		?? people.find((u) => [u.name, u.key, u.emailAddress, u.displayName].some((v) => v?.toLowerCase().includes(q)));
}

async function assignTicket(key: string, person?: string, signal?: AbortSignal): Promise<string> {
	let account = person?.trim();
	if (!account) {
		const me = await jira<JiraUser>("/myself", {}, signal);
		account = userId(me);
		person = me.displayName ?? account;
	} else {
		const found = findPerson(account);
		account = found ? userId(found) : account;
		person = found?.displayName ?? person;
	}
	await jira<void>(`/issue/${encodeURIComponent(keyOf(key))}/assignee`, { method: "PUT", body: JSON.stringify({ name: account }) }, signal);
	return `${keyOf(key)} assigned to ${person}`;
}

function pathTo(from: string, to: string): string[] | undefined {
	const wanted = to.toLowerCase();
	const queue = [[from]];
	const seen = new Set([from]);
	while (queue.length) {
		const path = queue.shift()!;
		for (const next of workflow.get(path.at(-1)!) ?? []) {
			if (seen.has(next)) continue;
			const candidate = [...path, next];
			if (next.toLowerCase() === wanted) return candidate;
			seen.add(next);
			queue.push(candidate);
		}
	}
}

async function markTicket(key: string, target: string, signal?: AbortSignal): Promise<string> {
	const steps: string[] = [];
	let issue = await fetchIssue(key, ["summary", "status"], signal);
	while (text(issue.fields?.status).toLowerCase() !== target.toLowerCase()) {
		const available = await transitions(issue.key, signal);
		let next = available.find((t) => text(t.to).toLowerCase() === target.toLowerCase() || t.name.toLowerCase() === target.toLowerCase());
		if (!next) {
			const nextStatus = pathTo(text(issue.fields?.status), target)?.[1];
			if (nextStatus) next = available.find((t) => text(t.to).toLowerCase() === nextStatus.toLowerCase());
		}
		if (!next) throw new Error(`No transition path from ${text(issue.fields?.status)} to ${target}. Available: ${available.map((t) => `${t.name} -> ${text(t.to)}`).join(", ")}`);
		steps.push(`${text(issue.fields?.status)} -> ${text(next.to) || next.name}`);
		await transition(issue.key, next.id, signal);
		issue = await fetchIssue(issue.key, ["summary", "status"], signal);
	}
	return `${issue.key}: ${text(issue.fields?.summary)}\n${steps.join("\n")}\nNow: ${text(issue.fields?.status)}`;
}

function parseStatusPerson(input: string): { status: string; person?: string } {
	const statuses = allStatuses().sort((a, b) => b.length - a.length);
	const exact = statuses.find((s) => input.toLowerCase() === s.toLowerCase());
	if (exact) return { status: exact };
	const prefix = statuses.find((s) => input.toLowerCase().startsWith(`${s.toLowerCase()} `));
	if (prefix) return { status: prefix, person: input.slice(prefix.length).trim() || undefined };
	const parts = input.trim().split(/\s+/);
	const maybePerson = parts.at(-1) ?? "";
	if (maybePerson.includes(".") || maybePerson.includes("@")) return { status: parts.slice(0, -1).join(" "), person: maybePerson };
	return { status: input.trim() };
}

async function refreshAll(project = defaultProject, signal?: AbortSignal): Promise<string> {
	const [wf, users] = await Promise.all([refreshWorkflow(project, signal), fetchProjectPeople(project, signal)]);
	defaultProject = project;
	await saveHermesMemory();
	return `Workflow:\n${wf}\n\nPeople (${users.length}):\n${users.map((u) => `${u.displayName ?? userId(u)} (${userId(u)})`).join("\n")}\n\nSaved locally to ${HERMES_MEMORY_PATH}`;
}

function matchingPeople(q: string) {
	const query = q.toLowerCase();
	return people.filter((u) => `${u.displayName ?? ""} ${u.name ?? ""} ${u.emailAddress ?? ""}`.toLowerCase().includes(query)).slice(0, 20);
}

function transitionCompletions(prefix: string) {
	const match = prefix.match(/^([A-Z][A-Z0-9]+-\d+)\s*(.*)$/i);
	if (!match) return null;
	const key = match[1].toUpperCase();
	const rest = match[2] ?? "";
	const statuses = allStatuses();
	for (const status of statuses.sort((a, b) => b.length - a.length)) {
		if (rest.toLowerCase().startsWith(`${status.toLowerCase()} `)) {
			const q = rest.slice(status.length).trim();
			return matchingPeople(q).map((u) => ({ value: `${key} ${status} ${userId(u)}`, label: userId(u), description: u.displayName }));
		}
	}
	return statuses.filter((s) => s.toLowerCase().includes(rest.toLowerCase())).slice(0, 20).map((s) => ({ value: `${key} ${s}`, label: s, description: "Jira status" }));
}

function assignCompletions(prefix: string) {
	const match = prefix.match(/^([A-Z][A-Z0-9]+-\d+)\s*(.*)$/i);
	if (!match) return null;
	const key = match[1].toUpperCase();
	const q = match[2] ?? "";
	return matchingPeople(q).map((u) => ({ value: `${key} ${userId(u)}`, label: userId(u), description: u.displayName }));
}

export default function (pi: ExtensionAPI) {
	const textResult = (text: string, details: any = {}) => ({ content: [{ type: "text" as const, text }], details });
	pi.on("session_start", () => { void loadHermesMemory().catch(() => undefined); });

	pi.registerTool({ name: "jira_read_ticket", label: "Jira Ticket", description: "Read a Jira ticket by issue key from local pi-hermes-memory when available; otherwise fetch from Jira and save it locally. If the ticket has attachments, includes a count and clickable attachment URLs.", promptSnippet: "Read Jira tickets by issue key, e.g. ABC-1234", promptGuidelines: ["Use jira_read_ticket when the user asks to read or inspect a Jira issue key. Check whether the result says it came from local pi-hermes-memory, and share attachment URLs when present."], parameters: Type.Object({ issueKey: Type.String(), fields: Type.Optional(Type.Array(Type.String())) }), async execute(_id, p, signal) { const { issue, fromMemory } = await readIssue(p.issueKey, p.fields?.length ? [...new Set([...p.fields, "attachment"])] : DEFAULT_FIELDS, signal); const prefix = fromMemory ? "(from local pi-hermes-memory)\n" : ""; const attachmentCount = issue.fields?.attachment?.length ?? 0; if (!attachmentCount) return textResult(prefix + formatIssue(issue), { issue, fromMemory }); const attachments = attachmentLinks(issue); return { content: [{ type: "text" as const, text: `${prefix}${formatIssue(issue)}\n\n${attachments.text}` }], details: { issue, fromMemory, attachments: attachments.attachments } }; } });
	pi.registerTool({ name: "jira_related_tickets", label: "Jira Related", description: "Retrieve linked/subtask/parent tickets and child tickets under linked epics.", parameters: Type.Object({ issueKey: Type.String() }), async execute(_id, p, signal) { const issues = await relatedTickets(p.issueKey, signal); return textResult(`${issues.length} related ticket(s)\n` + issues.map((i) => row(i)).join("\n"), { issues }); } });
	pi.registerTool({ name: "jira_ticket_attachments", label: "Jira Attachments", description: "List Jira ticket attachment filenames and clickable URLs, using local pi-hermes-memory when available.", parameters: Type.Object({ issueKey: Type.String() }), async execute(_id, p, signal) { const issueKey = keyOf(p.issueKey); const issue = tickets[issueKey] ?? await fetchIssue(issueKey, ["summary", "attachment"], signal); const attachments = attachmentLinks(issue); return { content: [{ type: "text" as const, text: attachments.text }], details: { attachments: attachments.attachments } }; } });
	pi.registerTool({ name: "jira_ticket_images", label: "Jira Images", description: "Deprecated alias for jira_ticket_attachments.", parameters: Type.Object({ issueKey: Type.String() }), async execute(_id, p, signal) { const issueKey = keyOf(p.issueKey); const issue = tickets[issueKey] ?? await fetchIssue(issueKey, ["summary", "attachment"], signal); const attachments = attachmentLinks(issue); return { content: [{ type: "text" as const, text: attachments.text }], details: { attachments: attachments.attachments } }; } });
	pi.registerTool({ name: "jira_epic_tree", label: "Jira Tree", description: "Create a tree of an epic or a ticket with linked epics.", parameters: Type.Object({ epicKey: Type.String() }), async execute(_id, p, signal) { return textResult(await ticketTree(p.epicKey, signal)); } });
	pi.registerTool({ name: "jira_transition_ticket", label: "Jira Transition", description: "Move a Jira ticket to a target status. Optionally assign it to a person after transition.", parameters: Type.Object({ issueKey: Type.String(), status: Type.String(), person: Type.Optional(Type.String()) }), async execute(_id, p, signal) { const out = [await markTicket(p.issueKey, p.status, signal)]; if (p.person) out.push(await assignTicket(p.issueKey, p.person, signal)); return textResult(out.join("\n")); } });
	pi.registerTool({ name: "jira_assign_ticket", label: "Jira Assign", description: "Assign a Jira ticket to yourself or another project person.", parameters: Type.Object({ issueKey: Type.String(), person: Type.Optional(Type.String()) }), async execute(_id, p, signal) { return textResult(await assignTicket(p.issueKey, p.person, signal)); } });
	pi.registerTool({ name: "jira_project_people", label: "Jira People", description: "List direct people saved in local pi-hermes-memory. Run jira_update_workflow to refresh from Jira.", parameters: Type.Object({ projectKey: Type.Optional(Type.String()) }), async execute(_id, _p) { const users = projectPeople(); return textResult(users.length ? users.map((u) => `${u.displayName ?? userId(u)} (${userId(u)})`).join("\n") : `No people in local pi-hermes-memory yet. Run jira_update_workflow or /jira-update to refresh.`, { users, memoryPath: HERMES_MEMORY_PATH }); } });
	pi.registerTool({ name: "jira_update_workflow", label: "Jira Workflow Update", description: "Refresh Jira workflow transitions and direct project people, then save them in local pi-hermes-memory.", parameters: Type.Object({ projectKey: Type.Optional(Type.String()) }), async execute(_id, p, signal) { return textResult(await refreshAll(p.projectKey ?? defaultProject, signal)); } });

	pi.registerCommand("jira", { description: "Read a Jira ticket: /jira ABC-1234", handler: async (args, ctx) => {
		const key = args.trim() || (ctx.hasUI ? await ctx.ui.input("Jira issue key", "ABC-1234") : undefined);
		if (!key) return;
		const { issue, fromMemory } = await readIssue(key, DEFAULT_FIELDS, ctx.signal);
		let output = `${fromMemory ? "(from local pi-hermes-memory)\n" : ""}${formatIssue(issue)}`;
		if (issue.fields?.attachment?.length) output += `\n\n${attachmentLinks(issue).text}`;
		pi.sendMessage({ customType: "jira", content: output, display: true });
	} });

	pi.registerCommand("jira-transition", { description: "Transition a Jira ticket and optionally assign: /jira-transition ABC-1234 In Progress [matthew.copas]", getArgumentCompletions: transitionCompletions, handler: async (args, ctx) => {
		const [key, ...actionParts] = args.trim().split(/\s+/);
		const action = actionParts.join(" ").trim();
		if (!key || !action) throw new Error("Usage: /jira-transition ABC-1234 <status> [person]");
		const { status, person } = parseStatusPerson(action);
		let output = await markTicket(key, status, ctx.signal);
		if (person) output += `\n${await assignTicket(key, person, ctx.signal)}`;
		pi.sendMessage({ customType: "jira", content: output, display: true });
	} });

	pi.registerCommand("jira-assign", { description: "Assign Jira ticket to yourself or a project person: /jira-assign ABC-1234 [matthew.copas]", getArgumentCompletions: assignCompletions, handler: async (args, ctx) => {
		const [key, ...personParts] = args.trim().split(/\s+/);
		if (!key) throw new Error("Usage: /jira-assign ABC-1234 [person]");
		pi.sendMessage({ customType: "jira", content: await assignTicket(key, personParts.join(" ") || undefined, ctx.signal), display: true });
	} });
	pi.registerCommand("jira-related", { description: "List tickets related to a Jira ticket: /jira-related ABC-1234", handler: async (args, ctx) => pi.sendMessage({ customType: "jira", content: (await relatedTickets(args.trim(), ctx.signal)).map((i) => row(i)).join("\n"), display: true }) });
	pi.registerCommand("jira-tree", { description: "Show an epic/ticket tree: /jira-tree ABC-1234", handler: async (args, ctx) => pi.sendMessage({ customType: "jira", content: await ticketTree(args.trim(), ctx.signal), display: true }) });
	pi.registerCommand("jira-attachments", { description: "List Jira ticket attachment URLs: /jira-attachments ABC-1234", handler: async (args, ctx) => pi.sendMessage({ customType: "jira", content: await ticketAttachments(args.trim(), ctx.signal), display: true }) });
	pi.registerCommand("jira-people", { description: "List assignable Jira project people from local pi-hermes-memory", handler: async (_args, _ctx) => pi.sendMessage({ customType: "jira", content: people.length ? people.map((u) => `${u.displayName ?? userId(u)} (${userId(u)})`).join("\n") : `No people in local pi-hermes-memory yet. Run /jira-update to refresh.`, display: true }) });
	pi.registerCommand("jira-update", {
    description: "Refresh Jira workflow/person memory",
    handler: async (args, ctx) =>
        pi.sendMessage({
            customType: "jira",
            content: await refreshAll(args.trim() || defaultProject, ctx.signal),
            display: true
        })
});
}
