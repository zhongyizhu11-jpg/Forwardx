import { Link } from "wouter";
import { FileQuestion } from "lucide-react";
import EmptyState from "@/components/EmptyState";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return <main className="flex min-h-svh items-center justify-center bg-background p-4">
    <section className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm">
      <h1 className="text-center text-4xl font-semibold tracking-tight">404</h1>
      <EmptyState icon={<FileQuestion />} title="页面未找到" description="地址可能已变更，或此页面已被移除。"
        actions={<Button asChild><Link href="/">返回首页</Link></Button>} />
    </section>
  </main>;
}
