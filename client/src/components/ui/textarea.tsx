import { useFormFieldId } from "@/components/ui/form-field";
import * as React from "react"
import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => {
  const fieldId = useFormFieldId();
  return <textarea data-slot="textarea" id={fieldId} className={cn("flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-[14px] leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50", className)} ref={ref} {...props} />
})
Textarea.displayName = "Textarea"

export { Textarea }
