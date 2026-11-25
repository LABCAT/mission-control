'use client'

import { useField, useFormFields } from '@payloadcms/ui'

import { insertVariable } from '../email-engine/subject'

type Props = {
  field?: { label?: Record<string, string> | false | string; required?: boolean }
  path: string
  variablesByEvent?: Record<string, { key: string; label: string }[]>
}

/**
 * The email template subject (PJ-50): plain text, with an "Insert variable" picker that adds a
 * `{{key}}` token for the event the template belongs to. Site managers never type braces by
 * hand unless they want to; the server rejects a variable the event does not have.
 */
export const EmailSubjectField = ({ field, path, variablesByEvent = {} }: Props) => {
  const { setValue, value } = useField<string>({ path })
  const event = useFormFields(([fields]) => fields.event?.value as string | undefined)
  const variables = (event && variablesByEvent[event]) || []
  const label = typeof field?.label === 'string' ? field.label : 'Subject'

  return (
    <div className="field-type text">
      <label className="field-label" htmlFor={`field-${path}`}>
        {label}
      </label>
      <input
        id={`field-${path}`}
        onChange={(changed) => setValue(changed.target.value)}
        type="text"
        value={value ?? ''}
      />
      <select
        aria-label="Insert variable"
        disabled={variables.length === 0}
        onChange={(changed) => {
          if (changed.target.value) setValue(insertVariable(value, changed.target.value))
        }}
        value=""
      >
        <option value="">Insert variable…</option>
        {variables.map((variable) => (
          <option key={variable.key} value={variable.key}>
            {variable.label}
          </option>
        ))}
      </select>
    </div>
  )
}
