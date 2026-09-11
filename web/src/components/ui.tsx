/**
 * The handful of building blocks every page uses. Hand-built on Tailwind:
 * a dozen components is not worth a component library's setup and weight.
 */

import React, { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import { useI18n } from "../i18n/index.tsx";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// --- Button -----------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 shadow-sm disabled:bg-brand-600/50",
  secondary: "bg-white text-zinc-800 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800",
  ghost: "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
  danger: "bg-red-600 text-white hover:bg-red-700 shadow-sm disabled:bg-red-600/50",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, icon, className, children, disabled, type, ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-60",
        // Minimum heights, not fixed ones: a label that wraps (French runs
        // long) grows the button instead of spilling out of it.
        size === "sm" ? "min-h-8 px-3 py-1 text-sm" : "min-h-10 px-4 py-2 text-sm",
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// --- Form field -------------------------------------------------------------

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, className, id, ...rest }, ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className={cx("space-y-1.5", className)}>
      <label htmlFor={inputId} className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          "block h-10 w-full rounded-lg border bg-white px-3 text-sm text-zinc-900 shadow-sm",
          "placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-600/40",
          "dark:bg-zinc-900 dark:text-zinc-100",
          error ? "border-red-500" : "border-zinc-300 dark:border-zinc-700",
        )}
        {...rest}
      />
      {error ? (
        <p id={`${inputId}-error`} className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
      ) : null}
    </div>
  );
});

// --- Surfaces ---------------------------------------------------------------

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900", className)}>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

type Tone = "neutral" | "green" | "amber" | "red" | "blue";
const tones: Record<Tone, string> = {
  neutral: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  green: "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200",
  amber: "bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200",
  red: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  blue: "bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-3 text-zinc-400 dark:text-zinc-500">{icon}</div>}
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      {body && <p className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Alert({ tone = "red", children }: { tone?: "red" | "amber" | "green" | "blue"; children: ReactNode }) {
  const styles = {
    red: "border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200",
    amber: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200",
    green: "border-brand-200 bg-brand-50 text-brand-900 dark:border-brand-900/50 dark:bg-brand-900/30 dark:text-brand-100",
    blue: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-200",
  }[tone];
  return <div role={tone === "red" ? "alert" : "status"} className={cx("rounded-lg border px-3 py-2.5 text-sm", styles)}>{children}</div>;
}

// --- More form controls -----------------------------------------------------

const controlBase =
  "block w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 shadow-sm " +
  "placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-600/40 " +
  "dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

interface LabelledProps { label: string; hint?: string | undefined; className?: string | undefined; children: (id: string, describedBy: string | undefined) => ReactNode }

function Labelled({ label, hint, className, children }: LabelledProps) {
  const id = useId();
  return (
    <div className={cx("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</label>
      {children(id, hint ? `${id}-hint` : undefined)}
      {hint && <p id={`${id}-hint`} className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}

export function TextArea({ label, hint, className, rows = 3, ...rest }:
  { label: string; hint?: string; className?: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Labelled label={label} hint={hint} className={className}>
      {(id, d) => <textarea id={id} aria-describedby={d} rows={rows} className={cx(controlBase, "py-2 leading-relaxed")} {...rest} />}
    </Labelled>
  );
}

export function Select({ label, hint, className, children, ...rest }:
  { label: string; hint?: string; className?: string; children: ReactNode } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Labelled label={label} hint={hint} className={className}>
      {(id, d) => <select id={id} aria-describedby={d} className={cx(controlBase, "h-10 pr-8")} {...rest}>{children}</select>}
    </Labelled>
  );
}

// --- Modal / drawer ---------------------------------------------------------

/**
 * A dialog: centred, or a panel from the right edge (`side`). Full screen on
 * a phone either way. Escape and the backdrop close it; focus moves in on
 * open and back to whatever opened it on close; the page behind stops
 * scrolling.
 */
export function Modal({ open, onClose, title, children, footer, side = false, wide = false }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; side?: boolean; wide?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // The first field if there is one, else the panel itself.
    const first = panel.current?.querySelector<HTMLElement>("input, select, textarea");
    (first ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
    // onClose changes identity every render; re-running would steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return (
    <div className={cx("fixed inset-0 z-50 flex", side ? "justify-end" : "items-center justify-center sm:p-4")}>
      <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={cx(
          "relative flex h-full w-full flex-col bg-white shadow-xl outline-none dark:bg-zinc-900",
          side ? "sm:max-w-md sm:border-l sm:border-zinc-200 dark:sm:border-zinc-800"
            : cx("sm:h-auto sm:max-h-[90dvh] sm:rounded-xl", wide ? "sm:max-w-2xl" : "sm:max-w-lg"),
        )}>
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <h2 id={titleId} className="min-w-0 truncate text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t("common.close")}
            className="grid size-9 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-zinc-800">{footer}</div>}
      </div>
    </div>
  );
}

/** An on/off switch with its label - a real checkbox underneath, so it is keyboard- and screen-reader-native. */
export function Switch({ checked, onChange, label, hint, disabled }:
  { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx("flex items-start gap-3", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input id={id} type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled}
          onChange={(e) => onChange(e.target.checked)} />
        <span className="h-6 w-11 rounded-full bg-zinc-300 transition-colors peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-600/50 peer-focus-visible:ring-offset-2 dark:bg-zinc-700 dark:peer-focus-visible:ring-offset-zinc-900" />
        <span className="absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>}
      </span>
    </label>
  );
}
