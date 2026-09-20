/** Shared text-result shape for the worker agents' registered tools. */
export type ToolText = { content: { type: "text"; text: string }[]; details: unknown };

export function ok(text: string, details: unknown = {}): ToolText {
	return { content: [{ type: "text" as const, text }], details };
}

export function fail(text: string): ToolText {
	return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: { error: true } };
}
