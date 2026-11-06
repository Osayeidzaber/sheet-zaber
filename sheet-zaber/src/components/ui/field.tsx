"use client"

import { useId } from "react"

import { cn } from "@/lib/cn"

/**
 * Form controls follow the reference: 16px text (no iOS zoom), border colour as the
 * focus affordance, and an error that is wired to the input with aria-describedby.
 */

type FieldShellProps = {
  label: string
  htmlFor: string
  hint?: string
  error?: string
  required?: boolean
  className?: string
  children: React.ReactNode
}

function FieldShell({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: FieldShellProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <label htmlFor={htmlFor} className="text-[14px] text-mist">
        {label}
        {required ? <span className="text-paper"> *</span> : null}
      </label>
      {children}
      {error ? (
        <span id={`${htmlFor}-error`} role="alert" className="text-[13px] text-paper">
          ⚠ {error}
        </span>
      ) : hint ? (
        <span id={`${htmlFor}-hint`} className="text-[13px] text-dust">
          {hint}
        </span>
      ) : null}
    </div>
  )
}

const CONTROL =
  "field font-sans disabled:cursor-not-allowed disabled:opacity-60"

type BaseProps = {
  label: string
  hint?: string
  error?: string
  className?: string
  id?: string
}

type InputProps = BaseProps &
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> & { label: string }

export function TextField({ label, hint, error, className, id, ...rest }: InputProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <FieldShell
      label={label}
      htmlFor={fieldId}
      hint={hint}
      error={error}
      required={rest.required}
      className={className}
    >
      <input
        id={fieldId}
        className={CONTROL}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        {...rest}
      />
    </FieldShell>
  )
}

type AreaProps = BaseProps & React.TextareaHTMLAttributes<HTMLTextAreaElement>

export function TextArea({ label, hint, error, className, id, rows = 4, ...rest }: AreaProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <FieldShell
      label={label}
      htmlFor={fieldId}
      hint={hint}
      error={error}
      required={rest.required}
      className={className}
    >
      <textarea
        id={fieldId}
        rows={rows}
        className={cn(CONTROL, "resize-y leading-[1.5]")}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        {...rest}
      />
    </FieldShell>
  )
}

type SelectProps = BaseProps &
  React.SelectHTMLAttributes<HTMLSelectElement> & {
    options: Array<{ value: string; label: string; disabled?: boolean }>
    placeholder?: string
  }

export function SelectField({
  label,
  hint,
  error,
  className,
  id,
  options,
  placeholder,
  ...rest
}: SelectProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <FieldShell
      label={label}
      htmlFor={fieldId}
      hint={hint}
      error={error}
      required={rest.required}
      className={className}
    >
      <select
        id={fieldId}
        className={cn(CONTROL, "appearance-none pr-9")}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238a8a8a' stroke-width='1.5' fill='none'/%3E%3C/svg%3E\")",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 12px center",
        }}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        {...rest}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  )
}

type ToggleProps = {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: string
  disabled?: boolean
  className?: string
}

export function Toggle({ label, checked, onChange, hint, disabled, className }: ToggleProps) {
  const autoId = useId()
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <label
        htmlFor={autoId}
        className={cn(
          "flex min-h-11 cursor-pointer items-center justify-between gap-4",
          disabled && "cursor-not-allowed opacity-60"
        )}
      >
        <span className="text-[14px] text-mist">{label}</span>
        <span className="relative inline-flex shrink-0">
          <input
            id={autoId}
            type="checkbox"
            role="switch"
            className="peer sr-only"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="block h-6 w-11 rounded-full border border-edge bg-lift transition-colors peer-checked:border-paper peer-checked:bg-paper peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-paper" />
          <span className="pointer-events-none absolute top-1 left-1 size-4 rounded-full bg-dust transition-transform peer-checked:translate-x-5 peer-checked:bg-ink" />
        </span>
      </label>
      {hint ? <span className="text-[13px] text-dust">{hint}</span> : null}
    </div>
  )
}

/** Checkbox row for multi-select sets such as key scopes and allowed operations. */
export function CheckRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  const autoId = useId()
  return (
    <label
      htmlFor={autoId}
      className={cn(
        "flex min-h-11 cursor-pointer items-start gap-3 py-1",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      <input
        id={autoId}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[#f2f2f2]"
      />
      <span className="min-w-0">
        <span className="block text-[14px] text-paper">{label}</span>
        {description ? <span className="block text-[13px] text-dust">{description}</span> : null}
      </span>
    </label>
  )
}
