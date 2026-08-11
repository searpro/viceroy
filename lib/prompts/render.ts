/**
 * Flat `{{name}}` substitution — no loops or conditionals in the syntax.
 *
 * Calling code is responsible for building any repeated section (a scene list,
 * a character roster) and passing it in as one already-joined string. Adding
 * control flow here would make templates a language, and the editor's whole
 * value is that a non-programmer can safely change one.
 *
 * An unmatched `{{name}}` is left in place rather than silently dropped, so a
 * typo shows up in the generated prompt instead of vanishing into it.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in vars ? vars[name]! : match,
  );
}

/** The `{{name}}` placeholders a template actually uses, in first-seen order. */
export function templateVariables(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(/\{\{(\w+)\}\}/g)) seen.add(match[1]!);
  return [...seen];
}

/**
 * Placeholders a template references that the caller does not supply.
 *
 * Used to fail a stage before it spends a minute of inference producing a
 * prompt with a literal `{{synopsis}}` sitting in the middle of it.
 */
export function missingVariables(template: string, vars: Record<string, string>): string[] {
  return templateVariables(template).filter((name) => !(name in vars));
}
