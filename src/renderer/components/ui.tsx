import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconChevron, IconX } from "../lib/icons.js";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Close a floating layer on outside pointer-down or Escape. */
function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}

interface DropdownProps {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: "top" | "bottom";
  align?: "start" | "end";
  panelClass?: string;
  disabled?: boolean;
  title?: string;
}

/** Custom popover menu — the native <select> is not stylable enough to fit in. */
export function Dropdown({
  label,
  children,
  placement = "top",
  align = "start",
  panelClass,
  disabled,
  title,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition",
          "text-mist-300 hover:bg-ink-750 hover:text-mist-100",
          open && "bg-ink-750 text-mist-100",
          disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
        )}
      >
        {label}
        <IconChevron className={cx("h-3.5 w-3.5 transition", open && "rotate-180")} />
      </button>
      {open && (
        <div
          className={cx(
            "absolute z-50 min-w-56 overflow-hidden rounded-xl border border-ink-700 bg-ink-850 p-1 shadow-2xl shadow-black/60",
            placement === "top" ? "bottom-full mb-2" : "top-full mt-2",
            align === "end" ? "right-0" : "left-0",
            panelClass,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  selected,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  selected?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition",
        danger ? "text-rose-soft hover:bg-rose-soft/10" : "text-mist-200 hover:bg-ink-750",
        selected && "bg-ink-750 text-mist-100",
      )}
    >
      {children}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-mist-500 uppercase">
      {children}
    </div>
  );
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: string;
}

export function Modal({ open, onClose, title, children, width = "max-w-3xl" }: ModalProps) {
  const ref = useDismiss(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div
        ref={ref}
        className={cx(
          "animate-fade-up flex max-h-[85vh] w-full flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl shadow-black/70",
          width,
        )}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-ink-800 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-mist-100">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-mist-400 transition hover:bg-ink-800 hover:text-mist-100"
            >
              <IconX />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "ghost",
  size = "md",
  disabled,
  type = "button",
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "outline" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  const variants = {
    primary: "bg-iris-600 text-white hover:bg-iris-500 shadow-lg shadow-iris-600/20",
    ghost: "text-mist-300 hover:bg-ink-800 hover:text-mist-100",
    outline: "border border-ink-700 text-mist-200 hover:border-ink-600 hover:bg-ink-800",
    danger: "border border-rose-soft/40 text-rose-soft hover:bg-rose-soft/10",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-[13px]",
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  type = "text",
  mono,
  onEnter,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "number";
  mono?: boolean;
  onEnter?: () => void;
  autoFocus?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) onEnter();
      }}
      className={cx(
        "w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[13px] text-mist-100 outline-none transition",
        "placeholder:text-mist-500 focus:border-iris-500/70 focus:ring-2 focus:ring-iris-500/15",
        mono && "font-mono text-xs",
      )}
    />
  );
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-[22px] w-[38px] shrink-0 rounded-full transition",
        checked ? "bg-iris-600" : "bg-ink-700",
      )}
    >
      <span
        className={cx(
          "absolute top-[3px] h-4 w-4 rounded-full bg-white transition-all",
          checked ? "left-[19px]" : "left-[3px]",
        )}
      />
    </button>
  );
}

/** One labelled row in the settings panel. */
export function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-ink-800 py-4 last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-mist-100">{title}</div>
        {description && <p className="mt-1 text-xs leading-relaxed text-mist-400">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-ink-700 bg-ink-850 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cx(
            "rounded-md px-3 py-1.5 text-xs font-medium transition",
            value === option.value
              ? "bg-ink-700 text-mist-100"
              : "text-mist-400 hover:text-mist-200",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
