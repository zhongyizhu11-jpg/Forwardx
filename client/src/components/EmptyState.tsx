import type { ReactNode } from "react";

export default function EmptyState({ icon, title, description, actions }: {
  icon?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode;
}) {
  return <div className="empty-state">
    {icon && <div className="empty-state-icon" aria-hidden="true">{icon}</div>}
    <div className="space-y-2"><h2>{title}</h2>{description && <p>{description}</p>}</div>
    {actions && <div className="flex flex-wrap justify-center gap-2">{actions}</div>}
  </div>;
}
