import type { ReactNode } from "react";

export default function WorkspaceHeader({ title, description, status, actions, level = 1 }: {
  title: ReactNode; description?: ReactNode; status?: ReactNode; actions?: ReactNode; level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <header className="workspace-header">
      <div className="min-w-0">
        <Heading>{title}</Heading>
        {(status || description) && <div className="workspace-header-meta">
          {status}
          {description && <p className={status ? "hidden sm:block" : undefined}>{description}</p>}
        </div>}
      </div>
      {actions && <div className="workspace-header-actions">{actions}</div>}
    </header>
  );
}
