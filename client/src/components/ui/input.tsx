import { useFormFieldId } from "@/components/ui/form-field";
import * as React from "react"
import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type, ...props }, ref) => {
  const fieldId = useFormFieldId();
  return <input data-slot="input" id={fieldId} type={type} className={cn("flex h-10 w-full rounded-[10px] border border-input bg-background px-3 py-2 text-[16px] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", className)} ref={ref} {...props} />
})
Input.displayName = "Input"

export { Input }
