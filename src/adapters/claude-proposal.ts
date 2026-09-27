/** Accept the one JSON Markdown wrapper observed from Claude Code; preserve strict inner patch validation. */
export function unwrapClaudeProposal(text: string): string {
  const match = /^```json\n([\s\S]*?)\n```$/.exec(text.trim());
  return match?.[1] ?? text;
}
