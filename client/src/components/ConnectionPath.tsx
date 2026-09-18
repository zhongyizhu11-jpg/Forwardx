import type { ReactNode } from "react";
import { ArrowDown } from "lucide-react";

export type ConnectionStep = { label: string; content: ReactNode; key?: string };

/** Labels remain visible on narrow screens and with long IPv6 addresses. */
export default function ConnectionPath({ steps }: { steps: ConnectionStep[] }) {
  return (
    <ol className="connection-path" aria-label="转发路径">
      {steps.map((step, index) => (
        <li key={step.key ?? index} className="connection-step">
          <span className="connection-rail" aria-hidden="true">
            <span className="connection-node" />
            {index < steps.length - 1 && <ArrowDown className="connection-arrow h-3 w-3" />}
          </span>
          <div className="min-w-0 flex-1">
            <span className="connection-label">{step.label}</span>
            <div className="connection-value">{step.content}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
