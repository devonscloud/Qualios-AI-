import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "primary" | "secondary";
}

/** Minimal shared button. A real design system lands with the product UI. */
export function Button({ children, variant = "primary", ...props }: ButtonProps) {
  return (
    <button data-variant={variant} type="button" {...props}>
      {children}
    </button>
  );
}
