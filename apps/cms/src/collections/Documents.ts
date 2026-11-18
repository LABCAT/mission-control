import { APIError, type CollectionBeforeValidateHook, type CollectionConfig } from 'payload'

// mission-control: tenant-scoped PDF/Word uploads (the multi-tenant plugin adds `tenant`).
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Payload sniffs the file bytes, and a legacy .doc is an OLE compound file (`x-cfb`), so it
  // would be rejected as msword without this.
  'application/x-cfb',
]

/**
 * Payload validates the type of the bytes against `upload.mimeTypes` (and the structure of
 * a PDF), but has no per-collection size limit, so the 10 MB cap is checked here.
 */
export const validateDocumentSize: CollectionBeforeValidateHook = ({ data, req }) => {
  if (req.file && req.file.size > DOCUMENT_MAX_BYTES) {
    throw new APIError('Documents can be at most 10 MB.', 400, undefined, true)
  }

  return data
}

export const Documents: CollectionConfig = {
  slug: 'documents',
  admin: { useAsTitle: 'title' },
  fields: [
    { name: 'title', type: 'text', required: true },
    // mission-control: WordPress attachment ID, for the importer.
    { name: 'legacyId', type: 'number', index: true },
  ],
  hooks: { beforeValidate: [validateDocumentSize] },
  upload: { mimeTypes: DOCUMENT_MIME_TYPES },
  versions: false,
}
