import { useFormFieldId } from "@/components/ui/form-field";
import * as React from "react"
import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => {
  const fieldId = useFormFieldId();
  return <textarea data-slot="textarea" id={fieldId} className={cn("flex min-h-[80px] w-full rounded-[10px] border border-input bg-background px-3 py-2 text-[16px] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", className)} ref={ref} {...props} />
})
Textarea.displayName = "Textarea"

export { Textarea }
