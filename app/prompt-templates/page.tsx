import { getDb } from "@/lib/db/client";
import { listPromptTemplates } from "@/lib/promptTemplates";
import { PromptTemplatesView } from "./prompt-templates-view";

export const dynamic = "force-dynamic";

/**
 * `?key=` opens one template directly.
 *
 * The Traces screen names the template a prompt was rendered from, and the
 * only useful next step from there is to edit it — across 34 templates in
 * eight sections, "go and find dev.screenplay_evaluate yourself" is a long way
 * from a one-click answer.
 */
export default async function PromptTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { key } = await searchParams;
  const initialKey = Array.isArray(key) ? key[0] : key;

  return (
    <PromptTemplatesView templates={listPromptTemplates(getDb())} initialKey={initialKey ?? null} />
  );
}
