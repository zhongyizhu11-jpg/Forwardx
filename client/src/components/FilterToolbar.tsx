import { useId, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function FilterToolbar({ search, children, activeCount = 0 }: {
  search: ReactNode; children?: ReactNode; activeCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="workspace-filter">
      <div className="workspace-filter-search">{search}</div>
      {children && <>
        <Button type="button" variant={open || activeCount > 0 ? "secondary" : "outline"}
          className="gap-2 sm:hidden" aria-expanded={open} aria-controls={id}
          onClick={() => setOpen(!open)}>
          <SlidersHorizontal className="h-4 w-4" />筛选{activeCount > 0 && <span className="tabular-nums">{activeCount}</span>}
        </Button>
        <div id={id} className={cn("workspace-filter-options", open ? "flex" : "hidden sm:flex")}>
          {children}
        </div>
      </>}
    </div>
  );
}
