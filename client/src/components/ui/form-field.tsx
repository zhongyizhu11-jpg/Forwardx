import { createContext, useContext, useId, type HTMLAttributes } from "react";

const FieldIdContext = createContext<string | undefined>(undefined);

/** Scope one label and one control, including repeated fields in resource forms. */
export function FormField({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const id = useId();
  return <FieldIdContext.Provider value={`field-${id}`}><div {...props}>{children}</div></FieldIdContext.Provider>;
}

export function useFormFieldId() { return useContext(FieldIdContext); }
