import { getDb } from "@/lib/db/client";
import { listProviders } from "@/lib/providers";
import { listWorkflows } from "@/lib/workflows";
import { ProvidersView } from "./providers-view";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  const db = getDb();
  return <ProvidersView providers={listProviders(db)} workflows={listWorkflows(db)} />;
}
