/**
 * A labelled form field with its help text and error, wired for screen readers:
 * the control gets aria-describedby and aria-invalid through the render prop.
 */
export function Field({
  id,
  label,
  help,
  error,
  required,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string[] | string;
  required?: boolean;
  children: (a11y: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => React.ReactNode;
}) {
  const message = Array.isArray(error) ? error[0] : error;
  const describedBy = [help ? `${id}-help` : null, message ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-14 font-medium">
        {label}
        {required ? <span className="text-ink-3"> · required</span> : null}
      </label>
      {help ? (
        <p id={`${id}-help`} className="text-13 text-ink-3">
          {help}
        </p>
      ) : null}
      {children({ id, "aria-describedby": describedBy || undefined, "aria-invalid": message ? true : undefined })}
      {message ? (
        <p id={`${id}-error`} className="text-13 font-medium text-flag">
          {message}
        </p>
      ) : null}
    </div>
  );
}
