export function Panel({
  title,
  empty,
  emptyText,
  children,
}: {
  title: string;
  empty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">{title}</h2>
      <div className="mt-3">
        {empty ? <p className="text-sm text-white/35">{emptyText}</p> : children}
      </div>
    </section>
  );
}
