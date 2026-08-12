import { getDb } from "@/lib/db/client";
import { listPromptTemplates } from "@/lib/promptTemplates";
import { PromptTemplatesView } from "./prompt-templates-view";

export const dynamic = "force-dynamic";

export default async function PromptTemplatesPage() {
  return <PromptTemplatesView templates={listPromptTemplates(getDb())} />;
}
