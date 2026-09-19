import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, LayoutGrid, Search, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export type WorkspaceDestination = {
  path: string;
  label: string;
  icon: LucideIcon;
  externalUrl?: string;
  group?: string;
};

/** Receives the same permission-filtered destinations as the sidebar. */
export function WorkspaceCommand({ open, onOpenChange, items, currentPath, onNavigate }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: WorkspaceDestination[];
  currentPath: string;
  onNavigate: (item: WorkspaceDestination) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = items.filter(item => terms.every(term => `${item.label} ${item.path} ${item.group || ""}`.toLocaleLowerCase().includes(term)));
  const selected = Math.min(active, Math.max(0, matches.length - 1));

  useEffect(() => { if (open) { setQuery(""); setActive(0); } }, [open]);
  useEffect(() => {
    if (open) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, selected, query]);
  const choose = (item: WorkspaceDestination) => { onOpenChange(false); onNavigate(item); };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="workspace-command" onOpenAutoFocus={event => {
      event.preventDefault();
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      inputRef.current?.focus();
    }} onCloseAutoFocus={event => {
      event.preventDefault();
      if (triggerRef.current?.isConnected && triggerRef.current.getClientRects().length) triggerRef.current.focus();
      else document.getElementById("workspace-content")?.focus();
    }}>
      <DialogTitle className="sr-only">查找功能</DialogTitle>
      <DialogDescription className="sr-only">输入名称查找可用功能，用方向键选择，回车打开，Escape 关闭。</DialogDescription>
      <div className="workspace-command-input">
        <Search size={18} aria-hidden="true" />
        <input ref={inputRef} value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
          role="combobox" aria-label="查找功能" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={matches.length ? `${listId}-${selected}` : undefined}
          autoComplete="off" placeholder="搜索功能名称…"
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(matches.length ? (selected + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length : 0);
            } else if (event.key === "Enter" && matches[selected]) { event.preventDefault(); choose(matches[selected]); }
          }} />
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label="可用功能" className="workspace-command-results">
        {matches.map((item, index) => <button type="button" key={item.path} id={`${listId}-${index}`}
          role="option" aria-selected={selected === index} tabIndex={-1}
          onPointerMove={() => setActive(index)} onClick={() => choose(item)}>
          <item.icon size={18} aria-hidden="true" />
          <span className="min-w-0 flex-1"><span className="block truncate">{item.label}</span><small>{item.group}</small></span>
          {item.externalUrl ? <ArrowUpRight size={16} aria-label="新窗口" /> : currentPath === item.path ? <small>当前页面</small> : null}
        </button>)}
      </div>
      {!matches.length && <p role="status" className="workspace-command-empty">没有找到相关功能，试试“转发”或“主机”。</p>}
      <div className="workspace-command-footer"><span>↑ ↓ 选择 · Enter 打开</span><span>{matches.length} 项功能</span></div>
    </DialogContent>
  </Dialog>;
}

export function WorkspaceMobileNav({ items, currentPath, onNavigate, onMore, moreOpen = false }: {
  items: WorkspaceDestination[];
  currentPath: string;
  onNavigate: (item: WorkspaceDestination) => void;
  onMore: () => void;
  moreOpen?: boolean;
}) {
  const destinations = items.slice(0, 4);
  return <nav aria-label="快捷导航" className="workspace-mobile-nav" style={{ gridTemplateColumns: `repeat(${destinations.length + 1}, minmax(0, 1fr))` }}>
    {destinations.map(item => <a key={item.path} href={item.path} aria-current={currentPath === item.path ? "page" : undefined}
      onClick={event => { if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate(item); } }}>
      <item.icon size={20} aria-hidden="true" /><span>{item.label}</span>
    </a>)}
    <button type="button" onClick={onMore} aria-expanded={moreOpen} aria-label="打开全部导航"><LayoutGrid size={20} aria-hidden="true" /><span>全部</span></button>
  </nav>;
}
